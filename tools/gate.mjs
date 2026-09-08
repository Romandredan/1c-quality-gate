#!/usr/bin/env node
/**
 * Управление гейтом качества: показать состояние, снять после прогона, напечатать план прогона.
 *
 * Гейт снимается ТОЛЬКО отсюда, а не удалением файла руками, потому что снятие обязано
 * оставить след: чем закончился прогон, какой класс правки, что не проверялось и почему.
 * Иначе гейт вырождается в формальность, которую снимают не глядя.
 *
 * Использование:
 *   node gate.mjs status
 *   node gate.mjs plan [--files <f>...] [--json] [--no-analyzer]  # план прогона для модели
 *   node gate.mjs verify --layer <code|arch|xml|hygiene> <файл>
 *   node gate.mjs release --evidence <файл>            # снять по результатам прогона
 *   node gate.mjs release --class C0 --reason "<...>"  # снять как не требующий проверки
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validate } from './evidence-validator.mjs';
import { resolveProjectRoot } from './project-root.mjs';
import { readConfig, resolve as resolveConfigState, versionSuffix, pluginVersion } from './config.mjs';
import { removeFileSync } from './fs-safe.mjs';
import { stateDirSegments } from './state-dir.mjs';
import { computeProfile, ARCHETYPES } from './profile.mjs';
import { SCOPES } from './evidence-scopes.mjs';
import { readCatalog } from './gen-catalog-index.mjs';
import { expectedExamined } from './catalog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const PENDING = 'qg-pending.json';
const DONE = 'qg-done.json';

/**
 * Корень проекта — общий разрешитель.
 *
 * По `process.cwd()` состояние гейта расщеплялось: взводит его хук (у которого корень
 * правильный), а снимает эта утилита из того каталога, где оказалась модель. Из подкаталога
 * `status` отвечал «гейт не взведён», а `release` — «снимать нечего» с кодом 0, не сняв
 * ничего. Обе фразы неотличимы от честной работы.
 */
function rootInfo() {
  return resolveProjectRoot(process.cwd(), process.env);
}

function root() {
  return rootInfo().root;
}

/**
 * Строка «где мы и почему». «Гейт не взведён» из каталога другого репозитория дословно
 * совпадает с честным ответом — различить их можно только по названному корню. Способ
 * опознания resolveProjectRoot возвращает ровно для этого; раньше он здесь выбрасывался.
 */
function rootLine() {
  const { root: r, via, marker } = rootInfo();
  const how =
    via === 'env'
      ? 'задан переменной окружения'
      : via === 'marker'
        ? `опознан по маркеру ${marker}`
        : 'маркер не найден — взят каталог запуска';
  return `Корень проекта: ${String(r).split('\\').join('/')} (${how})\n`;
}

function paths() {
  const dir = join(root(), ...stateDirSegments());
  return { dir, pending: join(dir, PENDING), done: join(dir, DONE) };
}

function readPending() {
  const { pending } = paths();
  if (!existsSync(pending)) return null;
  try {
    const raw = JSON.parse(readFileSync(pending, 'utf8'));
    if (raw?.sessions) return raw;
    // Состояние старого формата (один набор файлов на проект) — поднимаем до сессионного.
    if (raw?.files) return { version: 2, sessions: { legacy: { armedAt: raw.armedAt, files: raw.files } } };
    return { version: 2, sessions: {} };
  } catch {
    return { corrupt: true, sessions: {} };
  }
}

/**
 * Выбирает сессию, с которой работаем.
 *
 * Явный --session надёжнее всего: его печатают подсказка при взводе и сообщение блокировки.
 * Без него берём единственную (обычный случай). При нескольких — НЕ выбираем: прежний выбор
 * «самой свежей» в живой работе означал чужую, потому что параллельная сессия правит позже
 * своей. verify тогда привязывался к чужому охвату и отвечал «файл не найден», а release
 * снимал чужой гейт — объявлял проверенной работу, которую никто не смотрел.
 * Неоднозначность закрывается отказом с перечнем, а не эвристикой.
 */
function pickSession(state, explicit) {
  const ids = Object.keys(state.sessions || {});
  if (explicit) return ids.includes(explicit) ? explicit : null;
  return ids.length === 1 ? ids[0] : null;
}

/** Перечень сессий для отказа: по составу правок модель находит свою. */
function sessionsListing(state) {
  return Object.entries(state.sessions || {})
    .map(([id, s]) => {
      const files = Object.keys(s.files || {});
      const lines = [`  ${id} — файлов: ${files.length}, обновлена ${s.updatedAt || s.armedAt || '?'}`];
      lines.push(...files.slice(0, 5).map((f) => `      ${f}`));
      if (files.length > 5) lines.push(`      … и ещё ${files.length - 5}`);
      return lines.join('\n');
    })
    .join('\n');
}

