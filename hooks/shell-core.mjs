/**
 * Взвод гейта по правкам из оболочки — ядро, общее для хука Claude Code (hooks/gate-shell.mjs)
 * и плагина OpenCode.
 *
 * Зачем. Взвод после инструмента правки берёт файл из аргументов вызова, а у команды оболочки
 * его нет. Модуль, записанный генератором, `Set-Content` или `git apply`, и XML, изменённый
 * скриптом навыка правки метаданных, гейт не видел вовсе, и Stop-хук отпускал сессию без
 * проверки (issue #39; хук и замок состояния предложены автором issue, здесь — с доработками).
 *
 * Как.
 *   до команды — время старта и для каждого затронутого git-дерева: HEAD и изменённые
 *     отслеживаемые файлы (`git status -uno`);
 *   после команды — кандидаты:
 *     - изменённые и новые неотслеживаемые файлы по `git status`;
 *     - файлы, изменённые до команды и ставшие чистыми (возврат к HEAD, stash);
 *     - файлы коммитов, СОЗДАННЫХ во время команды (правка и коммит одной командой);
 *     - вне git — обход каталога с потолком.
 *   Взводится кандидат, у которого mtime или ctime не раньше старта (ctime ловит mtime,
 *   восстановленный задним числом), — тем же armGate, что и после правки инструментом.
 *   Относится ли файл к 1С, решает classifyFile; здесь список расширений только сужает поиск.
 *
 * Чего намеренно не видно — ложный взвод дороже пропуска:
 *   - игнорируемые файлы. Выгрузка конфигурации во временный каталог — десятки тысяч модулей,
 *     которых никто не писал: на рабочем проекте 12 тыс. модулей и `git status` 3,7 с вместо
 *     0,5 с. В репозиторий игнорируемое не попадает;
 *   - коммиты, существовавшие до команды. Переход на ветку, pull и reset переписывают модули,
 *     но это чужой или уже проверенный код;
 *   - каталог состояния гейта.
 *
 * Чья правка. Время изменения говорит, что файл записан, пока шла команда, но не говорит кем.
 *   - Файл, чьё текущее содержимое записал инструмент правки другой сессии, не взводится: у той
 *     сессии есть запись с тем же отпечатком (размер и время изменения), и это свидетельство
 *     точное. Живой случай: параллельная сессия записала модуль во время 30-секундной сборки.
 *   - Всё остальное взводится с источником shell: такой файл могли записать команда другой
 *     сессии или процесс вне сессий (пользователь, выгрузка из конфигуратора), и различить их
 *     по времени нельзя. Выход — отказ от файла с причиной, `gate.mjs disown`; молчаливый пропуск
 *     оставил бы без проверки и то, что команда записала сама.
 *
 * Границы:
 *   - файл вне затронутых каталогов (путь вычислен внутри скрипта и лежит в чужом дереве) не виден;
 *   - вложенный репозиторий или submodule внутри найденного git-дерева не просматривается;
 *   - правка процесса вне сессий в том же окне времени взводится у этой сессии — снимается отказом;
 *   - rebase и cherry-pick создают коммиты во время команды — их файлы взводятся; разрешение
 *     конфликта в коммите слияния не видно: коммиты слияния пропускаются;
 *   - касание файла без изменения содержимого взводит гейт — ошибка в громкую сторону;
 *   - «не смог посмотреть» (git не ответил, обход упёрся в потолок) — сообщение, а не тишина.
 *
 * Сверки содержимого с прошлым снимком нет намеренно: снимок отражает прошлое наблюдение, а не
 * проверенную версию файла (правка A → проверка → оболочка вернула прежнее содержимое — снимок
 * сказал бы «не менялся»).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  armGate,
  classifyFile,
  fileStamp,
  sameStamp,
  pathKey,
  foreignToolClaims,
  toProjectRelative,
  FILE_EXTENSIONS,
  PENDING,
} from './gate-core.mjs';
import { stateDirSegments } from '../tools/state-dir.mjs';

const SLACK_MS = 2000; // грубая точность времени на части файловых систем (FAT — 2 с)
const WALK_MAX_ENTRIES = 20000; // потолок обхода вне git
const WALK_MAX_MS = 1500;
const POST_BUDGET_MS = 40000; // таймаут хука — 60 с; найденное взводится по мере нахождения
const PRE_BUDGET_MS = 6000; // до команды: дольше — отметка без данных git, после скажем «не смог»
const GIT_TIMEOUT_MS = 15000;
const MAX_FRESH_COMMITS = 200;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git hash-object -t tree /dev/null
const START_TTL_MS = 24 * 3600 * 1000;
const PATHSPEC = FILE_EXTENSIONS.map((e) => `:(icase)*.${e}`);
const RE_CANDIDATE = new RegExp(`\\.(${FILE_EXTENSIONS.join('|')})$`, 'i');
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const WIN = process.platform === 'win32';

/**
 * Отметки старта — во временном каталоге системы, а не в проекте: хук срабатывает на каждую
 * команду в любом проекте, где включён плагин, и каталог состояния в не-1С проекте был бы мусором.
 */
