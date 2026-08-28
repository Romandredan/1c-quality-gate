#!/usr/bin/env node
/**
 * Проектная настройка гейта — файл `.1c-quality-gate.json` в корне проекта.
 *
 * Единственный читатель этого файла. Раньше его читал только контур анализатора: секция
 * `analyzer` работала, а пороги осей, проектные архетипы и номер часового были описаны в
 * документации, но не читались ничем. Ключ, которого никто не читает, неотличим от
 * «правило не сработало» — тот же класс отказа, что и неподдерживаемое поле frontmatter.
 *
 * Файл создаёт плагин, а не пользователь: настройка, о существовании которой нужно узнать
 * из документации, для большинства не существует. Создаётся один раз, при первом взводе
 * гейта — то есть тогда, когда уже точно известно, что проект на 1С.
 *
 * Использование:
 *   node config.mjs show [--json]    что действует сейчас и откуда взято
 *   node config.mjs init [--force]   создать файл явно
 *   node config.mjs path             путь к файлу настройки
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectRoot } from './project-root.mjs';
import { stateDirSegments } from './state-dir.mjs';

export const CONFIG_FILE = '.1c-quality-gate.json';

/**
 * Версия плагина из манифеста — для печати в выводе инструментов.
 *
 * Зачем: в кэше плагинов живут ВСЕ установленные версии, и сессия с неверно разрешённым
 * путём работает инструментами устаревшей — в живом прогоне субагент из 0.10.0 честно
 * объявил несуществующими проверки, которые давно есть. Пока версия не печатается, такой
 * прогон неотличим от прогона актуальной версией.
 */
export function pluginVersion() {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json');
    return JSON.parse(readFileSync(manifest, 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** Суффикс с версией для итоговых строк инструментов. Пустой, если манифест не читается. */
export function versionSuffix() {
  const v = pluginVersion();
  return v ? ` [1c-quality-gate v${v}]` : '';
}

const STATE_DIR = stateDirSegments();
const INIT_MARKER = 'qg-config-init.json';

/**
 * Значения по умолчанию — они же полный перечень настраиваемого.
 *
 * Список закрытый намеренно: ключ, которого здесь нет, в разрешённый конфиг не попадёт и
 * будет назван неизвестным. Молча проглоченная опечатка в имени ключа выглядит как
 * настройка, которая не сработала, а разницы с «настройки нет» пользователю не видно.
 */
export const DEFAULTS = {
  analyzer: {
    engine: 'bsl-analyzer',
    binary: null,
    jar: null,
    version: null,
    required: false,
    autoInstall: true,
    config: null,
  },
  volume: { c1MaxLines: 40, c1MaxFiles: 1 },
  complexity: { maxNesting: 4, maxMethodLines: 120, maxParams: 7 },
  archetypes: { custom: [] },
  sentinel: { id: 'std454' },
  // Пары «исходники → собранный артефакт» для проверки свежести при снятии гейта.
  // Плагин раскладку репозитория не угадывает — пары называет проект.
  artifacts: { pairs: [] },
};

/**
 * Переменные окружения перекрывают файл: разовый прогон другим движком не должен требовать
 * правки конфига, который лежит под версионным контролем и общий для команды.
 */
const ENV_MAP = [
  ['analyzer', 'engine', 'QG_ANALYZER_ENGINE', (v) => v],
  ['analyzer', 'binary', 'QG_ANALYZER_BIN', (v) => v],
  ['analyzer', 'jar', 'QG_ANALYZER_JAR', (v) => v],
  ['analyzer', 'version', 'QG_ANALYZER_VERSION', (v) => v],
  ['analyzer', 'required', 'QG_ANALYZER_REQUIRED', (v) => v === 'true'],
  ['analyzer', 'autoInstall', 'QG_ANALYZER_AUTOINSTALL', (v) => v !== 'false'],
];

/**
 * Корень проекта. Не `process.cwd()`: настройка лежит в корне, а команду запускают откуда
 * придётся — и тогда файл «не находится», а в след уходит `config=default` при живой
 * настройке. Разрешение и его причины — в `project-root.mjs`.
 */
export function projectRoot(env = process.env) {
  return resolveProjectRoot(process.cwd(), env).root;
}

export function configPath(root = projectRoot()) {
  return join(root, CONFIG_FILE);
}

/**
 * Снимает ключи-комментарии `//`.
 *
 * Они есть потому, что JSON не знает комментариев, а настройка, описание которой нужно
 * искать в другом файле, не находится. Но до потребителей эта проза доходить не должна:
 * модель читает разрешённый конфиг как данные и примет описание ключа за его значение.
 */
export function stripDocs(value) {
  if (Array.isArray(value)) return value.map(stripDocs);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('//')) continue;
      out[k] = stripDocs(v);
    }
    return out;
  }
  return value;
}

/** Читает файл настройки. Повреждённый не роняет прогон — работаем на умолчаниях и говорим об этом. */
export function readFileConfig(root = projectRoot()) {
  const file = configPath(root);
  if (!existsSync(file)) return { exists: false, raw: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? stripDocs(parsed) : {};
    return { exists: true, raw };
  } catch (e) {
    return { exists: true, raw: {}, broken: String(e.message || e) };
  }
}