/** Текст отказа, когда сессия не названа, а их несколько. */
function ambiguousSessionMessage(state) {
  return (
    'Сессий несколько, а --session не указан — утилита не выбирает сама: взять чужую значит\n' +
    'объявить проверенной работу, которую никто не смотрел. Взведены:\n' +
    sessionsListing(state) +
    '\n' +
    'Укажи --session <id>: идентификатор напечатан в подсказке при взводе гейта и в сообщении\n' +
    'о блокировке; свою сессию видно по составу правок.\n'
  );
}

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function cmdStatus() {
  // Версия печатается первой строкой: прогон устаревшей версией из кэша плагинов иначе
  // неотличим от прогона актуальной — вплоть до «таких проверок не существует».
  process.stdout.write(`1c-quality-gate v${pluginVersion() || '?'}\n`);
  process.stdout.write(rootLine());
  const state = readPending();
  if (!state) {
    process.stdout.write('Гейт не взведён: изменений в файлах 1С не зафиксировано.\n');
    return 0;
  }
  if (state.corrupt) {
    process.stdout.write('Гейт взведён, но маркер повреждён и не читается.\n');
    return 1;
  }

  const ids = Object.keys(state.sessions || {});
  if (ids.length === 0) {
    process.stdout.write('Гейт не взведён: изменений в файлах 1С не зафиксировано.\n');
    return 0;
  }

  for (const id of ids) {
    const s = state.sessions[id];
    const files = Object.entries(s.files || {});
    process.stdout.write(`Сессия ${id} — взведена ${s.armedAt}, файлов: ${files.length}\n`);
    for (const [path, meta] of files) {
      process.stdout.write(`  ${String(meta.kind).padEnd(13)} ${path}  (правок: ${meta.edits})\n`);
    }
    process.stdout.write('\n');
  }

  if (ids.length > 1) {
    process.stdout.write(
      'Сессий несколько: verify и release без --session <id> откажут. Свою сессию видно по составу\n' +
        'правок, идентификатор напечатан при взводе. Снятие чужого гейта объявляет проверенной чужую работу.\n'
    );
  }
  process.stdout.write('Снять: node gate.mjs release --evidence <файл отчёта> [--session <id>]\n');
  return 0;
}

/** Самый свежий файл дерева: mtime и путь — путь нужен, чтобы находка называла виновника. */
function newestFile(path) {
  const st = statSync(path);
  if (!st.isDirectory()) return { time: st.mtimeMs, file: path };
  let best = { time: 0, file: null };
  for (const entry of readdirSync(path)) {
    const sub = newestFile(join(path, entry));
    if (sub.time > best.time) best = sub;
  }
  return best;
}

/**
 * Артефакты старше своих исходников — по парам из секции `artifacts` настройки проекта.
 *
 * Сценарий, ради которого проверка существует: дефект исправлен в исходниках в 00:09,
 * пользователь в 00:10 запустил сборку от 00:06 и получил ошибку, которой в исходниках уже
 * нет. Формально гейт чист, практически — потерянный прогон.
 *
 * Только предупреждение: mtime — приближение (checkout и копирование его меняют), а пары
 * называет проект, не плагин. Пустая секция — проверки нет, и это сказано нигде не будет:
 * молчание здесь законно, потому что пар не существует.
 */
function staleArtifacts(rootDir) {
  let pairs;
  try {
    pairs = readConfig(rootDir)?.artifacts?.pairs;
  } catch {
    return [];
  }
  if (!Array.isArray(pairs)) return [];

  const out = [];
  for (const pair of pairs) {
    if (!pair || typeof pair !== 'object') continue;
    if (typeof pair.source !== 'string' || typeof pair.artifact !== 'string') continue;
    const src = join(rootDir, pair.source);
    const art = join(rootDir, pair.artifact);
    // Отсутствующий артефакт — не находка: его ещё не собирали, сравнивать нечего.
    if (!existsSync(src) || !existsSync(art)) continue;
    try {
      const artTime = statSync(art).mtimeMs;
      const newest = newestFile(src);
      if (newest.file && newest.time > artTime) {
        out.push({ artifact: pair.artifact, source: pair.source, newestFile: newest.file });
      }
    } catch {
      /* гонка с удалением файла — проверка свежести не важнее снятия гейта */
    }
  }
  return out;
}

