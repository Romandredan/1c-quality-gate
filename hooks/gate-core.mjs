/**
 * Ядро механики гейта: классификация файлов, взвод, чтение состояния, тексты сообщений.
 *
 * Единый источник для четырёх потребителей:
 *   - hooks/gate-arm.mjs   — PostToolUse-хук Claude Code;
 *   - hooks/gate-check.mjs — Stop-хук Claude Code;
 *   - hooks/shell-core.mjs — взвод по правкам из оболочки (хук gate-shell.mjs и плагин OpenCode);
 *   - opencode/plugin/quality-gate.js — плагин OpenCode (tool.execute.after + session.idle).
 *
 * Вынесено сюда, чтобы три копии classifyFile и записи состояния не разъезжались при
 * первой же правке — ровно тот дефект, который плагин ищет в чужом коде.
 *
 * Тексты зависят от харнесса (параметр mode): 'claude' — исходные формулировки,
 * 'opencode' — честные для мягкого гейта: OpenCode не даёт запретить завершение сессии,
 * поэтому обещать «завершение заблокировано» нельзя.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { stateDirSegments } from '../tools/state-dir.mjs';
import { removeFileSync } from '../tools/fs-safe.mjs';
import { matchesAny } from '../tools/path-match.mjs';
import { withStateLock } from '../tools/state-lock.mjs';
import { MAX_PASSES, passCount } from '../tools/gate-cycle.mjs';

export const PENDING = 'qg-pending.json';
export const DONE = 'qg-done.json';

/**
 * Расширения, которые classifyFile может признать файлом 1С. Нужны тем, кто ищет кандидатов
 * сам, а не получает путь от инструмента правки (hooks/shell-core.mjs): список лишь сужает
 * поиск, решение «файл 1С или нет» остаётся за classifyFile. Новое расширение в classifyFile
 * без записи здесь — правки таких файлов из оболочки гейт не увидит; сверяется тестом.
 */
export const FILE_EXTENSIONS = ['bsl', 'os', 'xml', 'mdo', 'form'];

/**
 * Типовые каталоги объектов метаданных в выгрузках 1С (нижний регистр).
 * Один список на все проверки ниже: раздвоенный, он разойдётся при первом же
 * добавлении нового вида объектов.
 */
const METADATA_DIRS =
  'catalogs|documents|informationregisters|accumulationregisters|commonmodules|dataprocessors|reports|enums|chartsofcharacteristictypes|businessprocesses|tasks|exchangeplans|roles|subsystems';

const RE_META_UNDER_SRC_NESTED = new RegExp(`(^|/)src/.*/(${METADATA_DIRS})/`);
const RE_META_UNDER_SRC_DIRECT = new RegExp(`(^|/)src/(${METADATA_DIRS})/`);
const RE_META_DIR_SEGMENT = new RegExp(`(^|/)(${METADATA_DIRS})/`);

/**
 * Определяет, файл какого рода затронут.
 * Возвращает null для всего, что не относится к 1С, — в не-1С проектах плагин молчит.
 */
