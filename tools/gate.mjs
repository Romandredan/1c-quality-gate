#!/usr/bin/env node
/**
 * Управление гейтом качества: показать состояние, снять после прогона.
 *
 * Гейт снимается ТОЛЬКО отсюда, а не удалением файла руками, потому что снятие обязано
 * оставить след: чем закончился прогон, какой класс правки, что не проверялось и почему.
 * Иначе гейт вырождается в формальность, которую снимают не глядя.
 *
 * Использование:
 *   node gate.mjs status
 *   node gate.mjs release --evidence <файл>            # снять по результатам прогона
 *   node gate.mjs release --class C0 --reason "<...>"  # снять как не требующий проверки
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './evidence-validator.mjs';
import { resolveProjectRoot } from './project-root.mjs';
import { readConfig, versionSuffix, pluginVersion } from './config.mjs';
import { removeFileSync } from './fs-safe.mjs';
import { stateDirSegments } from './state-dir.mjs';

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
function root() {
  return resolveProjectRoot(process.cwd(), process.env).root;
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
 * Явный --session надёжнее всего: его печатает сообщение блокировки. Без него берём
 * единственную (обычный случай) либо самую свежую. Наугад по нескольким сессиям не
 * работаем: снять чужой гейт значит объявить проверенной чужую работу.
 */
function pickSession(state, explicit) {
  const ids = Object.keys(state.sessions || {});
  if (explicit) return ids.includes(explicit) ? explicit : null;
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];
  return ids.sort((a, b) => String(state.sessions[b].updatedAt || '').localeCompare(String(state.sessions[a].updatedAt || '')))[0];
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
      'Сессий несколько: снимай гейт только своей — укажи --session <id>.\n' +
        'Снятие чужого гейта объявляет проверенной чужую работу.\n'
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
    process.stdout.write('Гейт не взведён — снимать нечего.\n');
    return 0;
  }

  const explicit = typeof args.session === 'string' ? args.session : null;
  const sessionId = pickSession(state, explicit);
  if (!sessionId) {
    process.stderr.write(
      explicit
        ? `Сессия "${explicit}" в состоянии гейта не найдена. Доступны: ${Object.keys(state.sessions).join(', ')}\n`
        : 'Не удалось определить сессию — укажи --session <id>.\n'
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
    process.stdout.write('Гейт не взведён — отмечать нечего.\n');
    return 0;
  }

  const layer = typeof args.layer === 'string' ? args.layer : null;
  const files = args._ || [];
  if (!layer || files.length === 0) {
    process.stderr.write('Использование: node gate.mjs verify --layer <code|arch|xml|hygiene> <файл> [...]\n');
    return 2;
  }

  const sessionId = pickSession(state, typeof args.session === 'string' ? args.session : null);
  if (!sessionId) {
    process.stderr.write('Не удалось определить сессию — укажи --session <id> из сообщения о блокировке.\n');
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
    process.stdout.write('Ни один из указанных файлов не найден в охвате гейта этой сессии.\n');
    return 1;
  }

  writeFileSync(paths().pending, JSON.stringify(state, null, 2), 'utf8');
  process.stdout.write(`Отмечено проверенным на слое ${layer}: ${marked} файл(ов).\n`);
  process.stdout.write('Отметка снимается автоматически при следующей правке файла.\n');
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv.slice(2);
  const args = parseArgs(rest);

  switch (cmd) {
    case 'status':
      return cmdStatus();
    case 'verify':
      return cmdVerify(args);
    case 'release':
      return cmdRelease(args);
    default:
      process.stderr.write(
        'Использование:\n' +
          '  node gate.mjs status\n' +
          '  node gate.mjs verify --layer <code|arch|xml|hygiene> <файл> [...]\n' +
          '  node gate.mjs release --evidence <файл>\n' +
          '  node gate.mjs release --class C0 --reason "<почему>"\n'
      );
      return 2;
  }
}

process.exit(main(process.argv));