/**
 * Разрешает настройку: умолчания → файл → окружение.
 *
 * Возвращает не только значения, но и источник каждого. Без источника «40» в выводе
 * неотличимо от «40, потому что проект так решил», а именно это и требуется знать, когда
 * вердикт гейта в двух проектах разный.
 */
export function resolve(root = projectRoot(), env = process.env) {
  const { exists, raw, broken } = readFileConfig(root);
  const values = {};
  const sources = {};
  const unknown = [];

  for (const [section, defaults] of Object.entries(DEFAULTS)) {
    values[section] = { ...defaults };
    sources[section] = {};
    const fromFile =
      raw[section] && typeof raw[section] === 'object' && !Array.isArray(raw[section]) ? raw[section] : {};

    for (const key of Object.keys(defaults)) {
      const given = Object.prototype.hasOwnProperty.call(fromFile, key) ? fromFile[key] : undefined;
      if (given === undefined || given === null) {
        sources[section][key] = 'умолчание';
      } else {
        values[section][key] = given;
        sources[section][key] = 'файл';
      }
    }
    for (const key of Object.keys(fromFile)) {
      if (!Object.prototype.hasOwnProperty.call(defaults, key)) unknown.push(`${section}.${key}`);
    }
  }
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) unknown.push(key);
  }

  for (const [section, key, name, cast] of ENV_MAP) {
    const v = env[name];
    if (v === undefined || v === '') continue;
    values[section][key] = cast(v);
    sources[section][key] = 'окружение';
  }

  return { path: configPath(root), exists, broken: broken || null, values, sources, unknown };
}

/** Разрешённые значения без метаданных — для потребителей, которым источник не нужен. */
export function readConfig(root = projectRoot(), env = process.env) {
  return resolve(root, env).values;
}

/** Секции, где хоть одно значение пришло не из умолчаний. */
export function overriddenSections(state) {
  return Object.keys(DEFAULTS).filter((section) =>
    Object.values(state.sources[section] || {}).some((src) => src !== 'умолчание')
  );
}

/**
 * Поле записи `scope` следа прогона.
 *
 * Печатается инструментом, а не сочиняется по памяти: прогон, не заглянувший в настройку,
 * оставлял след, неотличимый от прогона, который её учёл. Пороги при этом у проектов разные,
 * и «C1» в одном отчёте означает не то же, что «C1» в другом.
 */
export function evidenceField(state) {
  const changed = overriddenSections(state);
  return `config=${evidenceValue(state)}`;
}

/** Только значение поля — для сверки заявленного в следе с фактическим. */
export function evidenceValue(state) {
  const changed = overriddenSections(state);
  return changed.length ? `custom:${changed.join('+')}` : 'default';
}

/**
 * Содержимое создаваемого файла.
 *
 * Секции пустые намеренно. Записанное значение закрепляет его навсегда — включая обновления
 * плагина, в которых умолчание могло измениться, — и отличить «пользователь так решил» от
 * «так сгенерировалось год назад» будет нечем. Описания ключей лежат рядом с местом правки:
 * иначе о существовании настройки узнаёт только тот, кто прочитал документацию.
 */
export function template() {
  return (
    JSON.stringify(
      {
        '//': [
          'Настройка контроля качества 1С (плагин 1c-quality-gate). Файл создан плагином.',
          'Все секции необязательны: пустая секция и удалённый ключ означают умолчание плагина.',
          'Значения намеренно не проставлены — записанное здесь закрепляется навсегда, включая',
          'обновления умолчаний. Задавайте только то, что действительно отличается от умолчания.',
          'Что действует сейчас: node <каталог плагина>/tools/config.mjs show.',
          'Полное описание ключей: docs/CONFIG.md в составе плагина.',
        ].join(' '),
        analyzer: {
          '//':
            'engine: bsl-analyzer | bsl-ls (умолчание bsl-analyzer). binary: путь к бинарнику. ' +
            'jar: путь к jar, обязателен для bsl-ls. version: закреплённая версия, несовпадение ' +
            'останавливает прогон. required: false — при true гейт без анализатора не снимается. ' +
            'autoInstall: true. config: свой конфиг движка вместо гейтового.',
        },
        volume: {
          '//':
            'Пороги оси объёма. c1MaxLines: 40, c1MaxFiles: 1 — за ними правка перестаёт быть ' +
            'точечной и класс поднимается до C2.',
        },
        complexity: {
          '//':
            'Пороги оси сложности по изменённым методам. maxNesting: 4, maxMethodLines: 120, ' +
            'maxParams: 7 — срабатывание поднимает контур code до L2, а arch до уровня 1.',
        },
        archetypes: {
          '//':
            'custom: архетипы проекта в дополнение к встроенным. Каждый — ' +
            '{ "name": "имя", "markers": ["строка в диффе"], "minCode": "L1|L2", "minArch": "1|2|3" }. ' +
            'minArch необязателен.',
        },
        sentinel: {
          '//':
            'id: номер заведомо существующего стандарта, которым проверяется живость MCP v8std ' +
            '(умолчание std454). Закрепите свой, если номер когда-нибудь исчезнет: неудачу запроса ' +
            'нельзя отличить от исчезновения страницы.',
        },
        artifacts: {
          '//':
            'pairs: пары «исходники → артефакт» для проверки свежести при снятии гейта. Каждая — ' +
            '{ "source": "src/xml/Обработка", "artifact": "build/Обработка.epf" }; пути от корня ' +
            'проекта, source — файл или каталог. Артефакт старше любого исходника из своего дерева ' +
            'даёт предупреждение (не блок): исправленный в исходниках дефект не попал в сборку.',
        },
      },
      null,
      2
    ) + '\n'
  );
}