function cmdRelease(args) {
  const state = readPending();
  if (!state || Object.keys(state.sessions || {}).length === 0) {
    process.stdout.write('Гейт не взведён — снимать нечего.\n' + rootLine());
    return 0;
  }

  const explicit = typeof args.session === 'string' ? args.session : null;
  const sessionId = pickSession(state, explicit);
  if (!sessionId) {
    process.stderr.write(
      explicit
        ? `Сессия "${explicit}" в состоянии гейта не найдена. Доступны: ${Object.keys(state.sessions).join(', ')}\n`
        : ambiguousSessionMessage(state)
    );
    return 2;
  }
  const sessionState = state.sessions[sessionId];

  const { dir, pending, done } = paths();
  const evidenceFile = typeof args.evidence === 'string' ? args.evidence : null;
  const cls = typeof args.class === 'string' ? args.class : null;
  const reason = typeof args.reason === 'string' ? args.reason : null;

  let evidenceText = null;
  // Предупреждения валидатора переживают снятие: часть из них — заявления о неполноте
  // (непокрытый файл, несверенное покрытие), а не придирки к оформлению. Выброшенные, они
  // оставляли бы гейт снятым без следа именно там, где след и нужен.
  let warnings = [];

  if (evidenceFile) {
    if (!existsSync(evidenceFile)) {
      process.stderr.write(`Файл следа не найден: ${evidenceFile}\n`);
      return 2;
    }
    evidenceText = readFileSync(evidenceFile, 'utf8');
    // Сессия передаётся явно: годность доказательства меряется правками СВОЕЙ сессии.
    // Иначе правка в соседней обесценивала бы прогон, честно сделанный по своим файлам.
    const { problems, exitCode } = validate(evidenceText, { gate: true, session: sessionId });
    if (exitCode === 2) {
      process.stderr.write('След прогона не прошёл проверку — гейт НЕ снят:\n\n');
      for (const p of problems.filter((x) => x.severity === 'error')) {
        process.stderr.write(`  ОШИБКА ${evidenceFile}:${p.line || '?'} — ${p.message}\n`);
      }
      process.stderr.write('\nИсправь след и повтори снятие.\n');
      return 2;
    }
    warnings = problems.filter((p) => p.severity === 'warn');
  } else if (cls && reason) {
    if (!['C0', 'C1'].includes(cls)) {
      process.stderr.write(
        `Снятие без следа допустимо только для класса C0/C1 (получено: ${cls}).\n` +
          'Для C2/C3 нужен полноценный прогон: --evidence <файл>.\n'
      );
      return 2;
    }
    if (reason.trim().length < 10) {
      process.stderr.write('Причина слишком короткая: напиши, почему проверка не требуется.\n');
      return 2;
    }
    // Заявленный класс сверяется с реальным охватом: иначе сорок изменённых модулей
    // закрываются десятисимвольной причиной, и дешёвый путь превращается в лазейку.
    const scope = Object.entries(sessionState.files || {});
    if (scope.length > 2) {
      process.stderr.write(
        `Заявлен класс ${cls}, но в охвате ${scope.length} файлов — это не точечная правка.\n` +
          'Нужен полноценный прогон: --evidence <файл>.\n'
      );
      return 2;
    }
    const heavilyEdited = scope.filter(([, meta]) => (meta.edits || 0) > 5);
    if (heavilyEdited.length) {
      process.stderr.write(
        `Заявлен класс ${cls}, но файл правился многократно (${heavilyEdited[0][1].edits} раз): ` +
          `${heavilyEdited[0][0]}\nЭто непохоже на косметику — нужен прогон: --evidence <файл>.\n`
      );
      return 2;
    }
  } else {
    process.stderr.write(
      'Нужен либо --evidence <файл>, либо пара --class C0|C1 --reason "<почему проверка не требуется>".\n'
    );
    return 2;
  }

  // Свежесть артефактов проверяется на ЛЮБОМ пути снятия, включая C0/C1 без следа:
  // исправление комментария тоже попадает в сборку, только если она была после правки.
  const stale = staleArtifacts(root());

  mkdirSync(dir, { recursive: true });

  // Снимаем ТОЛЬКО свою сессию: записи остальных остаются взведёнными, за них отвечают
  // их владельцы. Если своя была последней — файл состояния удаляется целиком.
  //
  // Удаление обязано ПОДТВЕРДИТЬСЯ до того, как пользователю сказано «гейт снят»:
  // на Node 24.x/Windows `rmSync` молча не удаляет файлы на путях с не-ASCII символами
  // (кириллическое имя проекта — норма для 1С), и без проверки release рапортовал успех,
  // а Stop-хук продолжал блокировать завершение. Успех, не отличимый от невыполнения, —
  // ровно тот класс отказа, против которого написан весь плагин.
  delete state.sessions[sessionId];
  if (Object.keys(state.sessions).length) {
    writeFileSync(pending, JSON.stringify(state, null, 2), 'utf8');
  } else if (!removeFileSync(pending)) {
    process.stderr.write(
      'Маркер гейта не удалился — гейт НЕ снят:\n' +
        `  ${pending}\n` +
        'Известная причина: fs.rmSync в Node 24.x на Windows молча пропускает пути\n' +
        'с не-ASCII символами (nodejs/node#56049). Обнови Node до версии с исправлением\n' +
        'либо удали файл вручную и повтори снятие.\n'
    );
    return 2;
  }

  let doneState = { version: 2, sessions: {} };
  if (existsSync(done)) {
    try {
      const prev = JSON.parse(readFileSync(done, 'utf8'));
      if (prev?.sessions) doneState = prev;
    } catch {
      /* повреждённый журнал снятий перезаписываем */
    }
  }
  doneState.sessions[sessionId] = {
    releasedAt: new Date().toISOString(),
    armedAt: sessionState.armedAt,
    files: sessionState.files,
    mode: evidenceFile ? 'evidence' : 'declared',
    evidenceFile: evidenceFile || null,
    class: cls || null,
    reason: reason || null,
    warnings: [
      ...warnings.map((w) => ({ line: w.line || null, message: w.message })),
      ...stale.map((s) => ({
        line: null,
        message: `артефакт ${s.artifact} старше исходника ${s.newestFile}: правки не попали в сборку`,
      })),
    ],
  };
  writeFileSync(done, JSON.stringify(doneState, null, 2), 'utf8');

  const count = Object.keys(sessionState.files || {}).length;
  const rest = Object.keys(state.sessions).length;
  if (warnings.length) {
    process.stdout.write(`Гейт снят, но след неполон (${warnings.length}) — это записано в журнал снятий:\n`);
    for (const w of warnings) {
      process.stdout.write(`  ПРЕДУПРЕЖДЕНИЕ ${evidenceFile}:${w.line || '?'} — ${w.message}\n`);
    }
    process.stdout.write('\n');
  }
  if (stale.length) {
    process.stdout.write('Артефакты старше своих исходников — последние правки НЕ попали в сборку:\n');
    for (const s of stale) {
      process.stdout.write(`  ПРЕДУПРЕЖДЕНИЕ ${s.artifact} старше ${s.newestFile} — пересобери перед передачей\n`);
      process.stdout.write(
        `  след: [qg not_verified: dimension=artifact-freshness, reason=artifact_older_than_sources, artifact=${s.artifact}]\n`
      );
    }
    process.stdout.write('\n');
  }
  process.stdout.write(
    (evidenceFile
      ? `Гейт сессии ${sessionId} снят по следу прогона (${evidenceFile}). Файлов в охвате: ${count}.${versionSuffix()}\n`
      : `Гейт сессии ${sessionId} снят как ${cls} без прогона. Причина: ${reason}\nФайлов в охвате: ${count}.${versionSuffix()}\n`) +
      (rest ? `Остаются взведёнными гейты других сессий: ${rest}. Их не трогаем.\n` : '')
  );
  return 0;
}