export function classifyFile(filePath) {
  const p = String(filePath).replace(/\\/g, '/');
  const lower = p.toLowerCase();

  if (lower.endsWith('.bsl') || lower.endsWith('.os')) return 'bsl';

  // Формат EDT: метаданные — .mdo, формы — .form. Правка руками мимо модели EDT ломает
  // проект так же, как правка XML выгрузки, поэтому класс тот же — metadata-xml.
  // .mdo достаточно однозначен сам по себе; .form встречается и вне 1С, поэтому
  // принимается только внутри src/ — EDT другой раскладки не создаёт.
  if (lower.endsWith('.mdo')) return 'metadata-xml';
  if (lower.endsWith('.form') && /(^|\/)src\//.test(lower)) return 'metadata-xml';

  if (lower.endsWith('.xml')) {
    // Configuration.xml — корень выгрузки конфигурации, однозначный маркер 1С.
    if (/(^|\/)configuration\.xml$/.test(lower)) return 'metadata-xml';

    // Каталоги выгрузки: cf (конфигурация) и cfe (расширения), в корне либо внутри src.
    // Одного «src/» НЕДОСТАТОЧНО — это стандартный каталог исходников в Java, .NET,
    // Android и почти везде; плагин обязан молчать в чужих проектах, а не взводить
    // гейт на каждый их XML.
    if (/(^|\/)(cf|cfe)\//.test(lower)) return 'metadata-xml';

    // Выгрузка внутри src: и src/<Имя>/Catalogs/… (несколько конфигураций в репозитории),
    // и src/Catalogs/… — раскладка EDT-проекта и репозиториев с одной конфигурацией.
    // Типовой каталог объектов сразу за src/ в чужих экосистемах не встречается,
    // поэтому здесь дополнительное подтверждение не требуется.
    if (RE_META_UNDER_SRC_NESTED.test(lower) || RE_META_UNDER_SRC_DIRECT.test(lower)) {
      return 'metadata-xml';
    }

    // Выгрузка конфигуратора БЕЗ src: DumpConfigToFiles пишет Catalogs/, Documents/ и
    // Configuration.xml прямо в целевой каталог. Одного имени типового каталога мало
    // (мало ли у кого есть documents/) — поэтому требуется подтверждение на диске:
    // рядом с типовым каталогом обязан лежать Configuration.xml. Проверка по факту,
    // а не по строке пути, — иначе гейт взводился бы в чужих проектах.
    const m = RE_META_DIR_SEGMENT.exec(lower);
    if (m) {
      const idx = lower.indexOf(m[2] + '/', m.index);
      const dumpRoot = p.slice(0, idx);
      try {
        if (existsSync(join(dumpRoot, 'Configuration.xml'))) return 'metadata-xml';
      } catch {
        /* недоступный диск не повод для гейта */
      }
    }

    return null;
  }

  return null;
}

/**
 * Путь относительно корня проекта — для читаемых сообщений.
 * Если файл вне корня (или пути несопоставимы), возвращает исходный:
 * полный путь честнее, чем неверный относительный.
 */
export function toProjectRelative(root, filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  try {
    if (!isAbsolute(filePath)) return normalized;
    const rel = relative(root, filePath);
    if (!rel) return normalized;
    if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) return normalized;
    return rel.replace(/\\/g, '/');
  } catch {
    return normalized;
  }
}

/** Читает состояние взведённых гейтов; null — маркера нет, { corrupt: true } — не читается. */
export function readPendingState(root, env = process.env) {
  const pendingPath = join(root, ...stateDirSegments(env), PENDING);
  if (!existsSync(pendingPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(pendingPath, 'utf8'));
    if (raw?.sessions) return raw;
    // Состояние старого формата (один набор файлов на проект) — поднимаем до сессионного.
    if (raw?.files) return { version: 2, sessions: { legacy: { armedAt: raw.armedAt, files: raw.files } } };
    return { version: 2, sessions: {} };
  } catch {
    return { corrupt: true, sessions: {} };
  }
}

/**
 * Отпечаток файла в момент взвода: размер и время изменения. Нужен, чтобы отличить «это
 * содержимое записала другая сессия» от «файл изменился, пока шла моя команда»: взвод по
 * правкам из оболочки знает только время, а инструмент правки — файл и сессию точно.
 * Совпадение отпечатка означает одну и ту же запись файла; хеш содержимого для этого не
 * нужен, а на дереве после выгрузки стоил бы чтения тысяч файлов на каждую команду.
 */
export function fileStamp(path) {
  try {
    const s = statSync(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

export function sameStamp(a, b) {
  return Boolean(a && b) && a.size === b.size && Math.round(a.mtimeMs) === Math.round(b.mtimeMs);
}

/**
 * Ключ сравнения путей состояния. Инструмент правки отдаёт путь так, как его набрала модель, а
 * `git status` — так, как он записан на диске; в Windows это один и тот же файл.
 */
export function pathKey(rel) {
  const p = String(rel).replace(/\\/g, '/');
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function readSessions(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))?.sessions || {};
  } catch {
    return {};
  }
}

/**
 * Записи других сессий, сделанные инструментом правки: путь → [{ owner, stamp }].
 * Берутся и взведённые сессии, и журнал снятий: владелец мог снять гейт раньше, чем
 * закончилась чужая команда, в окно которой попала его правка.
 *
 * Записи с источником shell сюда не входят намеренно. Две команды разных сессий с
 * пересекающимися окнами видят одно и то же изменение, и время не говорит, чья команда писала:
 * отдать файл первой закончившейся значило бы угадать. Такой файл взводится у обеих, выход —
 * явный отказ с причиной (`gate.mjs disown`).
 */
export function foreignToolClaims({ root, sessionId, env = process.env }) {
  const stateDir = join(root, ...stateDirSegments(env));
  const claims = new Map();
  for (const name of [PENDING, DONE]) {
    const path = join(stateDir, name);
    if (!existsSync(path)) continue;
    for (const [owner, session] of Object.entries(readSessions(path))) {
      if (owner === sessionId) continue;
      for (const [rel, entry] of Object.entries(session?.files || {})) {
        if (entry?.source !== 'tool' || !entry.stamp) continue;
        const key = pathKey(rel);
        if (!claims.has(key)) claims.set(key, []);
        claims.get(key).push({ owner, stamp: entry.stamp });
      }
    }
  }
  return claims;
}

/**
 * Убирает сессию, оставшуюся без файлов. Отказы от файлов (`disowned`) уходят в журнал снятий:
 * пропуск проверки обязан оставлять след и тогда, когда сессии в состоянии больше нет.
 * Вызывается под замком состояния.
 */
export function retireEmptySession({ state, sessionId, donePath, now = new Date().toISOString() }) {
  const session = state?.sessions?.[sessionId];
  if (!session || Object.keys(session.files || {}).length) return false;
  delete state.sessions[sessionId];
  if (!session.disowned?.length) return true;
  let done = { version: 2, sessions: {} };
  if (existsSync(donePath)) {
    try {
      const prev = JSON.parse(readFileSync(donePath, 'utf8'));
      if (prev?.sessions) done = prev;
    } catch {
      /* повреждённый журнал снятий перезаписываем */
    }
  }
  done.sessions[sessionId] = {
    releasedAt: now,
    armedAt: session.armedAt,
    files: {},
    mode: 'disowned',
    evidenceFile: null,
    class: null,
    reason: null,
    disowned: session.disowned,
  };
  writeFileSync(donePath, JSON.stringify(done, null, 2), 'utf8');
  return true;
}

/**
 * Итог снятого гейта для пользователя — один раз. Основной канал — завершающее сообщение
 * сессии по тексту передачи; это страховка на случай, когда модель списки сократила.
 * Возвращает строку и ставит `relayedAt`; нечего сказать или уже сказано — null.
 */
export function residualNote({ root, sessionId, env = process.env }) {
  const stateDir = join(root, ...stateDirSegments(env));
  const donePath = join(stateDir, DONE);
  if (!existsSync(donePath)) return null;
  return withStateLock(stateDir, () => {
    let done;
    try {
      done = JSON.parse(readFileSync(donePath, 'utf8'));
    } catch {
      return null;
    }
    const rec = done?.sessions?.[sessionId];
    if (!rec?.residual || rec.relayedAt) return null;
    const r = rec.residual;
    const count = (list) => ['🔴', '🟠', '🟡'].map((s) => `${s} ${(list || []).filter((f) => f.sev === s).length}`).join(', ');
    rec.relayedAt = new Date().toISOString();
    writeFileSync(donePath, JSON.stringify(done, null, 2), 'utf8');
    return (
      `Гейт сессии снят. Остаток в правке: ${count(r.inChange)}; вне правки ${(r.outside || []).length}; ` +
      `нужно решение ${(r.needsDecision || []).length}. Отчёт: ${rec.evidenceArchive || rec.evidenceFile || '—'}`
    );
  });
}

/**
 * Пути автотестов из настройки. Любая ошибка — пустой список: хук качества не имеет права
 * ломать работу, а неверную настройку показывает `gate.mjs plan` отказом.
 */
function testPathsOf(readConfig, root) {
  if (!readConfig) return [];
  try {
    const paths = readConfig(root)?.tests?.paths;
    return Array.isArray(paths) ? paths : [];
  } catch {
    return [];
  }
}

/**
 * Снимает с сессии файл, взведённый до того, как его путь попал в `tests.paths`.
 * Опустевшая сессия удаляется: Stop-хук не должен держать работу из-за пустого набора.
 */
function unarm({ pendingPath, donePath, sessionId, rel }) {
  if (!existsSync(pendingPath)) return;
  try {
    const state = JSON.parse(readFileSync(pendingPath, 'utf8'));
    const session = state?.sessions?.[sessionId];
    if (!session?.files?.[rel]) return;
    delete session.files[rel];
    retireEmptySession({ state, sessionId, donePath });
    writeFileSync(pendingPath, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* повреждённое состояние перепишет следующий взвод рабочего файла */
  }
}

/**
 * Взводит гейт для файла в сессии. Возвращает { kind, rel, created } либо null,
 * если файл не относится к 1С или лежит по пути автотестов из `tests.paths`.
 *
 * Гейт взводится ВСЕГДА, когда затронут файл 1С вне путей автотестов, — здесь видна одна правка, и оценить её
 * масштаб нельзя. Градация работает не здесь, а на снятии: прогон класса C0/C1 занимает
 * секунды и снимает маркер так же законно, как полный.
 *
 * ensureConfig — функция из tools/config.mjs, передаётся снаружи, чтобы ядро не тянуло
 * конфигурацию в окружениях, где она недоступна. readConfig — оттуда же, по той же причине:
 * из неё берутся пути автотестов `tests.paths`, правки по которым гейт не взводит.
 *
 * source — откуда известно о правке. 'tool': инструмент правки назвал файл и сессию сам,
 * свидетельство точное. 'shell': файл изменился, пока шла команда оболочки, — кто его записал,
 * хук не видит. Точное свидетельство не понижается: файл, который сессия хоть раз правила
 * инструментом, остаётся её файлом, и отказаться от него (`gate.mjs disown`) нельзя.
 */
export function armGate({
  root,
  filePath,
  sessionId,
  source = 'tool',
  ensureConfig = null,
  readConfig = null,
  env = process.env,
}) {
  const kind = classifyFile(filePath);
  if (!kind) return null;

  const stateDir = join(root, ...stateDirSegments(env));
  const pendingPath = join(stateDir, PENDING);
  const donePath = join(stateDir, DONE);
  const rel = toProjectRelative(root, filePath);

  // Пути автотестов (`tests.paths`) гейт не взводит вовсе. Решение принимается здесь, в
  // единственной точке взвода: всё, что дальше, работает от списка файлов сессии.
  if (matchesAny(rel, testPathsOf(readConfig, root))) {
    // Снятие тоже пишет состояние — под тем же замком, иначе затирает параллельный взвод.
    if (existsSync(stateDir)) withStateLock(stateDir, () => unarm({ pendingPath, donePath, sessionId, rel }));
    return null;
  }

  mkdirSync(stateDir, { recursive: true });
  const stamp = fileStamp(isAbsolute(filePath) ? filePath : resolve(root, filePath));
  const reclaimed = [];

  // Чтение-изменение-запись состояния — под замком: параллельные хуки взвода иначе теряют
  // записи друг друга (побеждает последний пишущий). Подробности — tools/state-lock.mjs.
  const outside = withStateLock(stateDir, () => {
    // Состояние разделено по сессиям. Один маркер на проект ломается при параллельной
    // работе: сессия, правившая свои файлы, упирается в гейт, взведённый чужой сессией,
    // и либо снимает чужой маркер, либо не может завершиться. Каждая сессия отвечает
    // только за свои правки.
    let state = { version: 2, sessions: {} };
    if (existsSync(pendingPath)) {
      try {
        const prev = JSON.parse(readFileSync(pendingPath, 'utf8'));
        if (prev?.sessions) state = prev;
        else if (prev?.files) state.sessions['legacy'] = { armedAt: prev.armedAt, files: prev.files };
      } catch {
        /* повреждённый маркер перезаписываем свежим */
      }
    }

    const now = new Date().toISOString();
    const session = state.sessions[sessionId] || { armedAt: now, files: {} };
    const known = session.files[rel];
    const entry = known || { kind, edits: 0 };
    entry.kind = kind;
    entry.edits += 1;
    entry.lastEdit = now;
    // Запись без источника сделана версией плагина, которая его не вела, — считается точной:
    // объявить её оценочной значило бы разрешить отказ от файла, который сессия правила сама.
    entry.source = source === 'shell' && (!known || known.source === 'shell') ? 'shell' : 'tool';
    if (stamp) entry.stamp = stamp;
    else delete entry.stamp;

    // Правка обесценивает все доказательства по этому файлу. Гейт — требование к ТЕКУЩЕМУ
    // состоянию артефакта, а не отметка «инструмент когда-то запускался»: проверки, сделанные
    // до правки, относятся к другому содержимому и переиспользованы быть не могут.
    delete entry.verified;

    session.files[rel] = entry;
    session.updatedAt = now;
    state.sessions[sessionId] = session;

    // Гонка хуков: команда другой сессии закончилась между записью файла и этим взводом и
    // получила файл по времени. Отпечаток её записи совпадает с тем, что записал инструмент
    // этой сессии, — значит, она видела именно эту правку, и файл возвращается владельцу.
    // Разные отпечатки означают, что та команда меняла файл сама: запись остаётся у обеих.
    if (source === 'tool' && stamp) {
      for (const [id, other] of Object.entries(state.sessions)) {
        if (id === sessionId) continue;
        const theirKey = Object.keys(other?.files || {}).find((k) => pathKey(k) === pathKey(rel));
        const theirs = theirKey ? other.files[theirKey] : null;
        if (theirs?.source !== 'shell' || !sameStamp(theirs.stamp, stamp)) continue;
        delete other.files[theirKey];
        reclaimed.push(id);
        retireEmptySession({ state, sessionId: id, donePath, now });
      }
    }

    writeFileSync(pendingPath, JSON.stringify(state, null, 2), 'utf8');

    // Новая правка обесценивает прошлый прогон ЭТОЙ сессии; чужие отметки не трогаем.
    if (existsSync(donePath)) {
      try {
        const done = JSON.parse(readFileSync(donePath, 'utf8'));
        if (done?.sessions) {
          // Отказы от файлов переживают запись о снятии: это след пропуска, а не прогона.
          const kept = done.sessions[sessionId]?.disowned;
          if (kept?.length) {
            session.disowned = [...kept, ...(session.disowned || [])];
            writeFileSync(pendingPath, JSON.stringify(state, null, 2), 'utf8');
          }
          delete done.sessions[sessionId];
          if (Object.keys(done.sessions).length) writeFileSync(donePath, JSON.stringify(done, null, 2), 'utf8');
          else removeFileSync(donePath);
        } else {
          removeFileSync(donePath);
        }
      } catch {
        removeFileSync(donePath);
      }
    }

    // Файл вне корня хранится под абсолютным ключом (см. toProjectRelative). Взвод обязан
    // сказать об этом наружу: часть контуров по чужому файлу не работает, и узнать это
    // модель должна сейчас, а не при отклонении следа в конце прогона.
    return isAbsolute(rel);
  });

  // Настройка проекта создаётся здесь и только здесь: это единственное место, где уже
  // известно, что проект на 1С. Заводить её при старте сессии значило бы сорить файлом в
  // чужих проектах, а оставлять на пользователя — прятать настройку в документацию.
  let created = null;
  if (ensureConfig) {
    try {
      const r = ensureConfig(root);
      if (r?.created) created = toProjectRelative(root, r.path);
    } catch {
      /* создание настройки не обязано мешать взводу гейта */
    }
  }

  return { kind, rel, created, outside, reclaimed };
}

/**
 * Выход для файла, взведённого по времени изменения: отказ с причиной.
 * Один текст для подсказки при взводе из оболочки и для сообщения блокировки.
 */
export function disownLines({ sessionId, packageRoot }) {
  const gate = join(packageRoot, 'tools', 'gate.mjs').replace(/\\/g, '/');
  return [
    'Хук видит, что файл изменился, пока шла команда, но не видит, кто его записал. Файл, который',
    'записала не твоя команда (другая сессия, пользователь, выгрузка из конфигуратора), не проверяй —',
    'сними его с сессии, назвав, кто записал; причина остаётся в журнале снятий:',
    `  node "${gate}" disown --session ${sessionId} --reason "<кто записал>" <файл или каталог> [...]`,
    'Файл, который записала твоя команда, остаётся в проверке.',
  ];
}

/** Сколько проходов цикла уже сделано у сессии — для номера следующего в текстах. */
export function passesOf({ root, sessionId, env = process.env }) {
  try {
    return passCount(readPendingState(root, env)?.sessions?.[sessionId] || {});
  } catch {
    return 0;
  }
}

/** Имя плагина из манифеста: с ним Claude Code называет типы субагентов (`<плагин>:<агент>`). */
function pluginName(packageRoot) {
  try {
    return JSON.parse(readFileSync(join(packageRoot, '.claude-plugin', 'plugin.json'), 'utf8')).name || '1c-quality-gate';
  } catch {
    return '1c-quality-gate';
  }
}

/** Тип субагента-исполнителя так, как его называет харнесс. */
export function runnerType({ packageRoot, mode = 'claude' }) {
  return mode === 'claude' ? `${pluginName(packageRoot)}:gate-runner` : 'gate-runner';
}

/**
 * Передача проверки субагенту — один текст для сообщения блокировки и для команды `/gate`.
 *
 * Зачем. Замер живых прогонов: гейт — это десятки ходов основной модели, и каждый заново
 * оплачивает контекст длинной сессии; сам навык оркестратора при этом тоже грузится в неё.
 * Субагент делает ту же работу в свежем контексте. Цена переноса — он не видит сессии ни
 * строчкой, поэтому всё, что ему нужно знать о работе, основная модель обязана написать сама.
 * Перечень закрытый и нумерованный: пропущенный пункт субагент назовёт по номеру, а вольный
 * пересказ скатывается в «сделал хорошо». Служебные значения подставляет хук — модель их не
 * ищет и не может перепутать сессию.
 */
export function handoffLines({ sessionId, packageRoot, mode = 'claude', passes = 0 }) {
  const qg = String(packageRoot).split(sep).join('/');
  const tool = mode === 'claude' ? 'Agent' : 'task';
  const fallback =
    mode === 'claude' ? 'прогони Skill: quality-gate сам' : 'вызови skill `quality-gate` сам: skill({ name: "quality-gate" })';
  return [
    'Проверку исполняет субагент. НЕ прогоняй гейт сам и не загружай навык quality-gate: это',
    'десятки ходов в контексте этой сессии, и каждый оплачивает её целиком.',
    '',
    `Запусти инструментом ${tool} субагента \`${runnerType({ packageRoot, mode })}\` одним вызовом${
      mode === 'claude' ? ', синхронно (run_in_background: false): фоновый запуск заканчивает ход раньше отчёта' : ''
    }. Он не видит этой`,
    'сессии ни строчкой — всё, что ему нужно знать, напиши в задании подробно и полно.',
    '',
    'Служебное — перенеси дословно:',
    `  Сессия гейта: ${sessionId}`,
    `  Каталог плагина: ${qg}`,
    '',
    'Описание работы — напиши сам, по каждому пункту; нечего сказать — так и напиши «нет»:',
    '  1. Задача — что просил пользователь: дословно, с уточнениями и отменёнными вариантами.',
    '  2. Что изменено и почему именно так — по каждому файлу: решение и отвергнутые альтернативы.',
    '  3. Инварианты — что нельзя было сломать: проведение, права, обмены, вызывающие, данные.',
    '  4. Что сознательно не сделано и что осталось за рамками.',
    '  5. Что проверено вживую — сборки, запуски, данные из базы, с результатом; и что НЕ проверялось.',
    '  6. Сомнения — места, в которых ты не уверен. Пустым пункт не бывает: назови хотя бы слабейшее место.',
    '  7. Пути к спецификации, плану, задаче — если есть.',
    ...(passes > 0
      ? ['  8. По каждой находке прошлого отчёта: исправлена — как именно; не исправлена — почему. Субагент проверит причину по коду.']
      : []),
    'Не оценивай свою работу («код чистый», «проблем нет»): вердикт выносит субагент.',
    '',
    `Эта проверка станет проходом ${passes + 1} из ${MAX_PASSES} в цикле. Находки вне правки (раздел отчёта «Вне правки») не исправляй:`,
    'гейт проверяет правку, а не модуль; они уходят пользователю как техдолг.',
    '',
    'Он вернёт вердикт, находки и путь к отчёту. Находки 🔴/🟠 покажи пользователю в любом случае.',
    'Дальше — по вердикту:',
    '  - открыты находки в правке, с которыми ты согласен, — исправь их и повтори проверку тем же способом;',
    '    несогласие запиши в пункте 8 с причиной. Проходов на цикл не больше трёх.',
    '  - в правке остались только находки, которые ты обоснованно не исправляешь, или достигнут потолок —',
    '    сними гейт по отчёту:',
    `      node "${qg}/tools/gate.mjs" release --session ${sessionId} --evidence <путь к отчёту>`,
    '  - есть 🔴 — гейт так не снимется. Либо исправь находку: правка взведёт гейт заново, и проверка',
    '    повторится тем же способом. Либо, если исправлять сейчас нельзя, — решение принимает',
    '    пользователь, а не ты: покажи ему находку и сними гейт с его решением:',
    `      node "${qg}/tools/gate.mjs" release --session ${sessionId} --evidence <путь к отчёту> --critical-decision "<кто решил и что>"`,
    '    Пользователя рядом нет — не выдумывай его согласие: запиши в решении, что он недоступен, почему',
    '    находка не исправлена и где она показана. Решение сохраняется в журнале снятий.',
    '',
    `Субагент недоступен — тогда и только тогда ${fallback}.`,
    '',
    'Заканчивай работу сообщением пользователю с тремя списками: исправлено за цикл; остаток в правке с твоей',
    'оценкой; вне правки и раздел «Нужно решение» — то, что требует его решения. Остаток печатает release,',
    'не сокращай его.',
  ];
}

/**
 * Подсказка о взводе гейта. mode: 'claude' — исходные формулировки (жёсткий Stop-хук),
 * 'opencode' — честные для мягкого гейта («плагин будет возвращать к работе»).
 *
 * Идентификатор сессии печатается здесь, потому что больше модели его взять неоткуда до
 * первого блока Stop-хука: в оболочке его нет, `gate.mjs status` перечисляет все сессии,
 * не зная, которая своя. А при нескольких сессиях verify и release без `--session`
 * отказывают — выбрать чужую наугад хуже, чем не выбрать.
 */
export function gateHint({ kind, rel, sessionId = null, created = null, outside = false, packageRoot, mode = 'claude', passes = 0 }) {
  // Проверку в конце исполнит субагент, которому основная модель обязана описать работу. Сказано
  // при взводе, а не только при блокировке: замысел, отвергнутые варианты и сомнения проще
  // удержать по ходу, чем восстанавливать задним числом из длинной сессии.
  const call = packageRoot
    ? `Перед завершением проверку исполнит субагент \`${runnerType({ packageRoot, mode })}\`: ему понадобится твоё описание работы —` +
      ' задача, решения и отвергнутые варианты, инварианты, что проверено вживую, сомнения. Держи это в уме по ходу.'
    : mode === 'claude'
      ? 'Перед завершением работы прогони Skill: quality-gate.'
      : 'Перед завершением работы вызови skill `quality-gate` (skill({ name: "quality-gate" })).';
  const tail =
    mode === 'claude'
      ? 'Завершение сессии заблокировано, пока гейт не снят.'
      : 'Пока гейт не снят, плагин будет возвращать тебя к работе на каждой паузе.';

  // Путь к плану печатается literal — так же, как toolPath() в blockMessage(): подсказка
  // читается до первого разрешения `$QG` в сессии, а без готового пути модель не знает, что
  // именно она сможет запустить.
  const planLine = packageRoot ? `План прогона: node "${join(packageRoot, 'tools', 'gate.mjs').replace(/\\/g, '/')}" plan` : null;
  // Правка после прохода — следующий проход цикла; номер и потолок названы при взводе, чтобы
  // цикл «проход → исправить → проход» был виден модели до того, как она в него войдёт.
  const passLine = passes > 0 ? [`Проверка после этой правки станет проходом ${passes + 1} из ${MAX_PASSES} в цикле.`] : [];

  const lines =
    kind === 'bsl'
      ? [
          '[1C QUALITY GATE — взведён: BSL]',
          `Файл: ${rel}`,
          ...(sessionId ? [`Сессия: ${sessionId} — её идентификатор для --session в verify/release.`] : []),
          '',
          call,
          ...passLine,
          ...(planLine ? [planLine] : []),
          'Он сам определит глубину по трём осям (объём правки, архетипы кода, сложность)',
          'и запустит только нужные контуры. Мелкая правка проверяется за секунды.',
          '',
          tail,
        ]
      : [
          '[1C QUALITY GATE — взведён: XML метаданных]',
          `Файл: ${rel}`,
          ...(sessionId ? [`Сессия: ${sessionId} — её идентификатор для --session в verify/release.`] : []),
          '',
          call,
          ...passLine,
          ...(planLine ? [planLine] : []),
          'Для нового объекта критична проверка регистрации в составе конфигурации',
          '(Configuration.xml выгрузки либо Configuration.mdo в проекте EDT): файл-сирота',
          'вне состава не попадает в сборку, при этом среда этого не диагностирует —',
          'ошибка всплывает только в рантайме.',
          '',
          tail,
        ];

  // Приближение допустимо, но обязано быть заявлено — и в момент взвода, когда прогон ещё
  // можно спланировать: отказ сверки в конце провоцирует обход (переписывание следа).
  if (outside) {
    lines.push(
      '',
      'Файл лежит вне корня проекта. Путезависимые проверки (bsl-lint, query-lint, гигиена,',
      'валидаторы XML) работают по нему штатно; привязанные к проекту (статический анализатор',
      'по конфигурации, индекс кода) его не увидят — закрывай их записью not_verified с точной',
      'причиной. Из стороннего каталога корень задаётся явно: QG_PROJECT_DIR=<корень>.'
    );
  }

  // Только на прогоне, который файл создал: сообщение на каждой правке — шум, который
  // перестают читать вместе со всем остальным текстом подсказки.
  if (created && packageRoot) {
    lines.push(
      '',
      `Создан файл настройки проекта: ${created}`,
      'В нём пороги осей профиля, движок анализатора, проектные архетипы и номер часового.',
      'Секции пустые — действуют умолчания; описание ключей лежит в самом файле.',
      `Что действует сейчас: node "${String(packageRoot).replace(/\\/g, '/')}/tools/config.mjs" show`
    );
  }

  return lines.join('\n');
}

/**
 * Сообщение о неснятом гейте.
 *
 * mode: 'claude' — жёсткая блокировка Stop-хука; repeated=true означает повторную попытку
 * завершения (stop_hook_active) и добавляет прямой путь к команде отказа.
 * mode: 'opencode' — мягкий возврат к работе на session.idle; repeated — номер
 * автоматического возврата из maxReprompts.
 */
export function blockMessage({ sessionId, files, foreign = 0, packageRoot, mode = 'claude', repeated = 0, maxReprompts = 3, passes = 0 }) {
  const bsl = files.filter(([, v]) => v.kind === 'bsl').map(([k]) => k);
  const xml = files.filter(([, v]) => v.kind === 'metadata-xml').map(([k]) => k);
  const toolPath = (name) => join(packageRoot, 'tools', name).replace(/\\/g, '/');

  const lines = [
    mode === 'claude'
      ? '[ГЕЙТ КАЧЕСТВА 1С — ЗАВЕРШЕНИЕ ЗАБЛОКИРОВАНО]'
      : '[ГЕЙТ КАЧЕСТВА 1С — РАБОТА НЕ ЗАВЕРШЕНА]',
    '',
    mode === 'claude'
      ? `В этой работе изменены файлы 1С (${files.length}), но проверка качества не прогонялась.`
      : `В этой сессии изменены файлы 1С (${files.length}), но проверка качества не прогонялась.`,
  ];

  if (bsl.length) {
    lines.push('', `BSL (${bsl.length}):`);
    lines.push(...bsl.slice(0, 10).map((f) => `  - ${f}`));
    if (bsl.length > 10) lines.push(`  … и ещё ${bsl.length - 10}`);
  }
  if (xml.length) {
    lines.push('', `XML метаданных (${xml.length}):`);
    lines.push(...xml.slice(0, 10).map((f) => `  - ${f}`));
    if (xml.length > 10) lines.push(`  … и ещё ${xml.length - 10}`);
  }

  // Состав проверки решается до передачи субагенту: чужой файл, ушедший в задание, — это
  // проверка работы, о которой сессия ничего не знает.
  const byTime = files.filter(([, v]) => v.source === 'shell').map(([k]) => k);
  if (byTime.length) {
    lines.push('', `Из них взведены по времени изменения (${byTime.length}) — командой оболочки, а не инструментом правки:`);
    lines.push(...byTime.slice(0, 10).map((f) => `  - ${f}`));
    if (byTime.length > 10) lines.push(`  … и ещё ${byTime.length - 10}`);
    lines.push(...disownLines({ sessionId, packageRoot }));
  }

  lines.push(
    '',
    ...handoffLines({ sessionId, packageRoot, mode, passes }),
    '',
    'Правка действительно не требует проверки (комментарий, опечатка) — сними гейт явно, с причиной:',
    `  node "${toolPath('gate.mjs')}" release --session ${sessionId} --class C0 --reason "<почему>"`,
    'Причина сохраняется в состоянии: пропуск фиксируется, а не замалчивается.',
    ...(mode === 'claude' ? ['', `Сессия: ${sessionId}`] : [])
  );

  if (passes >= MAX_PASSES) {
    lines.push(
      '',
      `Потолок цикла: проходов уже ${passes} из ${MAX_PASSES}. Либо сними гейт по последнему отчёту и отдай остаток пользователю,`,
      `либо запусти проверку с записанным решением: node "${toolPath('gate.mjs')}" run --session ${sessionId} --decision "<кто решил и что>"`
    );
  }

  if (foreign > 0) {
    lines.push(
      `В проекте есть также правки другой сессии (${foreign}) — их НЕ трогай:`,
      'за них отвечает та сессия, снятие чужого гейта перехватывает чужую работу.'
    );
  }

  if (mode === 'claude' && repeated) {
    // Повторная попытка завершения: гейт не пропускает по-прежнему, но если снятие
    // штатным путём почему-то недоступно, показываем точную команду отказа.
    lines.push(
      '',
      'Это повторная попытка завершения — блокировка не снимается сама.',
      `Крайний случай: node "${toolPath('gate.mjs')}" release --session ${sessionId} --class C0 --reason "<почему>"`
    );
  }

  if (mode === 'opencode' && repeated > 0) {
    lines.push(
      '',
      `Это автоматический возврат №${repeated} из ${maxReprompts} на тот же состав правок.`,
      'После последнего возврата плагин умолкнет, но гейт останется взведённым:',
      `node "${toolPath('gate.mjs')}" status покажет охват.`
    );
  }

  return lines.join('\n');
}
