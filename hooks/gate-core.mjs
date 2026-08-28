/**
 * Ядро механики гейта: классификация файлов, взвод, чтение состояния, тексты сообщений.
 *
 * Единый источник для трёх потребителей:
 *   - hooks/gate-arm.mjs   — PostToolUse-хук Claude Code;
 *   - hooks/gate-check.mjs — Stop-хук Claude Code;
 *   - opencode/plugin/quality-gate.js — плагин OpenCode (tool.execute.after + session.idle).
 *
 * Вынесено сюда, чтобы три копии classifyFile и записи состояния не разъезжались при
 * первой же правке — ровно тот дефект, который плагин ищет в чужом коде.
 *
 * Тексты зависят от харнесса (параметр mode): 'claude' — исходные формулировки,
 * 'opencode' — честные для мягкого гейта: OpenCode не даёт запретить завершение сессии,
 * поэтому обещать «завершение заблокировано» нельзя.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { stateDirSegments } from '../tools/state-dir.mjs';
import { removeFileSync } from '../tools/fs-safe.mjs';

export const PENDING = 'qg-pending.json';
export const DONE = 'qg-done.json';

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
 * Взводит гейт для файла в сессии. Возвращает { kind, rel, created } либо null,
 * если файл не относится к 1С.
 *
 * Гейт взводится ВСЕГДА, когда затронут файл 1С, — здесь видна одна правка, и оценить её
 * масштаб нельзя. Градация работает не здесь, а на снятии: прогон класса C0/C1 занимает
 * секунды и снимает маркер так же законно, как полный.
 *
 * ensureConfig — функция из tools/config.mjs, передаётся снаружи, чтобы ядро не тянуло
 * конфигурацию в окружениях, где она недоступна.
 */
export function armGate({ root, filePath, sessionId, ensureConfig = null, env = process.env }) {
  const kind = classifyFile(filePath);
  if (!kind) return null;

  const stateDir = join(root, ...stateDirSegments(env));
  const pendingPath = join(stateDir, PENDING);
  const donePath = join(stateDir, DONE);

  mkdirSync(stateDir, { recursive: true });

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
  const rel = toProjectRelative(root, filePath);
  const entry = session.files[rel] || { kind, edits: 0 };
  entry.kind = kind;
  entry.edits += 1;
  entry.lastEdit = now;

  // Правка обесценивает все доказательства по этому файлу. Гейт — требование к ТЕКУЩЕМУ
  // состоянию артефакта, а не отметка «инструмент когда-то запускался»: проверки, сделанные
  // до правки, относятся к другому содержимому и переиспользованы быть не могут.
  delete entry.verified;

  session.files[rel] = entry;
  session.updatedAt = now;
  state.sessions[sessionId] = session;

  writeFileSync(pendingPath, JSON.stringify(state, null, 2), 'utf8');

  // Новая правка обесценивает прошлый прогон ЭТОЙ сессии; чужие отметки не трогаем.
  if (existsSync(donePath)) {
    try {
      const done = JSON.parse(readFileSync(donePath, 'utf8'));
      if (done?.sessions) {
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

  return { kind, rel, created };
}

/**
 * Подсказка о взводе гейта. mode: 'claude' — исходные формулировки (жёсткий Stop-хук),
 * 'opencode' — честные для мягкого гейта («плагин будет возвращать к работе»).
 */
export function gateHint({ kind, rel, created = null, packageRoot, mode = 'claude' }) {
  const call =
    mode === 'claude'
      ? 'Перед завершением работы прогони Skill: quality-gate.'
      : 'Перед завершением работы вызови skill `quality-gate` (skill({ name: "quality-gate" })).';
  const tail =
    mode === 'claude'
      ? 'Завершение сессии заблокировано, пока гейт не снят.'
      : 'Пока гейт не снят, плагин будет возвращать тебя к работе на каждой паузе.';

  const lines =
    kind === 'bsl'
      ? [
          '[1C QUALITY GATE — взведён: BSL]',
          `Файл: ${rel}`,
          '',
          call,
          'Он сам определит глубину по трём осям (объём правки, архетипы кода, сложность)',
          'и запустит только нужные контуры. Мелкая правка проверяется за секунды.',
          '',
          tail,
        ]
      : [
          '[1C QUALITY GATE — взведён: XML метаданных]',
          `Файл: ${rel}`,
          '',
          call,
          'Для нового объекта критична проверка регистрации в составе конфигурации',
          '(Configuration.xml выгрузки либо Configuration.mdo в проекте EDT): файл-сирота',
          'вне состава не попадает в сборку, при этом среда этого не диагностирует —',
          'ошибка всплывает только в рантайме.',
          '',
          tail,
        ];

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
export function blockMessage({ sessionId, files, foreign = 0, packageRoot, mode = 'claude', repeated = 0, maxReprompts = 3 }) {
  const bsl = files.filter(([, v]) => v.kind === 'bsl').map(([k]) => k);
  const xml = files.filter(([, v]) => v.kind === 'metadata-xml').map(([k]) => k);
  const toolPath = (name) => join(packageRoot, 'tools', name).replace(/\\/g, '/');

  const lines = [
    mode === 'claude'
      ? '[ГЕЙТ КАЧЕСТВА 1С — ЗАВЕРШЕНИЕ ЗАБЛОКИРОВАНО]'
      : '[ГЕЙТ КАЧЕСТВА 1С — РАБОТА НЕ ЗАВЕРШЕНА]',
    '',
    mode === 'claude'
      ? `В этой работе изменены файлы 1С (${files.length}), но Skill: quality-gate не прогонялся.`
      : `В этой сессии изменены файлы 1С (${files.length}), но skill quality-gate не прогонялся.`,
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

  if (mode === 'claude') {
    lines.push(
      '',
      'Прогони Skill: quality-gate. Он определит глубину сам — по объёму правки,',
      'архетипам кода и сложности — и запустит только нужные контуры.',
      'Косметическая правка закрывается за секунды: класс C0 требует лишь гигиены файлов.',
      '',
      'Если правка действительно не требует проверки — сними гейт явно, с указанием причины:',
      `  node "${toolPath('gate.mjs')}" release --class C0 --reason "<почему>"`,
      'Причина сохраняется в состоянии: пропуск фиксируется, а не замалчивается.',
      '',
      `Сессия: ${sessionId}`
    );
  } else {
    lines.push(
      '',
      'Вызови skill `quality-gate`: skill({ name: "quality-gate" }). Он определит глубину сам —',
      'по объёму правки, архетипам кода и сложности — и запустит только нужные контуры.',
      'Косметическая правка закрывается за секунды: класс C0 требует лишь гигиены файлов.',
      '',
      'Если правка действительно не требует проверки — сними гейт явно, с указанием причины:',
      `  node "${toolPath('gate.mjs')}" release --session ${sessionId} --class C0 --reason "<почему>"`,
      'Причина сохраняется в состоянии: пропуск фиксируется, а не замалчивается.'
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
