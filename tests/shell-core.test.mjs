#!/usr/bin/env node
/**
 * Тесты взвода гейта по правкам из оболочки (hooks/shell-core.mjs, hooks/gate-shell.mjs)
 * и замка состояния (tools/state-lock.mjs).
 *
 * Каждый случай — отдельный временный git-репозиторий: «команда» — это действие между
 * shellBefore и shellAfter. Подготовка всех репозиториев идёт до одной общей паузы длиннее
 * допуска по времени (2 с): иначе файлы подготовки попадали бы в окно команды и взводились
 * ложно. Изменить ctime задним числом нельзя, поэтому пауза, а не подмена времени.
 *
 * Запуск: node tests/shell-core.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { shellBefore, shellAfter, callKey, parseStatusZ, pathsInCommand } from '../hooks/shell-core.mjs';
import { classifyFile, armGate, FILE_EXTENSIONS, PENDING } from '../hooks/gate-core.mjs';
import { STATE_LOCK } from '../tools/state-lock.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV = {}; // каталог состояния по умолчанию, без переменных окружения теста
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !['CLAUDE_PROJECT_DIR', 'QG_PROJECT_DIR', 'OPENCODE_PROJECT_DIR', 'QG_STATE_DIR'].includes(k))
);

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`ok — ${name}`); }
  else { failed++; console.error(`FAIL — ${name}${detail ? ` (${detail})` : ''}`); }
}

const WORK = mkdtempSync(join(tmpdir(), 'qg-shell-test-'));
const MODULE = 'src/cf/CommonModules/Общий/Ext/Module.bsl';
const CATALOG = 'src/cf/Catalogs/Товары.xml';

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function put(dir, rel, text) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, 'utf8');
  return p;
}

/** Репозиторий с модулем и объектом метаданных в первом коммите. */
function repo(name, { ignore = '' } = {}) {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  put(dir, MODULE, 'Процедура А() Экспорт\nКонецПроцедуры\n');
  put(dir, CATALOG, '<MetaDataObject/>\n');
  put(dir, 'README.md', '# тест\n');
  if (ignore) put(dir, '.gitignore', ignore);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'начало');
  return dir;
}