/**
 * Отмечает файлы проверенными на их текущем содержимом.
 *
 * Гейт — требование к СОСТОЯНИЮ артефакта, а не просьба ещё раз позвать тот же инструмент.
 * Если слой уже отработал по этому содержимому, повторный прогон — трата времени. Отметку
 * снимает хук взвода при любой правке файла, поэтому устаревшее доказательство
 * переиспользовано быть не может.
 */
function cmdVerify(args) {
  const state = readPending();
  if (!state || state.corrupt) {
    process.stdout.write('Гейт не взведён — отмечать нечего.\n' + rootLine());
    return 0;
  }

  const layer = typeof args.layer === 'string' ? args.layer : null;
  const files = args._ || [];
  if (!layer || files.length === 0) {
    process.stderr.write('Использование: node gate.mjs verify --layer <code|arch|xml|hygiene> <файл> [...]\n');
    return 2;
  }

  const explicit = typeof args.session === 'string' ? args.session : null;
  const sessionId = pickSession(state, explicit);
  if (!sessionId) {
    const ids = Object.keys(state.sessions || {});
    process.stderr.write(
      explicit
        ? `Сессия "${explicit}" в состоянии гейта не найдена. Доступны: ${ids.join(', ')}\n`
        : ids.length === 0
          ? 'Гейт не взведён — отмечать нечего.\n'
          : ambiguousSessionMessage(state)
    );
    return 2;
  }

  const session = state.sessions[sessionId];
  const now = new Date().toISOString();
  let marked = 0;

  for (const rel of Object.keys(session.files || {})) {
    if (!files.some((f) => rel.endsWith(String(f).replace(/\\/g, '/')))) continue;
    const entry = session.files[rel];
    entry.verified = entry.verified || {};
    entry.verified[layer] = now;
    marked++;
  }

  if (marked === 0) {
    process.stdout.write(
      `В охвате сессии ${sessionId} нет ни одного из указанных файлов. Её состав:\n` +
        Object.keys(session.files || {})
          .map((f) => `  ${f}`)
          .join('\n') +
        '\n'
    );
    return 1;
  }

  writeFileSync(paths().pending, JSON.stringify(state, null, 2), 'utf8');
  process.stdout.write(`Отмечено проверенным на слое ${layer}: ${marked} файл(ов).\n`);
  process.stdout.write('Отметка снимается автоматически при следующей правке файла.\n');
  return 0;
}

// --- gate.mjs plan -----------------------------------------------------------------------
//
// Печатает весь план прогона одним вызовом: профиль изменения, команды инструментов в
// фиксированном порядке, модельные проходы контура code под сработавшую глубину, справочники
// и разделы чеклиста под архетип, статус контуров arch/xml и то, что обязано закрыться в
// следе. Раньше эти пять фактов модель собирала сама по трём таблицам SKILL.md — здесь их
// вычисляет один и тот же код, что и `evidence-validator.mjs` (`computeProfile`), и разойтись
// они не могут по определению.
//
// Порядок инструментов — не перечисление функций SCOPES (там порядка нет, это словарь), а
// фиксированный порядок исполнения слоя 1: сначала дешёвая гигиена, затем статический
// анализ и сверка с платформой (движки), затем разборы по тексту, затем каталог антипаттернов
// (нужен список изменённых файлов, поэтому идёт последним в контуре code), затем XML.
const TOOL_ORDER = [
  'tools/hygiene-check.mjs',
  'tools/analyzer-run.mjs',
  'tools/platform-context-run.mjs',
  'tools/query-lint.mjs',
  'tools/bsl-lint.mjs',
  'tools/rename-check.mjs',
  'tools/xml/orphan-check.mjs',
  'tools/xml/uuid-unique.mjs',
  'tools/xml/meta-validate.py',
  'tools/xml/form-validate.py',
  'tools/catalog.mjs',
];