function scratchDir() {
  return join(tmpdir(), 'qg-shell');
}

const keyOf = (p) => (WIN ? resolve(p).toLowerCase() : resolve(p));

/** Ключ вызова: идентификатор харнесса, иначе хеш сессии и текста команды. */
export function callKey({ id, sessionId, command }) {
  if (id) return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
  const raw = `${sessionId || ''}\n${command || ''}`;
  return 'h' + createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Ближайший существующий каталог для пути; корень диска не берём — это не «место правки». */
function nearestDir(p) {
  let d = resolve(p);
  for (let i = 0; i < 64; i++) {
    try {
      const s = statSync(d);
      const dir = s.isDirectory() ? d : dirname(d);
      return dirname(dir) === dir ? null : dir;
    } catch {
      /* пути ещё нет — поднимаемся */
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** Корень git-дерева (`.git` каталогом или файлом у рабочего дерева) либо null. */
function gitTop(dir) {
  let d = dir;
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Пути из текста команды: в кавычках (с пробелами), голые абсолютные, `/c/…`, относительные. */
export function pathsInCommand(command, cwd) {
  const out = [];
  const s = String(command || '');
  for (const m of s.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const q = m[1] ?? m[2];
    if (/^[A-Za-z]:[\\/]/.test(q) || /^\\\\/.test(q)) out.push(q);
    else if (WIN && /^\/[A-Za-z]\//.test(q)) out.push(`${q[1]}:/${q.slice(3)}`);
    else if (!WIN && q.startsWith('/')) out.push(q);
    else if (/^\.\.?[\\/]/.test(q) && cwd) out.push(resolve(cwd, q));
  }
  for (const m of s.matchAll(/(?:^|[\s=(>])((?:[A-Za-z]:[\\/]|\\\\)[^"'`\s|;&<>(){}]*)/g)) out.push(m[1]);
  if (WIN) for (const m of s.matchAll(/(?:^|[\s=(>])\/([A-Za-z])\/([^"'`\s|;&<>(){}]*)/g)) out.push(`${m[1]}:/${m[2]}`);
  else for (const m of s.matchAll(/(?:^|[\s=(>])(\/[^"'`\s|;&<>(){}]+)/g)) out.push(m[1]);
  if (cwd) for (const m of s.matchAll(/(?:^|[\s=(>])(\.\.?[\\/][^"'`\s|;&<>(){}]*)/g)) out.push(resolve(cwd, m[1]));
  return out;
}

/** Каталоги, которых касается команда: рабочий каталог, корень проекта, пути из текста. */
function candidateDirs({ cwd, root, command }) {
  const out = new Map();
  const add = (p) => {
    if (!p || typeof p !== 'string') return;
    const d = nearestDir(p);
    if (d) out.set(keyOf(d), d);
  };
  add(cwd);
  add(root);
  for (const p of pathsInCommand(command, cwd)) add(p);
  return [...out.values()];
}

/** Git-деревья и прочие каталоги среди затронутых. */
function splitDirs(dirs) {
  const tops = new Map();
  const plain = [];
  for (const d of dirs) {
    const top = gitTop(d);
    if (top) tops.set(keyOf(top), top);
    else plain.push(d);
  }
  return { tops: [...tops.values()], plain };
}

/**
 * Вызов git. `--no-optional-locks`: хук не должен брать `index.lock` — иначе `git commit`
 * в параллельном вызове модели упадёт с «index.lock exists».
 */
function git(top, args, timeout = GIT_TIMEOUT_MS) {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', top, '-c', 'core.quotepath=off', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.max(1000, timeout),
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** Разбор `git status --porcelain=v1 -z`: у переименования или копии второй путь — исходный. */
export function parseStatusZ(raw, top) {
  const parts = raw.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    files.push(join(top, e.slice(3)));
    if (/[RC]/.test(e.slice(0, 2))) i++;
  }
  return files;
}

/** Изменённые (untracked=false) либо изменённые и новые неигнорируемые файлы дерева. */
function statusFiles(top, untracked, timeout) {
  const args = ['status', '--porcelain=v1', '-z', untracked ? '--untracked-files=all' : '--untracked-files=no'];
  const raw = git(top, [...args, '--', ...PATHSPEC], timeout);
  return raw === null ? null : parseStatusZ(raw, top);
}

function headOf(top, timeout) {
  const raw = git(top, ['rev-parse', '--verify', '-q', 'HEAD'], timeout);
  return raw ? raw.trim() : null;
}

/**
 * Файлы коммитов, созданных во время команды. Коммиты, существовавшие раньше (переход на
 * ветку, pull, reset), не берутся: модули они переписывают, но пишет их не эта сессия.
 * Возвращает null, если git не ответил.
 */
function freshCommitFiles(top, oldHead, newHead, start) {
  const range = oldHead === EMPTY_TREE ? [newHead] : [`${oldHead}..${newHead}`];
  const raw = git(top, ['log', '--no-merges', `--max-count=${MAX_FRESH_COMMITS}`, '--format=%H %ct', ...range]);
  if (raw === null) return null;
  const since = (start - SLACK_MS) / 1000;
  const shas = raw
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter(([sha, ct]) => sha && Number(ct) >= since)
    .map(([sha]) => sha);
  if (!shas.length) return [];
  const names = git(top, ['log', '--no-walk=unsorted', '--format=', '--name-only', '-z', ...shas, '--', ...PATHSPEC]);
  if (names === null) return null;
  return names
    .split('\0')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => join(top, p));
}

/** Обход вне git с потолком; full=false — упёрлись в потолок или не смогли прочитать каталог. */
function walkCandidates(dir) {
  const files = [];
  const t0 = Date.now();
  let entries = 0;
  let full = true;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let list;
    try {
      list = readdirSync(d, { withFileTypes: true });
    } catch {
      full = false;
      continue;
    }
    for (const e of list) {
      if (++entries > WALK_MAX_ENTRIES || Date.now() - t0 > WALK_MAX_MS) return { files, full: false };
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(join(d, e.name));
      } else if (RE_CANDIDATE.test(e.name)) {
        files.push(join(d, e.name));
      }
    }
  }
  return { files, full };
}

function changedSince(path, start) {
  try {
    const s = statSync(path);
    if (!s.isFile()) return false;
    return Math.max(s.mtimeMs, s.ctimeMs) >= start - SLACK_MS;
  } catch {
    return false;
  }
}

function inside(parent, child) {
  const r = relative(parent, child);
  return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r));
}

/**
 * Проект похож на 1С: есть настройка гейта или состояние. «Не смог посмотреть» говорится только
 * здесь или когда обход сам нашёл файлы 1С — в чужих проектах плагин молчит.
 */
function looksLike1C(root, env) {
  return existsSync(join(root, '.1c-quality-gate.json')) || existsSync(join(root, ...stateDirSegments(env), PENDING));
}

/** До команды: отметка старта и снимок затронутых git-деревьев. */
export function shellBefore({ root, cwd, command, key }) {
  const dir = scratchDir();
  mkdirSync(dir, { recursive: true });
  const start = Date.now();
  const path = join(dir, `start-${key}.json`);
  // Отметка старта — первой: снимок, прерванный по таймауту, не должен лишить «после» главного.
  writeFileSync(path, JSON.stringify({ start, tops: {} }), 'utf8');
  const tops = {};
  for (const top of splitDirs(candidateDirs({ cwd, root, command })).tops) {
    const left = PRE_BUDGET_MS - (Date.now() - start);
    if (left <= 0) break; // дерево без записи — после команды скажем «не смог»
    const dirty = statusFiles(top, false, left);
    // status прочитан, а HEAD нет — репозиторий без коммитов: база сравнения — пустое дерево
    const head = dirty === null ? null : headOf(top, PRE_BUDGET_MS - (Date.now() - start)) || EMPTY_TREE;
    tops[keyOf(top)] = { head, dirty };
  }
  writeFileSync(path, JSON.stringify({ start, tops }), 'utf8');
}

/**
 * После команды: найти и взвести изменённые файлы 1С.
 * Возвращает { armed: [результаты armGate], blind: [что не удалось посмотреть — впервые за сессию],
 * foreign: [{ rel, owner } — изменённые в окне команды файлы, записанные другой сессией],
 * relevant: проект похож на 1С — только тогда адаптеру уместно говорить о гейте }.
 */
export function shellAfter({ root, cwd, command, key, sessionId, ensureConfig = null, readConfig = null, env = process.env }) {
  const t0 = Date.now();
  const dir = scratchDir();
  const startPath = join(dir, `start-${key}.json`);
  const rec = readJson(startPath, null);
  try {
    unlinkSync(startPath);
  } catch {
    /* отметки могло не быть */
  }
  const blind = [];
  const armed = [];
  const foreign = [];
  let speak = looksLike1C(root, env);
  const done = () => ({ armed, foreign, blind: speak ? onlyNew(dir, sessionId, blind) : [], relevant: speak });

  if (!rec?.start) {
    blind.push('нет отметки старта команды (хук до команды не отработал)');
    return done();
  }
  const start = rec.start;
  const stateDir = join(root, ...stateDirSegments(env));
  const seen = new Set();
  // Записи других сессий читаются один раз, при первом кандидате: команда без правок их не
  // читает вовсе. Правка, записанная после чтения, попадёт сюда по времени — её вернёт
  // владельцу его собственный взвод (armGate, разбор гонки хуков).
  let claims = null;
  const ownerOf = (rel, path) => {
    claims = claims || foreignToolClaims({ root, sessionId, env });
    const theirs = claims.get(pathKey(rel));
    if (!theirs) return null;
    const stamp = fileStamp(path);
    return theirs.find((c) => sameStamp(c.stamp, stamp))?.owner || null;
  };
  // Взвод — сразу по мере нахождения: хук, прерванный по таймауту, не должен унести найденное.
  let outOfTime = false;
  const armAll = (list) => {
    for (const f of list) {
      if (outOfTime || Date.now() - t0 > POST_BUDGET_MS) {
        if (!outOfTime) blind.push(`взвод не закончен: бюджет ${POST_BUDGET_MS / 1000} с исчерпан`);
        outOfTime = true;
        return;
      }
      const k = keyOf(f);
      if (seen.has(k)) continue;
      seen.add(k);
      if (inside(stateDir, f) || !changedSince(f, start)) continue;
      const path = resolve(f);
      const rel = toProjectRelative(root, path);
      const owner = ownerOf(rel, path);
      if (owner) {
        foreign.push({ rel, owner });
        continue;
      }
      const r = armGate({ root, filePath: path, sessionId, source: 'shell', ensureConfig, readConfig, env });
      if (r) armed.push(r);
    }
  };
  const overBudget = (what) => {
    if (Date.now() - t0 < POST_BUDGET_MS) return false;
    blind.push(`${what} — не успел: бюджет ${POST_BUDGET_MS / 1000} с исчерпан`);
    return true;
  };

  const { tops, plain } = splitDirs(candidateDirs({ cwd, root, command }));
  for (const top of tops) {
    if (overBudget(top)) break;
    const now = statusFiles(top, true);
    if (now === null) {
      const w = walkCandidates(top);
      if (!w.full) blind.push(`${top} — git не ответил, обход неполон`);
      armAll(w.files);
      continue;
    }
    armAll(now);
    const was = rec.tops?.[keyOf(top)];
    if (!was || was.dirty === null) {
      blind.push(`${top} — до команды git не прочитан: возврат к HEAD и коммит внутри команды не видны`);
      continue;
    }
    armAll(was.dirty); // были изменены до команды и стали чистыми: возврат к HEAD или stash
    const head = headOf(top);
    if (was.head && head && was.head !== head) {
      const fresh = freshCommitFiles(top, was.head, head, start);
      if (fresh === null) blind.push(`${top} — HEAD сдвинулся, но коммиты не прочитаны`);
      else armAll(fresh);
    }
  }
  for (const d of plain) {
    if (overBudget(d)) break;
    const w = walkCandidates(d);
    if (!w.full) {
      if (w.files.some((f) => classifyFile(f))) speak = true;
      blind.push(`${d} — обход неполон (потолок ${WALK_MAX_ENTRIES} записей / ${WALK_MAX_MS} мс или ошибка чтения)`);
    }
    armAll(w.files);
  }
  if (armed.length) speak = true;
  cleanupStale(dir);
  return done();
}

/** «Не смог посмотреть» по одному и тому же месту — раз за сессию, иначе шум на каждой команде. */
function onlyNew(dir, sessionId, blind) {
  if (!blind.length) return blind;
  const p = join(dir, `blind-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  const was = readJson(p, []);
  const fresh = blind.filter((b) => !was.includes(b));
  if (fresh.length) {
    try {
      writeFileSync(p, JSON.stringify([...was, ...fresh]), 'utf8');
    } catch {
      /* память о сказанном — удобство, не условие */
    }
  }
  return fresh;
}

/** Отметки старта без пары (команду отклонили) и память сессий старше суток. */
function cleanupStale(dir) {
  try {
    const now = Date.now();
    for (const n of readdirSync(dir)) {
      if (!n.startsWith('start-') && !n.startsWith('blind-')) continue;
      const p = join(dir, n);
      if (now - statSync(p).mtimeMs > START_TTL_MS) unlinkSync(p);
    }
  } catch {
    /* уборка не обязательна */
  }
}