function pendingOf(dir) {
  const p = join(dir, '.claude', '.state', PENDING);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function armedFiles(dir, session = 's') {
  return Object.keys(pendingOf(dir)?.sessions?.[session]?.files || {});
}

let seq = 0;
/** Одна «команда»: снимок до, действие, взвод после. */
function command(dir, action, { text = '', cwd = dir, session = 's' } = {}) {
  const key = callKey({ id: `t${++seq}`, sessionId: session, command: text });
  shellBefore({ root: dir, cwd, command: text, key });
  action();
  return shellAfter({ root: dir, cwd, command: text, key, sessionId: session, env: ENV });
}

// --- Разбор без файловой системы ---
{
  const raw = ' M a.bsl\0R  new.bsl\0old.bsl\0?? d/x.xml\0';
  const files = parseStatusZ(raw, '/r').map((f) => f.replace(/\\/g, '/'));
  check('parseStatusZ: переименование даёт новый путь, исходный пропущен', files.join('|') === '/r/a.bsl|/r/new.bsl|/r/d/x.xml');
  const paths = pathsInCommand('python gen.py "C:/Проекты/My Repo/src" --out ./build', 'C:/w').map((p) => p.replace(/\\/g, '/'));
  check('pathsInCommand: путь в кавычках с пробелом', paths.includes('C:/Проекты/My Repo/src'));
  check('pathsInCommand: относительный путь от рабочего каталога', paths.some((p) => p.endsWith('/w/build')));
  check('callKey: идентификатор вызова очищен', callKey({ id: 'toolu_01:ab/c' }) === 'toolu_01_ab_c');
  check('callKey: без идентификатора — хеш', /^h[0-9a-f]{16}$/.test(callKey({ sessionId: 's', command: 'ls' })));
}

// --- Расширения поиска и classifyFile не расходятся ---
{
  const onDisk = join(WORK, 'dumproot');
  put(onDisk, 'Configuration.xml', '<Configuration/>\n');
  const oneC = [
    'x/Module.bsl', 'x/script.os', 'cf/Catalogs/A.xml', 'src/Catalogs/A/A.mdo', 'src/Catalogs/A/Forms/F/Form.form',
    join(onDisk, 'Catalogs', 'A.xml'),
  ];
  const exts = new Set(oneC.map((p) => p.split('.').pop().toLowerCase()));
  check('каждое расширение, которое classifyFile признаёт, есть в FILE_EXTENSIONS', [...exts].every((e) => FILE_EXTENSIONS.includes(e)));
  check('classifyFile признаёт все образцы', oneC.every((p) => classifyFile(p)));
  check('чужие расширения classifyFile не признаёт', ['a.txt', 'cf/a.json', 'src/a.mxl', 'a.epf'].every((p) => !classifyFile(p)));
}

// --- Подготовка случаев (до общей паузы) ---
const R = {
  write: repo('write'),
  untracked: repo('untracked'),
  read: repo('read'),
  revert: repo('revert'),
  checkout: repo('checkout'),
  commitIn: repo('commit-in'),
  commitOld: repo('commit-old'),
  ignored: repo('ignored', { ignore: '.tmp/\n' }),
  xml: repo('xml'),
  state: repo('state'),
  mtime: repo('mtime'),
  failure: repo('failure'),
  flow: repo('flow'),
  other: repo('other'),
  outer: repo('outer'),
};
put(R.revert, MODULE, 'Процедура А() Экспорт\n  // правка до команды\nКонецПроцедуры\n');
git(R.checkout, 'checkout', '-q', '-b', 'feature');
put(R.checkout, MODULE, 'Процедура Б() Экспорт\nКонецПроцедуры\n');
git(R.checkout, 'commit', '-qam', 'чужая ветка');
git(R.checkout, 'checkout', '-q', 'main');
put(R.commitOld, MODULE, 'Процедура А() Экспорт\n  // готово к коммиту\nКонецПроцедуры\n');
const plain = join(WORK, 'plain');
put(plain, MODULE, 'Процедура А()\nКонецПроцедуры\n');
put(plain, '.1c-quality-gate.json', '{}\n');
const noGit1C = join(WORK, 'nogit-other');
mkdirSync(noGit1C, { recursive: true });
// Гейт собственного потока: модуль уже взведён и изменён, как после правки инструментом.
put(R.flow, MODULE, 'Процедура А() Экспорт\n  // правка сессии\nКонецПроцедуры\n');
armGate({ root: R.flow, filePath: join(R.flow, MODULE), sessionId: 's', env: ENV });

await new Promise((r) => setTimeout(r, 2300));

// --- Случаи ---
{
  command(R.write, () => appendFileSync(join(R.write, MODULE), '// из оболочки\n'));
  check('запись модуля из оболочки взводит гейт', armedFiles(R.write).includes(MODULE));
}
{
  command(R.untracked, () => put(R.untracked, 'src/cf/CommonModules/Новый/Ext/Module.bsl', 'Процедура Н()\nКонецПроцедуры\n'));
  check('новый неотслеживаемый модуль взводит гейт', armedFiles(R.untracked).includes('src/cf/CommonModules/Новый/Ext/Module.bsl'));
}
{
  const r = command(R.read, () => {
    readFileSync(join(R.read, MODULE), 'utf8');
    git(R.read, 'log', '--oneline');
  });
  check('только чтение не взводит гейт', !pendingOf(R.read) && r.armed.length === 0);
}
{
  command(R.revert, () => git(R.revert, 'checkout', '--', MODULE));
  check('возврат изменённого модуля к HEAD взводит гейт', armedFiles(R.revert).includes(MODULE));
}
{
  command(R.checkout, () => git(R.checkout, 'checkout', '-q', 'feature'));
  check('переход на ветку с чужими коммитами не взводит гейт', !pendingOf(R.checkout));
}
{
  command(R.commitIn, () => {
    appendFileSync(join(R.commitIn, MODULE), '// правка и коммит одной командой\n');
    git(R.commitIn, 'commit', '-qam', 'правка');
  });
  check('правка и коммит одной командой взводят гейт', armedFiles(R.commitIn).includes(MODULE));
}
{
  command(R.commitOld, () => git(R.commitOld, 'commit', '-qam', 'готовое'));
  check('коммит правки, сделанной до команды, не взводит гейт', !pendingOf(R.commitOld));
}
{
  command(R.ignored, () => {
    put(R.ignored, '.tmp/dump/Configuration.xml', '<Configuration/>\n');
    put(R.ignored, '.tmp/dump/CommonModules/А/Ext/Module.bsl', 'Процедура А()\nКонецПроцедуры\n');
  });
  check('выгрузка в игнорируемый каталог не взводит гейт', !pendingOf(R.ignored));
}
{
  command(R.xml, () => writeFileSync(join(R.xml, CATALOG), '<MetaDataObject><Changed/></MetaDataObject>\n', 'utf8'));
  const files = pendingOf(R.xml)?.sessions?.s?.files || {};
  check('XML метаданных из оболочки взводит гейт как metadata-xml', files[CATALOG]?.kind === 'metadata-xml');
}
{
  command(R.state, () => put(R.state, '.claude/.state/qg-reports/scratch.bsl', 'Процедура Ч()\nКонецПроцедуры\n'));
  check('файл в каталоге состояния гейта не взводит', !armedFiles(R.state).length);
}
{
  command(R.mtime, () => {
    const p = join(R.mtime, MODULE);
    appendFileSync(p, '// правка\n');
    const past = new Date(Date.now() - 3600 * 1000);
    utimesSync(p, past, past);
  });
  check('mtime, восстановленный задним числом, ловится по ctime', armedFiles(R.mtime).includes(MODULE));
}
{
  command(plain, () => appendFileSync(join(plain, MODULE), '// вне git\n'));
  check('вне git модуль находится обходом каталога', armedFiles(plain).includes(MODULE));
}
{
  // Путь в тексте команды ведёт в другое дерево — его файл взводится под абсолютным ключом.
  const target = join(R.outer, MODULE);
  command(R.other, () => appendFileSync(target, '// соседнее дерево\n'), { text: `node gen.js "${target}"` });
  const files = armedFiles(R.other);
  check('правка в дереве, названном в команде, взводит гейт', files.some((f) => f.endsWith('Общий/Ext/Module.bsl') && f !== MODULE));
}
{
  // Без отметки старта: в проекте 1С — сообщение, в чужом — тишина. Память «уже сказано»
  // живёт во временном каталоге системы между прогонами, поэтому сессии уникальны на прогон.
  const q = `q-${process.pid}-${Date.now()}`;
  const r1C = shellAfter({ root: plain, cwd: plain, command: '', key: 'none-1', sessionId: `${q}-1`, env: ENV });
  const rOther = shellAfter({ root: noGit1C, cwd: noGit1C, command: '', key: 'none-2', sessionId: `${q}-2`, env: ENV });
  check('нет отметки старта в проекте 1С — «не смог посмотреть»', r1C.blind.length === 1);
  check('нет отметки старта в чужом проекте — тишина', rOther.blind.length === 0);
  const again = shellAfter({ root: plain, cwd: plain, command: '', key: 'none-3', sessionId: `${q}-1`, env: ENV });
  check('одно и то же «не смог посмотреть» — раз за сессию', again.blind.length === 0);
}

// --- Хук целиком: команда упала после записи (PostToolUseFailure) ---
{
  const hook = join(ROOT, 'hooks', 'gate-shell.mjs');
  const payload = (event) =>
    JSON.stringify({
      session_id: 'hook-s',
      tool_use_id: 'toolu_fail_1',
      cwd: R.failure,
      hook_event_name: event,
      tool_name: 'PowerShell',
      tool_input: { command: 'python gen.py; exit 1' },
    });
  const run = (arg, event) =>
    spawnSync(process.execPath, [hook, arg], { input: payload(event), encoding: 'utf8', env: CLEAN_ENV, cwd: R.failure });
  run('pre', 'PreToolUse');
  appendFileSync(join(R.failure, MODULE), '// записано до сбоя\n');
  const post = run('post', 'PostToolUseFailure');
  let out = null;
  try {
    out = JSON.parse(post.stdout.trim());
  } catch {
    /* проверки ниже покажут */
  }
  check('хук: сбой команды после записи взводит гейт', armedFiles(R.failure, 'hook-s').includes(MODULE), post.stdout + post.stderr);
  check('хук: событие в ответе — PostToolUseFailure', out?.hookSpecificOutput?.hookEventName === 'PostToolUseFailure');
  check('хук: модель получает подсказку о взводе', /изменено командой оболочки/.test(out?.hookSpecificOutput?.additionalContext || ''));
  check('хук: код возврата 0', post.status === 0);
}

// --- Собственный поток гейта через оболочку не взводит гейт заново ---
{
  const gate = join(ROOT, 'tools', 'gate.mjs');
  const viaShell = (args) =>
    command(R.flow, () => spawnSync(process.execPath, [gate, ...args], { cwd: R.flow, encoding: 'utf8', env: CLEAN_ENV }), {
      text: `node gate.mjs ${args.join(' ')}`,
    });
  viaShell(['verify', '--layer', 'code', MODULE]);
  const entry = pendingOf(R.flow)?.sessions?.s?.files?.[MODULE];
  check('verify через оболочку: отметка проверенного не снята', !!entry?.verified?.code);
  check('verify через оболочку: счётчик правок не вырос', entry?.edits === 1);
  command(R.flow, () =>
    spawnSync(process.execPath, [join(ROOT, 'tools', 'hygiene-check.mjs'), MODULE], { cwd: R.flow, encoding: 'utf8', env: CLEAN_ENV })
  );
  check('проверка гигиены через оболочку не взводит заново', pendingOf(R.flow)?.sessions?.s?.files?.[MODULE]?.edits === 1);
  const rel = spawnSync(process.execPath, [gate, 'release', '--class', 'C0', '--reason', 'проверка собственного потока гейта'], {
    cwd: R.flow,
    encoding: 'utf8',
    env: CLEAN_ENV,
  });
  check('release снимает гейт', rel.status === 0, rel.stdout + rel.stderr);
  viaShell(['status']);
  check('после release команда оболочки гейт не взводит', !pendingOf(R.flow));
}

// --- Замок состояния: параллельные взводы не теряют записи ---
{
  const dir = join(WORK, 'lock');
  mkdirSync(dir, { recursive: true });
  const N = 8;
  const coreUrl = pathToFileURL(join(ROOT, 'hooks', 'gate-core.mjs')).href;
  const script = (i) =>
    `import(${JSON.stringify(coreUrl)}).then(({ armGate }) => armGate({ root: ${JSON.stringify(dir)}, ` +
    `filePath: ${JSON.stringify(join(dir, `M${i}`, 'Module.bsl'))}, sessionId: 'p${i % 2}', env: {} }))`;
  await Promise.all(
    Array.from({ length: N }, (_, i) => new Promise((res) => spawn(process.execPath, ['-e', script(i)], { stdio: 'ignore' }).on('exit', res)))
  );
  const st = pendingOf(dir);
  const all = [...Object.keys(st?.sessions?.p0?.files || {}), ...Object.keys(st?.sessions?.p1?.files || {})];
  check(`замок: ${N} параллельных взводов — все записи на месте`, all.length === N, `найдено ${all.length}`);
  check('замок: после работы файл замка снят', !existsSync(join(dir, '.claude', '.state', STATE_LOCK)));

  // Брошенный замок (владелец упал) снимается, взвод не ждёт срока ожидания.
  const lock = join(dir, '.claude', '.state', STATE_LOCK);
  writeFileSync(lock, 'dead-owner', 'utf8');
  const old = new Date(Date.now() - 60000);
  utimesSync(lock, old, old);
  const t0 = Date.now();
  armGate({ root: dir, filePath: join(dir, 'Late', 'Module.bsl'), sessionId: 'p0', env: ENV });
  check('замок: брошенный замок снят без ожидания', Date.now() - t0 < 2000 && !existsSync(lock));
  check('замок: взвод после брошенного замка записан', armedFiles(dir, 'p0').includes('Late/Module.bsl'));
}

rmSync(WORK, { recursive: true, force: true });
console.log(`\n${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