/** `<путь-инструмента> → набор расширений, к которым он относится` — из SCOPES/TOOL_BACKED. */
function toolAppliesMap() {
  const map = new Map();
  for (const def of Object.values(SCOPES)) {
    if (!def.tool) continue;
    if (!map.has(def.tool)) map.set(def.tool, new Set());
    for (const ext of def.applies || []) map.get(def.tool).add(ext);
  }
  return map;
}

/** Есть ли среди файлов хотя бы один с расширением, к которому инструмент применим. */
function toolFires(toolPath, files, appliesMap) {
  const set = appliesMap.get(toolPath);
  if (!set || set.size === 0) return false;
  return files.some((f) => {
    const m = String(f).match(/\.[^./\\]+$/);
    return m && set.has(m[0].toLowerCase());
  });
}

/** Подмножество файлов с расширением, к которому инструмент применим. */
function filesFor(toolPath, files, appliesMap) {
  const set = appliesMap.get(toolPath);
  if (!set) return [];
  return files.filter((f) => {
    const m = String(f).match(/\.[^./\\]+$/);
    return m && set.has(m[0].toLowerCase());
  });
}

function quoteAll(files) {
  return files.map((f) => `"${f}"`).join(' ');
}

/**
 * «Каталог выгрузки» для XML-инструментов дерева (orphan-check, uuid-unique): корень
 * основной конфигурации или конкретного расширения. Разрешается по раскладке репозитория
 * (`src/cf`, `src/cfe/<Имя>` — см. CLAUDE.md), а не по маркеру `Configuration.xml` на диске:
 * на свежесозданном проекте (как в тесте) маркера ещё нет, а раскладка уже есть. Путь,
 * которому раскладка не соответствует, помечается плейсхолдером — приближение заявлено,
 * а не выдано за точный разбор.
 */