/**
 * Создаёт файл настройки, если его ещё нет.
 *
 * Один раз за проект: пользователь, удаливший файл, отказался от настройки, а не попросил
 * создавать её заново на каждой правке. Факт создания помнит маркер в состоянии гейта.
 */
export function ensureConfig(root = projectRoot()) {
  const file = configPath(root);
  if (existsSync(file)) return { created: false, reason: 'exists', path: file };

  const marker = join(root, ...STATE_DIR, INIT_MARKER);
  if (existsSync(marker)) return { created: false, reason: 'declined', path: file };

  writeFileSync(file, template(), 'utf8');
  // Маркер пишется ПОСЛЕ файла: сорванная запись конфига не должна оставить отметку,
  // из-за которой он больше никогда не создастся.
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ createdAt: new Date().toISOString(), file: CONFIG_FILE }, null, 2), 'utf8');
  return { created: true, reason: 'created', path: file };
}

function formatValue(v) {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) {
    if (v.length === 0) return 'нет';
    const names = v.map((x) => (x && typeof x === 'object' ? x.name || '?' : String(x)));
    return `${v.length}: ${names.join(', ')}`;
  }
  return String(v);
}

function cmdShow(root, json) {
  const state = resolve(root);
  if (json) {
    process.stdout.write(JSON.stringify({ ...state, evidence: evidenceField(state) }, null, 2) + '\n');
    return state.broken ? 1 : 0;
  }

  const rows = [];
  for (const [section, values] of Object.entries(state.values)) {
    for (const [key, value] of Object.entries(values)) {
      rows.push([`${section}.${key}`, formatValue(value), state.sources[section][key]]);
    }
  }
  const width = Math.max(...rows.map((r) => r[0].length));
  const valueWidth = Math.max(...rows.map((r) => r[1].length));

  // Откуда взят корень — не техническая подробность: «настройки нет» и «искали не в том
  // каталоге» дают одинаковый вывод, пока не сказано, какой каталог считался корнем.
  const where = resolveProjectRoot(process.cwd());
  const via =
    where.via === 'env'
      ? 'переменная окружения (QG_PROJECT_DIR / CLAUDE_PROJECT_DIR)'
      : where.via === 'marker'
        ? `по маркеру ${where.marker}`
        : 'рабочий каталог — маркеров корня выше не найдено';
  process.stdout.write(`Корень проекта: ${where.root} (${via})\n`);
  process.stdout.write(`Проектная настройка: ${state.path}\n`);
  if (!state.exists) {
    process.stdout.write('Файла нет — действуют умолчания. Создастся при первом взводе гейта либо по `init`.\n');
  } else if (state.broken) {
    process.stdout.write(`ФАЙЛ НЕ РАЗОБРАН (${state.broken}) — действуют умолчания, настройка НЕ применена.\n`);
  }
  process.stdout.write('\n');
  for (const [name, value, source] of rows) {
    process.stdout.write(`  ${name.padEnd(width)}  ${value.padEnd(valueWidth)}  ${source}\n`);
  }
  if (state.unknown.length) {
    process.stdout.write(
      `\nНеизвестные ключи (не применяются, проверьте написание): ${state.unknown.join(', ')}\n`
    );
  }
  process.stdout.write(`\nВ запись scope следа прогона: ${evidenceField(state)}\n`);
  return state.broken ? 1 : 0;
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'show';
  const root = projectRoot();

  switch (cmd) {
    case 'show':
      return cmdShow(root, args.includes('--json'));
    case 'path':
      process.stdout.write(configPath(root) + '\n');
      return 0;
    case 'init': {
      const file = configPath(root);
      if (args.includes('--force')) {
        writeFileSync(file, template(), 'utf8');
        process.stdout.write(`Файл настройки перезаписан: ${file}\n`);
        return 0;
      }
      const r = ensureConfig(root);
      if (r.created) process.stdout.write(`Файл настройки создан: ${file}\n`);
      else if (r.reason === 'exists') process.stdout.write(`Файл настройки уже есть: ${file}\n`);
      else process.stdout.write(`Файл был создан ранее и удалён — повторно не создаём. Явно: init --force\n`);
      return 0;
    }
    default:
      process.stderr.write('Использование:\n  node config.mjs show [--json]\n  node config.mjs init [--force]\n  node config.mjs path\n');
      return 2;
  }
}

if (process.argv[1]?.endsWith('config.mjs')) {
  process.exit(main(process.argv));
}