function xmlTreeRoot(file) {
  const cf = file.match(/^(src\/cf)\//i);
  if (cf) return cf[1];
  const cfe = file.match(/^(src\/cfe\/[^/]+)\//i);
  if (cfe) return cfe[1];
  return '<каталог выгрузки — src/cf или src/cfe/<Имя>>';
}

/**
 * Применимы ли скоупы каталога антипаттернов (`ai-antipatterns`, `platform-antipatterns`) к
 * этому прогону — единственный источник условия для ДВУХ мест: строк `catalog.mjs
 * index/attest` в «Инструменты» (`buildToolCommands`) и записей `ai-antipatterns`/
 * `platform-antipatterns` в «Закрыть в следе» (`mustCloseList`). Читателю нечего проверять без
 * изменённых `.bsl`/`.os` — контур `code`, поднятый чисто XML-архетипом (`rights` по пути
 * `Rights.xml`, без единого модуля), не обязан требовать запись, для которой в плане нет ни
 * команды, ни файла: `catalog.mjs attest` с пустым `--files` отказывает кодом 1, и план не
 * должен предлагать закрыть в следе то, что нечем закрыть.
 */
function catalogScopesApply(resolvedCode, bslFiles) {
  return resolvedCode !== 'skip' && bslFiles.length > 0;
}

/** Строит команды инструментов в порядке `TOOL_ORDER`, каждая — с буквальным `$QG`. */
function buildToolCommands({ files, resolvedCode, archetypeLabels, bslFiles }) {
  const appliesMap = toolAppliesMap();
  const hasXmlChange = files.some((f) => /\.xml$/i.test(f));
  const lines = [];

  for (const tool of TOOL_ORDER) {
    switch (tool) {
      case 'tools/hygiene-check.mjs':
        // Гигиена читает байты любого файла — фильтр по расширению здесь не нужен.
        lines.push(`node "$QG/tools/hygiene-check.mjs" ${quoteAll(files)}`);
        break;
      case 'tools/analyzer-run.mjs':
        if (toolFires(tool, files, appliesMap)) {
          const changed = filesFor(tool, files, appliesMap);
          lines.push(`node "$QG/tools/analyzer-run.mjs" ${changed.map((f) => `--changed "${f}"`).join(' ')}`);
        }
        break;
      case 'tools/platform-context-run.mjs':
        if (toolFires(tool, files, appliesMap)) {
          const changed = filesFor(tool, files, appliesMap);
          lines.push(`node "$QG/tools/platform-context-run.mjs" ${changed.map((f) => `--changed "${f}"`).join(' ')}`);
        }
        break;
      case 'tools/query-lint.mjs':
        if (toolFires(tool, files, appliesMap)) {
          lines.push(`node "$QG/tools/query-lint.mjs" ${quoteAll(filesFor(tool, files, appliesMap))}`);
        }
        break;
      case 'tools/bsl-lint.mjs':
        if (toolFires(tool, files, appliesMap)) {
          lines.push(`node "$QG/tools/bsl-lint.mjs" ${quoteAll(filesFor(tool, files, appliesMap))}`);
        }
        break;
      case 'tools/rename-check.mjs':
        if (toolFires(tool, files, appliesMap)) {
          lines.push(`node "$QG/tools/rename-check.mjs" ${quoteAll(filesFor(tool, files, appliesMap))}`);
        }
        break;
      case 'tools/xml/orphan-check.mjs':
        if (hasXmlChange) {
          const roots = [...new Set(files.filter((f) => /\.xml$/i.test(f)).map(xmlTreeRoot))].sort();
          for (const r of roots) lines.push(`node "$QG/tools/xml/orphan-check.mjs" "${r}"`);
        }
        break;
      case 'tools/xml/uuid-unique.mjs':
        if (hasXmlChange) {
          const roots = [...new Set(files.filter((f) => /\.xml$/i.test(f)).map(xmlTreeRoot))].sort();
          for (const r of roots) lines.push(`node "$QG/tools/xml/uuid-unique.mjs" "${r}"`);
        }
        break;
      case 'tools/xml/meta-validate.py':
        if (hasXmlChange) {
          for (const f of files.filter((f) => /\.xml$/i.test(f))) {
            lines.push(`python "$QG/tools/xml/meta-validate.py" -Path "${f}"`);
          }
        }
        break;
      case 'tools/xml/form-validate.py':
        if (hasXmlChange) {
          // Только реальные Form.xml — form-validate проверяет связность обработчиков формы,
          // а не любую XML.
          for (const f of files.filter((f) => /\/Forms?\/[^/]+\/(Ext\/Form\/)?Form\.xml$/i.test(f))) {
            lines.push(`python "$QG/tools/xml/form-validate.py" -Path "${f}"`);
          }
        }
        break;
      case 'tools/catalog.mjs':
        if (catalogScopesApply(resolvedCode, bslFiles)) {
          const arch = archetypeLabels.length ? archetypeLabels.join(',') : 'none';
          // qg:AI-11 (needs: diff) проверяется по сравнению версий, а не по коду как он есть —
          // сохрани его ДО делегирования читателю: у него нет оболочки, чтобы построить diff
          // самому. Без файла attest не примет карточку в examined (task-22).
          lines.push(`git diff HEAD -- ${quoteAll(bslFiles)} > <файл.diff>  # сначала сравнение версий, потом читатель`);
          lines.push(`node "$QG/tools/catalog.mjs" index --archetypes ${arch}`);
          lines.push(
            `node "$QG/tools/catalog.mjs" attest --result <файл.json> --files ${quoteAll(bslFiles)} --archetypes ${arch} --diff <файл.diff>`
          );
        }
        break;
      default:
        break;
    }
  }
  return lines;
}

/** Справочники и разделы чеклиста сработавших архетипов — по данным `profile.mjs`. */
function refsAndChecklist(archetypeLabels) {
  const lookup = new Map(ARCHETYPES.map((a) => [a.label, a]));
  const refs = [];
  const checklist = new Set();
  for (const label of archetypeLabels) {
    const a = lookup.get(label);
    if (!a) continue; // проектный архетип (archetypes.custom) — своих refs/checklist не несёт
    for (const r of a.refs || []) if (!refs.includes(r)) refs.push(r);
    for (const c of a.checklist || []) checklist.add(c);
  }
  return { refs, checklist: [...checklist].sort((a, b) => a - b) };
}

/**
 * Модельные проходы контура code под фактическую глубину. Порядок и состав повторяют
 * `bsl-code-review/SKILL.md` («Слой 1б», «Слой 2») — план не придумывает новый процесс,
 * он лишь избавляет модель от подбора глубины и списка справочников по трём таблицам.
 */
function codeModelPasses({ resolvedCode, volume, archetypeLabels, bslFiles, refs, checklist }) {
  if (resolvedCode === 'skip') return ['контур code пропущен (класс C0)'];

  const passes = [];
  if (bslFiles.length) {
    const cards = readCatalog();
    const active = expectedExamined(archetypeLabels, cards);
    passes.push(`каталог антипаттернов: субагент antipattern-reader, активных признаков: ${active.length} (см. index выше)`);
  } else {
    passes.push('каталог антипаттернов: не применимо — модулей (.bsl/.os) в составе нет');
  }

  passes.push(
    refs.length || checklist.length
      ? `стандарты под архетип: ${refs.length ? refs.join(', ') : 'нет специфичных'}; ` +
        `чеклист checklist-code.md ${checklist.length ? `разделы ${checklist.join(', ')}` : 'разделы не заданы архетипом'}`
      : 'стандарты под архетип: архетипы не задают ни справочников, ни разделов чеклиста'
  );

  passes.push('api-verification: субагент bsl-verifier');

  if (resolvedCode === 'L2') {
    // Холодный читатель — класс C3 либо затронуты проведение/права; «деньги» и «необратимые
    // операции» формальным признаком не считаются — это остаётся суждением модели.
    const coldReader = volume === 'C3' || archetypeLabels.includes('rights') || archetypeLabels.includes('object-event');
    passes.push(
      `слой 2: advisor(); холодный читатель — ${coldReader ? 'да (проведение/права либо класс C3)' : `нет (класс ${volume})`}` +
        ' — «деньги»/«необратимые операции» решает модель по смыслу правки'
    );
  }
  if (volume === 'C3') {
    passes.push('слой 3 (состязательный аудит): только предложить, запускать по согласию пользователя');
  }
  return passes;
}

function archContourLine(resolved, archetypeLabels, complexityFired) {
  if (resolved.arch !== null) return `уровень ${resolved.arch}`;
  if (archetypeLabels.length === 0 && !complexityFired) {
    return 'skip (архетипы не сработали, сложность не поднята)';
  }
  return 'skip (объём ниже порога, сработавшие архетипы/сложность не задают минимума по arch)';
}

function xmlContourLine(resolvedXml) {
  const map = {
    skip: 'skip (правка косметическая, класс C0)',
    'n/a': 'n/a (XML не менялся)',
    changed: 'changed (проверить изменённые файлы валидаторами структуры)',
    'changed+registration': 'changed+registration (плюс сверка «диск ↔ состав»)',
    full: 'full (объём C3 — полный прогон контура)',
  };
  return map[resolvedXml] || resolvedXml;
}

/** Что обязано закрыться в следе — список идентификаторов и поясняющая строка к каждому. */
function mustCloseList({ archetypeLabels, resolvedCode, bslFiles }) {
  const ids = ['compilation'];
  if (archetypeLabels.includes('query')) ids.push('query-execution');
  if (catalogScopesApply(resolvedCode, bslFiles)) ids.push('ai-antipatterns', 'platform-antipatterns');
  if (resolvedCode === 'L2') ids.push('logic-review');
  return ids;
}

function closeNote(id) {
  switch (id) {
    case 'compilation':
      return 'not_verified reason=no_platform, если платформа не запускалась';
    case 'query-execution':
      return '(архетип query): applied либо not_verified reason=no_platform';
    case 'ai-antipatterns':
    case 'platform-antipatterns':
      return 'печатает catalog.mjs attest: applied либо skipped reason=not_applicable/unreadable';
    case 'logic-review':
      return 'слой 2 (advisor(), холодный читатель при высокой цене ошибки): applied либо skipped reason=...';
    default:
      return '';
  }
}

/** Список файлов прогона: `--files <f>...` либо файлы сессии гейта (как в `verify`). */
function planFileList(args) {
  const flagValue = typeof args.files === 'string' ? args.files : null;
  if (flagValue) {
    return { files: [flagValue, ...(args._ || []).map(String)], sessionId: null, error: null };
  }

  const state = readPending();
  if (!state || state.corrupt || Object.keys(state.sessions || {}).length === 0) {
    return {
      files: [],
      sessionId: null,
      error:
        'Нужен список файлов: --files <f> [<f> ...] либо взведённый гейт с зафиксированной сессией.\n' + rootLine(),
    };
  }
  const explicit = typeof args.session === 'string' ? args.session : null;
  const sessionId = pickSession(state, explicit);
  if (!sessionId) {
    const ids = Object.keys(state.sessions || {});
    return {
      files: [],
      sessionId: null,
      error: explicit
        ? `Сессия "${explicit}" в состоянии гейта не найдена. Доступны: ${ids.join(', ')}\n`
        : ambiguousSessionMessage(state),
    };
  }
  return { files: Object.keys(state.sessions[sessionId].files || {}), sessionId, error: null };
}

/** Метрики сложности для `computeProfile`: реальный прогон анализатора либо явный отказ. */
function analyzerMetrics(rootDir, files, { skip }) {
  if (skip) return { ok: false, metrics: {}, reason: 'запуск отключён флагом --no-analyzer' };

  const script = join(HERE, 'analyzer-run.mjs');
  const r = spawnSync(
    process.execPath,
    [script, '--json', ...files.flatMap((f) => ['--changed', f])],
    { cwd: rootDir, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 }
  );

  if (r.error) return { ok: false, metrics: {}, reason: `не удалось запустить: ${r.error.message}` };
  if (r.signal) return { ok: false, metrics: {}, reason: `прерван по таймауту (120 с, сигнал ${r.signal})` };
  if (typeof r.status !== 'number') return { ok: false, metrics: {}, reason: 'анализатор не вернул код завершения' };
  if (r.status !== 0) {
    return { ok: false, metrics: {}, reason: `анализатор завершился с кодом ${r.status}` };
  }
  try {
    const parsed = JSON.parse(r.stdout);
    return { ok: true, metrics: parsed.metrics || {}, reason: null };
  } catch (e) {
    return { ok: false, metrics: {}, reason: `вывод анализатора не разобран: ${e.message}` };
  }
}

function cmdPlan(args) {
  const jsonMode = args.json === true;
  const noAnalyzer = args['no-analyzer'] === true;
  const write = (s) => {
    if (!jsonMode) process.stdout.write(s);
  };
  const diag = (s) => process.stderr.write(s);

  const { files, sessionId, error } = planFileList(args);
  if (error) {
    process.stderr.write(error);
    return 2;
  }
  if (!files.length) {
    process.stderr.write('Список файлов пуст — план печатать не для чего.\n' + rootLine());
    return 2;
  }

  const rootDir = root();
  write(`1c-quality-gate v${pluginVersion() || '?'}\n`);
  write(rootLine());
  write(sessionId ? `Сессия: ${sessionId} (файлов: ${files.length})\n\n` : `Файлы: ${files.length} (переданы явно через --files)\n\n`);

  const configState = resolveConfigState(rootDir);
  const config = configState.values;

  const { ok: analyzerOk, metrics, reason: analyzerReason } = analyzerMetrics(rootDir, files, { skip: noAnalyzer });
  if (!analyzerOk) diag(`сложность не считалась: ${analyzerReason}\n`);

  let profile;
  try {
    profile = computeProfile({ files, root: rootDir, config, metrics, configState });
  } catch (e) {
    // Неверная запись `archetypes.custom` (extends на неизвестную метку, попытка понизить
    // минимум, name и extends вместе или ни одного) — план печатать не для чего: молча
    // применённая частично неверная настройка хуже отказа.
    process.stderr.write(`Настройка проекта отклонена: ${e.message}\n`);
    return 2;
  }
  const { resolved, archetypes: archetypeLabels, volume, driver } = profile;
  const complexityFired = analyzerOk && profile.complexity.length > 0;
  const complexityDisplay = analyzerOk ? (profile.complexity.length ? profile.complexity.join(',') : 'none') : 'not_computed';

  write('## Профиль\n');
  write(
    `volume=${volume} files=${profile.files} loc=+${profile.loc.added}/-${profile.loc.removed} ` +
      `archetypes=[${archetypeLabels.length ? archetypeLabels.join(',') : 'none'}] complexity=[${complexityDisplay}] driver=${driver}\n`
  );
  // Причина, по которой объём НЕ C1 (>1 метода / новый метод / изменённая сигнатура / порог
  // строк либо файлов) — без неё «C2» видно, а почему C2 — нет, и первое же «почему так
  // глубоко на трёх строках?» превращается в спор без записи, на которую можно сослаться.
  if (profile.volumeReason) write(`объём: ${volume} (${profile.volumeReason})\n`);
  if (!analyzerOk) write(`сложность не считалась: ${analyzerReason}\n`);
  write(`resolved: code=${resolved.code} arch=${resolved.arch === null ? 'skip' : resolved.arch} xml=${resolved.xml} hygiene=${resolved.hygiene}\n`);
  write(`${profile.scopeLine}\n\n`);

  const bslFiles = files.filter((f) => /\.(bsl|os)$/i.test(f));
  const tools = buildToolCommands({ files, resolvedCode: resolved.code, archetypeLabels, bslFiles });
  write('## Инструменты (в этом порядке)\n');
  for (const t of tools) write(`${t}\n`);
  write('\n');

  const { refs, checklist } = refsAndChecklist(archetypeLabels);
  const passes = codeModelPasses({ resolvedCode: resolved.code, volume, archetypeLabels, bslFiles, refs, checklist });
  write(`## Модельные проходы контура code (${resolved.code})\n`);
  for (const p of passes) write(`- ${p}\n`);
  write('\n');

  const archLine = archContourLine(resolved, archetypeLabels, complexityFired);
  const xmlLine = xmlContourLine(resolved.xml);
  write(`## Контур arch: ${archLine}\n`);
  write(`## Контур xml: ${xmlLine}\n\n`);

  const mustClose = mustCloseList({ archetypeLabels, resolvedCode: resolved.code, bslFiles });
  write('## Закрыть в следе\n');
  for (const id of mustClose) write(`- ${id}: ${closeNote(id)}\n`);

  if (jsonMode) {
    const payload = {
      profile,
      scopeLine: profile.scopeLine,
      tools,
      references: refs,
      checklist,
      modelPasses: { depth: resolved.code, passes },
      contours: { arch: archLine, xml: xmlLine },
      mustClose,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }

  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv.slice(2);
  const args = parseArgs(rest);

  switch (cmd) {
    case 'status':
      return cmdStatus();
    case 'plan':
      return cmdPlan(args);
    case 'verify':
      return cmdVerify(args);
    case 'release':
      return cmdRelease(args);
    default:
      process.stderr.write(
        'Использование:\n' +
          '  node gate.mjs status\n' +
          '  node gate.mjs plan [--files <f> ...] [--json] [--no-analyzer]\n' +
          '  node gate.mjs verify --layer <code|arch|xml|hygiene> <файл> [...]\n' +
          '  node gate.mjs release --evidence <файл>\n' +
          '  node gate.mjs release --class C0 --reason "<почему>"\n'
      );
      return 2;
  }
}

process.exit(main(process.argv));
