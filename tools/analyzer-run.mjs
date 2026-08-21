#!/usr/bin/env node
/**
 * Запуск статического анализатора BSL и нормализация его вывода.
 *
 * Зачем отдельный слой. Гейту нужен воспроизводимый вердикт, а не ответ на вопрос модели:
 * что не спросили у MCP — того нет в отчёте, и отличить «проверено и чисто» от «не спросили»
 * нечем. Поэтому анализатор запускается консольно, а этот модуль превращает его вывод в
 * единый вид находки и в записи следа, одинаковые для всех поддержанных движков.
 *
 * Поддержаны два бэкенда:
 *   bsl-analyzer  — по умолчанию: умеет `--incremental --changed-files`, то есть сужает
 *                   вывод до изменённых файлов, не теряя контекста конфигурации;
 *   bsl-ls        — запасной: сужать область нельзя (диагностики по метаданным молча гаснут),
 *                   поэтому гоняем от корня конфигурации и фильтруем отчёт здесь.
 *
 * Использование:
 *   node analyzer-run.mjs --changed <файл> [--changed <файл> ...] [--engine <имя>] [--json]
 *   node analyzer-run.mjs --sentinel
 *
 * Контракт `--json` (ключи верхнего уровня, названы здесь потому, что потребитель, читающий
 * не тот ключ, получает пустоту и принимает её за «нарушений нет»):
 *   findings    — находки: `{ file, line, column, code, severity, message }`. Ключ называется
 *                 так, а НЕ `diagnostics`: `diagnostics` — имя поля во ВНУТРЕННЕМ формате
 *                 движка, до нормализации, и снаружи его нет;
 *   metrics     — метрики по файлам (`functions`, `complexity`, `cognitive_complexity`);
 *   unparsed    — файлы с ошибками разбора: по ним не проверено ничего;
 *   unanalyzed  — изменённые файлы, которых движок не видел вовсе;
 *   evidence    — готовые строки следа, переносятся в отчёт дословно;
 *   orphans     — переданные файлы вне корня конфигурации.
 *
 * Коды выхода: 0 — прогон состоялся, 1 — анализатор недоступен и не обязателен,
 * 2 — обязателен и недоступен, либо часовой не подтверждён.
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { removeTreeSync } from './fs-safe.mjs';
import { join, dirname, resolve, relative, sep, isAbsolute, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  readManifest,
  installed as bootstrapInstalled,
  install as installAnalyzer,
  adopt as adoptAnalyzer,
  sha256,
  targetKey,
} from './analyzer-bootstrap.mjs';
import { DEFAULTS, readConfig, versionSuffix } from './config.mjs';
import { resolveProjectRoot as resolveRoot } from './project-root.mjs';
import { recordRun } from './run-journal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = dirname(HERE);

const IS_WINDOWS = process.platform === 'win32';
const CONFIG_MARKER = 'Configuration.xml';

/** Часовой требует диагностику, ЗАВИСЯЩУЮ ОТ МЕТАДАННЫХ, — см. sentinel() ниже. */
export const SENTINEL_CODE = 'CommonModuleInvalidType';

/**
 * Диагностики, недостоверные при разборе расширения без основной конфигурации: имена БСП и
 * типовой в нём отсутствуют физически, поэтому «не удалось разрешить» относится к области
 * анализа, а не к коду. Измерено на боевых расширениях: до трети всех находок.
 */
export const UNRESOLVED_WITHOUT_MAIN = new Set([
  'UnresolvedMethodCall',
  'UnresolvedField',
  'QueryToMissingMetadata',
  'UnknownFieldInQuery',
  'MismatchedArgCount',
  'MissedRequiredParameter',
]);

/** Умолчания контура анализатора живут в общем разрешителе настройки — здесь только имя. */
export const DEFAULT_ANALYZER = DEFAULTS.analyzer;

/**
 * Серьёзность движка → наша шкала.
 * Неизвестное значение осознанно падает в 'minor', а не отбрасывается: находка без понятной
 * серьёзности всё равно находка, а молчаливая потеря — тот самый ложный зелёный.
 */
const SEVERITY_MAP = {
  blocker: 'critical',
  critical: 'critical',
  major: 'major',
  minor: 'minor',
  warning: 'minor',
  information: 'info',
  info: 'info',
  hint: 'info',
};

/** Корень проекта — общий разрешитель: анализ от подкаталога не находит ни раскладки, ни настройки. */
export function projectRoot() {
  return resolveRoot(process.cwd(), process.env).root;
}

/**
 * Секция `analyzer` проектной настройки.
 *
 * Разбор `.1c-quality-gate.json` живёт в `config.mjs` и общий для всех осей: пока читателей
 * было два (этот — секции analyzer, и никто — остальных), половина документированных ключей
 * молча не работала.
 */
export function readAnalyzerConfig(root = projectRoot(), env = process.env) {
  return readConfig(root, env).analyzer;
}

/**
 * Ищет корень конфигурации 1С — каталог с `Configuration.xml`.
 *
 * Анализировать нужно именно от него: у bsl-analyzer сужение делается флагом, а у BSL LS
 * попытка указать более узкий каталог молча гасит диагностики по метаданным. Поиск идёт
 * вверх от файла и не выходит за пределы проекта.
 */
export function findConfigRoot(file, stopAt = projectRoot()) {
  let dir = dirname(resolve(file));
  const stop = resolve(stopAt);
  for (;;) {
    if (existsSync(join(dir, CONFIG_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    if (!dir.startsWith(stop)) return null;
    dir = parent;
  }
}

/** В корневом XML расширения есть назначение; у основной конфигурации его нет. */
const EXTENSION_MARKER = '<ConfigurationExtensionPurpose>';
const SKIP_DIRS = new Set(['.git', '.claude', 'node_modules', 'build', 'out', 'dist', '.qg-analyzer']);

/**
 * Находит раскладку проекта: корень основной конфигурации и корни расширений.
 *
 * Зачем. Расширение, разобранное в одиночку, не видит ни основной конфигурации, ни БСП —
 * и каждое обращение к `ОбщегоНазначения` становится «неразрешённым вызовом». На боевых
 * расширениях это треть всех находок: шум, после которого проверку отключают. Анализатор
 * умеет принимать состав проекта секцией `[source]`, и тогда чужие имена разрешаются.
 */
export function discoverLayout(root = projectRoot(), maxDepth = 4) {
  const main = [];
  const extensions = [];

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === CONFIG_MARKER)) {
      let head = '';
      try {
        head = readFileSync(join(dir, CONFIG_MARKER), 'utf8').slice(0, 8192);
      } catch {
        /* нечитаемый корень пропускаем молча: это не наша ошибка */
      }
      (head.includes(EXTENSION_MARKER) ? extensions : main).push(dir);
      return; // внутрь корня конфигурации не спускаемся
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(resolve(root), 0);

  // Несколько основных конфигураций в одном проекте — редкость (обычно это выгрузка для
  // сравнения). Берём первую по алфавиту, чтобы результат был воспроизводим.
  return { main: main.sort()[0] || null, mainCandidates: main.sort(), extensions: extensions.sort() };
}

/**
 * Собирает конфиг анализатора: наши настройки диагностик плюс состав проекта.
 *
 * Настройки берутся из состава плагина, состав — из раскладки. Проектный конфиг анализатора
 * не читается намеренно: отключённая в нём диагностика делала бы гейт тише.
 */
export function buildProjectConfig({ layout, root = projectRoot(), baseConfig = null }) {
  const rel = (p) => relative(resolve(root), resolve(p)).split(sep).join('/');
  const lines = ['[source]', `root = "${rel(layout.main)}"`];
  if (layout.extensions.length) {
    lines.push('extensions = [');
    for (const e of layout.extensions) lines.push(`  "${rel(e)}",`);
    lines.push(']');
  }
  lines.push('');
  const base = baseConfig && existsSync(baseConfig) ? readFileSync(baseConfig, 'utf8') : '';
  return `# Сгенерировано плагином 1c-quality-gate. Правки будут перезаписаны.\n` + lines.join('\n') + '\n' + base;
}

/** Группирует изменённые файлы по корням конфигураций: в проекте их может быть несколько. */
export function groupByConfigRoot(files, stopAt = projectRoot()) {
  const groups = new Map();
  const orphans = [];
  for (const f of files) {
    const root = findConfigRoot(f, stopAt);
    if (!root) {
      orphans.push(f);
      continue;
    }
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(resolve(f));
  }
  return { groups, orphans };
}

/** Типы дескриптора, по которым узнаётся выгрузка внешней обработки или отчёта. */
const STANDALONE_MARKERS = ['<ExternalDataProcessor', '<ExternalReport'];

/**
 * Находит корень выгрузки внешней обработки или отчёта, которому принадлежит файл.
 *
 * Зачем. `findConfigRoot` ищет `Configuration.xml`, а в выгрузке внешней обработки его нет
 * и быть не может. Дальше файл уходил либо в `orphans`, либо мимо `[source]` сгенерированного
 * конфига — и весь класс кода внешних обработок не проходил статический анализ ни в одном
 * проекте. Гейт про это честно писал `not_verified: not_in_analyzer_report`, но 29 диагностик,
 * которые прямой прогон движка даёт по одной такой обработке, до отчёта не доходили.
 *
 * Признак корня: каталог, где рядом с подкаталогом `X` лежит дескриптор `X.xml` с типом
 * `ExternalDataProcessor` или `ExternalReport`. Именно этот каталог движок принимает
 * ключом `-s`; вложенность файла внутри `X` значения не имеет.
 */
export function findStandaloneRoot(file, stopAt = projectRoot()) {
  let dir = dirname(resolve(file));
  const stop = resolve(stopAt);
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    if (!dir.startsWith(stop)) return null;
    const descriptor = join(parent, `${basename(dir)}.xml`);
    if (existsSync(descriptor)) {
      let head = '';
      try {
        head = readFileSync(descriptor, 'utf8').slice(0, 4096);
      } catch {
        /* нечитаемый дескриптор корнем не признаём: это не наша ошибка */
      }
      if (STANDALONE_MARKERS.some((m) => head.includes(m))) return parent;
    }
    dir = parent;
  }
}

/** Группирует файлы по корням выгрузок внешних обработок; остальные возвращаются в `rest`. */
export function groupByStandaloneRoot(files, stopAt = projectRoot()) {
  const groups = new Map();
  const rest = [];
  for (const f of files) {
    const root = findStandaloneRoot(f, stopAt);
    if (!root) {
      rest.push(f);
      continue;
    }
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(resolve(f));
  }
  return { groups, rest };
}

/**
 * Возвращает бинарник, про который УЖЕ известно, что он закреплён: либо указанный
 * пользователем явно, либо свою установку, версия которой закреплена манифестом и сверена
 * по SHA-256.
 *
 * Чужую установку эта функция не отдаёт принципиально. Раньше отдавала — и закрепление
 * версии не работало: манифест поднимали до новой версии, а гейт продолжал молча гонять то,
 * что держит лаунчер. Разбор чужой установки живёт в `ensureBslAnalyzer`, где её сначала
 * сверяют с манифестом.
 */
export function resolveBslAnalyzer(cfg) {
  if (cfg.binary) return existsSync(cfg.binary) ? cfg.binary : null;

  try {
    const own = bootstrapInstalled(readManifest());
    if (own) return own;
  } catch {
    /* манифеста нет или он повреждён — работаем как раньше */
  }
  return null;
}

/** Каталог установки лаунчера. Отдельной функцией — чтобы тест мог подставить свой. */
export function launcherDir() {
  return join(homedir(), '.bsl-analyzer', 'bin');
}

/**
 * Бинарник в установке лаунчера или null.
 *
 * Версионированный файл (`bsl-analyzer-0.2.66`) на Windows лежит БЕЗ расширения и через
 * spawn не запускается — CreateProcess его не видит (проверено: ENOENT). Поэтому там берём
 * рабочий `bsl-analyzer-app.exe`, а на прочих системах годится и версионированный.
 */
export function launcherCandidate(dir = launcherDir()) {
  if (!existsSync(dir)) return null;
  const app = join(dir, IS_WINDOWS ? 'bsl-analyzer-app.exe' : 'bsl-analyzer-app');
  if (existsSync(app)) return app;
  const versioned = readdirSync(dir)
    .filter((n) => /^bsl-analyzer-\d/.test(n))
    .sort()
    .pop();
  return versioned ? join(dir, versioned) : null;
}

/**
 * Находит анализатор, при необходимости устанавливая его.
 *
 * Автоустановка включена по умолчанию: плагин публичный, и шаг «скачайте бинарник сами»
 * отсекает тех, кто мог бы им пользоваться. Отключается `analyzer.autoInstall: false` —
 * тогда отсутствие анализатора честно уходит в `skipped`, как и раньше.
 *
 * Чужая установка (лаунчер автора) годится, только если это ровно закреплённый бинарник, и
 * проверяется это в два шага. Сначала дешёвый отсев по номеру версии (`--version`, 15 мс):
 * несовпадение — штатная ситуация, лаунчер живёт своей жизнью. Потом сверка SHA-256 (71 мс
 * на 63 МБ): совпал номер, но не совпали байты — ситуация уже подозрительная, и такой файл
 * не берётся вовсе. Причины разделены намеренно: слить их в одно сообщение значит потерять
 * разницу между «нормально» и «странно».
 *
 * При включённой автоустановке принятый файл КОПИРУЕТСЯ в каталог данных (см. `adopt`), а не
 * используется по месту: лаунчер обновляет свой файл сам, и ссылка на него протухла бы при
 * первом же его самообновлении. При выключенной копировать нечего — пользователь запретил
 * установку, — поэтому сверенный файл берётся по месту, и здесь остаётся щель: между сверкой
 * суммы и запуском лаунчер успел бы подменить файл. Закрыть её нечем, кроме копирования,
 * которое и запрещено, поэтому щель названа, а не спрятана: `analyzer.autoInstall: false`
 * означает, что за неизменность чужого файла отвечает тот, кто его туда положил.
 */
export async function ensureBslAnalyzer(cfg, log = () => {}, { launcherPath } = {}) {
  const found = resolveBslAnalyzer(cfg);
  if (found) return { path: found, installed: false };

  let manifest;
  try {
    manifest = readManifest();
  } catch {
    return { path: null, installed: false, reason: 'manifest_missing' };
  }
  // Закреплённая пользователем версия, отличная от манифестной, проверяться нечем: сумм для
  // неё у нас нет. Молча взять другую версию значит подменить то, что он закрепил.
  if (cfg.version && cfg.version !== manifest.version) {
    return { path: null, installed: false, reason: 'version_pin_without_checksum' };
  }

  const candidate = launcherPath === undefined ? launcherCandidate() : launcherPath;
  if (candidate) {
    const theirs = engineVersion(candidate);
    if (theirs !== manifest.version) {
      log(
        `Установка рядом держит ${theirs || 'неизвестную версию'}, закреплена ${manifest.version} — не используем её.`
      );
    } else if (!cfg.autoInstall) {
      const actual = await sha256(candidate);
      if (actual === manifest.targets[targetKey()]?.sha256) return { path: candidate, installed: false, adopted: 'in-place' };
      return { path: null, installed: false, reason: 'launcher_checksum_mismatch' };
    } else {
      const a = await adoptAnalyzer(manifest, candidate, { log });
      if (a.ok) return { path: a.path, installed: true, adopted: 'copied' };
      if (a.reason === 'checksum_mismatch') {
        log(`Версия совпала, а сумма — нет: файл рядом не тот, что закреплён. Ставлю свой.`);
      }
      // Копирование могло не удаться (на Windows лаунчер держит файл открытым). Это не
      // дефект: ниже отработает обычная установка.
    }
  }

  if (!cfg.autoInstall) return { path: null, installed: false, reason: 'autoinstall_disabled' };
  const r = await installAnalyzer(manifest, { log });
  return r.ok ? { path: r.path, installed: r.downloaded } : { path: null, installed: false, reason: r.reason };
}

export function engineVersion(binary) {
  const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 60_000 });
  if (r.error || r.status !== 0) return null;
  const m = String(r.stdout || '').match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/**
 * Нормализует jsonl bsl-analyzer. Нумерация строк у него нулевая — приводим к человеческой.
 *
 * Ошибки разбора выносятся отдельно от находок. Модуль, который не разобрался, выдаёт их
 * сотнями (реальный случай: 279 в одном файле — директивы `#Удаление` внутри многострочного
 * литерала в модуле `&ИзменениеИКонтроль`). Показать их как находки значит утверждать, что в
 * файле три сотни проблем, тогда как по нему не проверено НИЧЕГО. Это надо называть своим
 * именем: файл не проанализирован.
 */
export function normalizeBslAnalyzer(stdout, { root, base = projectRoot() } = {}) {
  const findings = [];
  const metrics = new Map();
  const unparsed = new Map();
  // Файлы, которые движок вообще держал в руках. Без этого множества «ноль находок» по файлу
  // и «файл не попал в анализ» дают одинаковый отчёт: пустой.
  const seen = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== 'file') continue;
    const file = toRelative(rec.path, base, root);
    seen.add(file);
    if (rec.metrics) metrics.set(file, rec.metrics);
    for (const d of rec.diagnostics || []) {
      if (d.code === 'ParseError') {
        unparsed.set(file, (unparsed.get(file) || 0) + 1);
        continue;
      }
      findings.push({
        file,
        line: (d.start_line ?? 0) + 1,
        column: (d.start_column ?? 0) + 1,
        code: d.code,
        severity: SEVERITY_MAP[String(d.severity || '').toLowerCase()] || 'minor',
        message: d.message || '',
      });
    }
  }
  // Из файла, который не разобрался, остальные находки тоже недостоверны: они получены на
  // обрывке синтаксического дерева.
  const clean = findings.filter((f) => !unparsed.has(f.file));
  return { findings: clean, metrics, unparsed, seen };
}

/** Нормализует JSON-отчёт BSL Language Server (`-r json`). У него нумерация тоже нулевая. */
export function normalizeBslLs(jsonText, { root, base = projectRoot(), only = null } = {}) {
  const findings = [];
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { findings, metrics: new Map(), unparsed: new Map() };
  }
  const keep = only ? new Set(only.map((f) => toRelative(f, base, root))) : null;
  for (const f of parsed.fileinfos || []) {
    const file = toRelative(f.path, base, root);
    if (keep && !keep.has(file)) continue;
    for (const d of f.diagnostics || []) {
      const code = typeof d.code === 'object' ? d.code?.value : d.code;
      findings.push({
        file,
        line: (d.range?.start?.line ?? 0) + 1,
        column: (d.range?.start?.character ?? 0) + 1,
        code: String(code || ''),
        severity: SEVERITY_MAP[String(d.severity || '').toLowerCase()] || 'minor',
        message: d.message || '',
      });
    }
  }
  return { findings, metrics: new Map(), seen: new Set(parsed.fileinfos?.map((f) => toRelative(f.path, base, root)) || []) };
}

/**
 * Приводит путь из отчёта к проектному.
 *
 * Движки отдают пути по-разному: bsl-analyzer — абсолютный windows-путь с префиксом
 * длинных имён `\\?\`, BSL Language Server — URI вида `file:///H:/...`. Без разбора обеих
 * форм фильтр по изменённым файлам молча не находит ни одного совпадения, и контур
 * отчитывается вердиктом «чисто» на пустом множестве.
 */
function toRelative(p, base, root) {
  let s = String(p);
  if (s.startsWith('file:')) {
    try {
      s = fileURLToPath(s);
    } catch {
      s = decodeURIComponent(s.replace(/^file:\/*/, ''));
    }
  }
  s = s.replace(/^\\\\\?\\/, '');
  const candidates = [base, root].filter(Boolean);
  for (const c of candidates) {
    const rel = relative(resolve(c), resolve(s));
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  }
  return s.split(sep).join('/');
}

/** Гейтовый конфиг движка из состава плагина; проектный конфиг правит IDE, этот — гейтом. */
export function gateConfigPath(engine, cfg) {
  if (cfg.config) return cfg.config;
  const name = engine === 'bsl-ls' ? 'bsl-language-server.json' : 'bsl-analyzer.toml';
  const p = join(PLUGIN_ROOT, 'assets', 'analyzer', name);
  return existsSync(p) ? p : null;
}

export function runBslAnalyzer({ binary, root, changed, configPath }) {
  const args = ['analyze', '--incremental', '-s', root, '--format', 'jsonl', '-q'];
  for (const f of changed) {
    args.push('--changed-files', relative(root, f).split(sep).join('/'));
  }
  if (configPath) args.push('-c', configPath);
  // Рабочий каталог — корень конфигурации: у BSL LS иной диск в cwd даёт падение
  // `'other' has different root`, и одинаковое поведение обоих бэкендов дешевле, чем разное.
  const r = spawnSync(binary, args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 900_000 });
  return { ok: !r.error && r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', args };
}

export function runBslLs({ jar, root, configPath }) {
  // Каталог отчёта обязан лежать на том же диске, что и исходники: системный TEMP на
  // Windows живёт на C:, и при проекте на другом диске BSL LS падает с невнятным
  // `'other' has different root`. Кладём рядом с исходниками — совпадение диска
  // обеспечено по построению.
  const stage = join(root, '.qg-analyzer');
  mkdirSync(stage, { recursive: true });
  const out = mkdtempSync(join(stage, 'run-'));
  const args = ['-jar', jar, 'analyze', '-s', root, '-r', 'json', '-o', out, '-q'];
  if (configPath) args.splice(2, 0, '-c', configPath);
  const r = spawnSync('java', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 1_800_000 });
  const report = join(out, 'bsl-json.json');
  const text = existsSync(report) ? readFileSync(report, 'utf8') : '';
  try {
    removeTreeSync(out);
    // Промежуточный каталог убираем ТОЛЬКО пустым: параллельный прогон может держать в нём
    // свой отчёт, и рекурсивное удаление снесло бы чужой результат.
    if (readdirSync(stage).length === 0) removeTreeSync(stage);
  } catch {
    /* уборка не критична */
  }
  return { ok: !r.error && Boolean(text), stdout: text, stderr: r.stderr || '', args };
}

/**
 * Часовой: прогоняет фикстуру с заведомым нарушением тем же вызовом и тем же конфигом.
 *
 * Требуется диагностика, ЗАВИСЯЩАЯ ОТ МЕТАДАННЫХ. Часовой, доказывающий лишь «хоть что-то
 * сработало», пропустит самый опасный отказ: при потере контекста конфигурации гаснет именно
 * класс метаданных, а прочие замечания остаются на месте — отчёт выглядит содержательным.
 * В бою сравнивать не с чем: базовой линии у гейта нет.
 */
export function sentinel({ engine, binary, jar, configPath }) {
  const root = join(PLUGIN_ROOT, 'assets', 'analyzer', 'sentinel-fixture');
  if (!existsSync(join(root, CONFIG_MARKER))) {
    return { status: 'not_found', reason: 'fixture_missing' };
  }
  let raw;
  if (engine === 'bsl-ls') {
    raw = runBslLs({ jar, root, configPath });
    if (!raw.ok) return { status: 'not_found', reason: 'engine_failed' };
    const { findings } = normalizeBslLs(raw.stdout, { root, base: root });
    return verdict(findings);
  }
  const changed = collectBsl(root);
  raw = runBslAnalyzer({ binary, root, changed, configPath });
  if (!raw.ok) return { status: 'not_found', reason: 'engine_failed' };
  const { findings } = normalizeBslAnalyzer(raw.stdout, { root, base: root });
  return verdict(findings);

  function verdict(findings) {
    const hit = findings.some((f) => f.code === SENTINEL_CODE);
    return hit ? { status: 'found' } : { status: 'not_found', reason: 'diagnostic_absent' };
  }
}

function collectBsl(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectBsl(p, acc);
    else if (/\.(bsl|os)$/i.test(entry.name)) acc.push(p);
  }
  return acc;
}

/**
 * Строит записи следа.
 *
 * Чистый прогон отчитывается идентификатором всего набора (`bslls:*`) — перечислять полторы
 * сотни проверенных кодов бессмысленно. Нарушения выводятся по одной записи на код: так в
 * следе видно, ЧТО именно сработало, а не только что «что-то нашли».
 */
export function toEvidence({
  findings,
  sentinelResult,
  engine,
  version,
  unparsed = new Map(),
  resolution = null,
  unanalyzed = [],
  standaloneRoots = 0,
}) {
  const lines = [];
  const stamp = version ? `${engine}@${version}` : engine;
  lines.push(
    `[qg sentinel: target=bslls, id=${SENTINEL_CODE}, status=${sentinelResult.status}, engine=${stamp}]`
  );
  // Неразобранный файл — не «чисто» и не «нарушение», а отсутствие проверки. Без этой записи
  // он растворяется в общем вердикте и выглядит проверенным.
  if (unparsed.size) {
    lines.push(`[qg not_verified: dimension=static-analysis, reason=parse_failed, files=${unparsed.size}]`);
  }
  // Изменённый файл, не встреченный в отчёте движка ни разу, не проверен ничем. Раньше он
  // просто исчезал: находок нет, метрик нет — и общий вердикт выходил «clean». Так молчали
  // файлы вне корня конфигурации (внешние обработки), отсечённые фильтром по подсистемам и
  // не попавшие в область анализа по любой другой причине.
  if (unanalyzed.length) {
    lines.push(
      `[qg not_verified: dimension=static-analysis, reason=not_in_analyzer_report, files=${unanalyzed.length}]`
    );
  }
  // Разрешение чужих имён без основной конфигурации невозможно: об этом надо сказать, иначе
  // отсутствие находок по межфайловым связям читается как их отсутствие в коде.
  if (resolution === 'extension-only') {
    lines.push('[qg not_verified: dimension=cross-config-resolution, reason=main_configuration_absent]');
  }
  // Выгрузка внешней обработки разбирается сама по себе всегда: состава конфигурации в ней нет
  // по устройству формата. Своё имя у оговорки, а не общее с расширением, потому что причина
  // разная: у расширения основную конфигурацию можно доложить в проект, у обработки — нет.
  else if (standaloneRoots) {
    lines.push(
      '[qg not_verified: dimension=cross-config-resolution, reason=standalone_artifact_without_configuration, ' +
        `roots=${standaloneRoots}]`
    );
  }
  const codes = [...new Set(findings.map((f) => f.code))].sort();
  if (codes.length === 0) {
    lines.push('[qg applied: layer=code, scope=static-analysis, ids=[bslls:*], verdict=clean]');
  } else {
    for (const c of codes) {
      lines.push(
        `[qg applied: layer=code, scope=static-analysis, ids=[bslls:${c}], verdict=violation:bslls:${c}]`
      );
    }
  }
  return lines;
}

export function skipEvidence(reason) {
  return [`[qg skipped: layer=code, scope=static-analysis, planned=[bslls:*], reason=${reason}]`];
}

function parseArgs(argv) {
  const out = { changed: [], engine: null, json: false, sentinel: false, evidenceOnly: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--changed') out.changed.push(argv[++i]);
    else if (a === '--engine') out.engine = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--sentinel') out.sentinel = true;
    else if (a === '--evidence') out.evidenceOnly = true;
    else if (a === '--all') out.all = true;
    else if (!a.startsWith('--')) out.changed.push(a);
  }
  return out;
}

const SEVERITY_MARK = { critical: '🔴', major: '🟠', minor: '🟡', info: '·' };
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2, info: 3 };

/**
 * Диагностики уровня `info`, которые печатаются всегда — исключение из свёртки ниже.
 *
 * Все они об оформлении программного интерфейса и структуре модуля (#std453, #std455):
 * метод без описания, переменная без описания, код вне области, нестандартный или пустой
 * раздел. Движок относит их к `info`, и свёртка прятала их вместе с типографикой — а в
 * следе прогона они при этом стоят как `violation`. Читатель отчёта видел «чисто» там, где
 * след говорил «нарушение»: расхождение, которое обесценивает обе стороны.
 *
 * Список подобран замером, а не на глаз: на расширении из 36 модулей эти коды дают 23 строки
 * против 199 у типографики (`MagicNumber` 66, `NestedFunctionInParameters` 45,
 * `CommentedCode` 36, `DuplicateStringLiteral` 31, `CanonicalSpellingKeywords` 21). Ради
 * последних свёртка и существует — расширять этот набор можно только с таким же замером,
 * иначе он вернёт ровно ту проблему, которую свёртка решает.
 */
export const ALWAYS_SHOWN_INFO = new Set([
  'PublicMethodsDescription',
  'MissingVariablesDescription',
  'CodeOutOfRegion',
  'NonStandardRegion',
  'EmptyRegion',
  'DuplicateRegion',
]);

/**
 * Печатает находки, сворачивая информационные в одну строку.
 *
 * Причина не в том, что они не важны, а в том, что на реальном модуле их вдесятеро больше
 * содержательных: `MagicNumber`, смешение латиницы и кириллицы в идентификаторах вида
 * `ВызватьHTTPМетод` (для 1С это норма, а диагностика отличить не может). Утопленная в них
 * находка 🟠 не будет прочитана. Ничего не скрывается: количество названо, коды попадают в
 * след, полный список доступен по `--all`. Исключения — `ALWAYS_SHOWN_INFO`.
 */
export function report(findings, out, { all = false } = {}) {
  const isFolded = (f) => f.severity === 'info' && !ALWAYS_SHOWN_INFO.has(f.code);
  const shown = all ? findings : findings.filter((f) => !isFolded(f));
  const hidden = findings.length - shown.length;

  const byFile = new Map();
  for (const f of shown) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, list] of [...byFile.entries()].sort()) {
    out(`\n${file}`);
    for (const f of list.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.line - b.line)) {
      out(`  ${SEVERITY_MARK[f.severity]} :${f.line} — ${f.code}: ${f.message}`);
    }
  }
  if (hidden) {
    const codes = [...new Set(findings.filter(isFolded).map((f) => f.code))].sort();
    out(`\nЕщё ${hidden} информационных: ${codes.join(', ')} (полный список — флаг --all)`);
  }
}

async function main(argv) {
  const args = parseArgs(argv.slice(2));
  const out = (s) => process.stdout.write(s + '\n');
  const root = projectRoot();
  const cfg = readAnalyzerConfig(root);
  const engine = args.engine || cfg.engine;
  const configPath = gateConfigPath(engine, cfg);

  let binary = null;
  let jar = null;
  if (engine === 'bsl-ls') {
    jar = cfg.jar;
    if (!jar || !existsSync(jar)) return unavailable('analyzer_unavailable');
  } else {
    const found = await ensureBslAnalyzer(cfg, (s) => process.stderr.write(s + '\n'));
    binary = found.path;
    if (!binary) {
      return unavailable(
        found.reason === 'unsupported_platform'
          ? 'analyzer_unsupported_platform'
          : found.reason === 'version_pin_without_checksum'
            ? 'analyzer_version_pin_unverifiable'
            : found.reason === 'launcher_checksum_mismatch'
              ? 'analyzer_checksum_mismatch'
              : 'analyzer_unavailable'
      );
    }
  }

  const version = engine === 'bsl-ls' ? null : engineVersion(binary);
  if (cfg.version && version && version !== cfg.version) {
    process.stderr.write(
      `Версия анализатора ${version} не совпадает с закреплённой ${cfg.version}.\n` +
        'Гейт с плавающей версией движка невоспроизводим: закрепите или обновите analyzer.version.\n'
    );
    return 2;
  }

  const sentinelResult = sentinel({ engine, binary, jar, configPath });

  if (args.sentinel) {
    out(`Часовой (${engine}${version ? '@' + version : ''}): ${sentinelResult.status}` +
      (sentinelResult.reason ? ` — ${sentinelResult.reason}` : ''));
    return sentinelResult.status === 'found' ? 0 : 2;
  }

  if (args.changed.length === 0) {
    process.stderr.write('Нечего проверять: не передан ни один --changed <файл>.\n');
    return 2;
  }

  const findings = [];
  const metrics = new Map();
  const unparsed = new Map();
  const seen = new Set();
  let orphans = [];
  let resolution = 'full';

  // Раскладка проекта важнее группировки по корням: если основная конфигурация есть, анализ
  // идёт от корня проекта с объявленным составом, и чужие имена разрешаются. Иначе получаем
  // треть находок из «не удалось разрешить ОбщегоНазначения» — измерено на боевом коде.
  const layout = engine === 'bsl-ls' ? { main: null, extensions: [] } : discoverLayout(root);

  if (layout.main) {
    const generated = join(root, '.claude', '.state', 'qg-analyzer.toml');
    mkdirSync(dirname(generated), { recursive: true });
    writeFileSync(generated, buildProjectConfig({ layout, root, baseConfig: configPath }), 'utf8');
    // В stderr, а не в stdout: с `--json` любая посторонняя строка ломает разбор вывода.
    process.stderr.write(
      `Состав проекта: основная конфигурация ${relative(root, layout.main).split(sep).join('/')}` +
        (layout.extensions.length ? `, расширений ${layout.extensions.length}` : '') +
        '\n'
    );
    const raw = runBslAnalyzer({ binary, root, changed: args.changed.map((f) => resolve(f)), configPath: generated });
    if (!raw.ok) {
      process.stderr.write(`Анализатор завершился неуспешно\n${raw.stderr.slice(0, 500)}\n`);
      return cfg.required ? 2 : 1;
    }
    const norm = normalizeBslAnalyzer(raw.stdout, { root, base: root });
    findings.push(...norm.findings);
    for (const [k, v] of norm.metrics) metrics.set(k, v);
    for (const [k, v] of norm.unparsed) unparsed.set(k, v);
    for (const f of norm.seen) seen.add(f);
  } else {
    const grouped = groupByConfigRoot(args.changed, root);
    orphans = grouped.orphans;
    resolution = grouped.groups.size ? 'extension-only' : 'full';
    for (const [cfgRoot, files] of grouped.groups) {
      const raw =
        engine === 'bsl-ls'
          ? runBslLs({ jar, root: cfgRoot, configPath })
          : runBslAnalyzer({ binary, root: cfgRoot, changed: files, configPath });
      if (!raw.ok) {
        process.stderr.write(`Анализатор завершился неуспешно на ${cfgRoot}\n${raw.stderr.slice(0, 500)}\n`);
        return cfg.required ? 2 : 1;
      }
      const norm =
        engine === 'bsl-ls'
          ? normalizeBslLs(raw.stdout, { root: cfgRoot, base: root, only: files })
          : normalizeBslAnalyzer(raw.stdout, { root: cfgRoot, base: root });
      findings.push(...norm.findings);
      for (const [k, v] of norm.metrics) metrics.set(k, v);
      for (const [k, v] of norm.unparsed) unparsed.set(k, v);
      for (const f of norm.seen || []) seen.add(f);
    }
  }

  // Внешние обработки и отчёты: их выгрузка не содержит `Configuration.xml`, поэтому ни одна
  // из веток выше их не видит — ни `[source]` сгенерированного конфига, ни группировка по
  // корням. Догоняем вторым проходом по корню каждой выгрузки и только по тем файлам, которых
  // движок ещё не встречал: повторный разбор уже проверенного файла удвоил бы находки.
  const notSeenYet = args.changed.filter((f) => !seen.has(toRelative(resolve(f), root, root)));
  const standalone = groupByStandaloneRoot(notSeenYet, root);
  for (const [artifactRoot, files] of standalone.groups) {
    const raw =
      engine === 'bsl-ls'
        ? runBslLs({ jar, root: artifactRoot, configPath })
        : runBslAnalyzer({ binary, root: artifactRoot, changed: files, configPath });
    if (!raw.ok) {
      process.stderr.write(
        `Анализатор завершился неуспешно на выгрузке ${relative(root, artifactRoot).split(sep).join('/')}
` +
          `${raw.stderr.slice(0, 500)}
`
      );
      return cfg.required ? 2 : 1;
    }
    const norm =
      engine === 'bsl-ls'
        ? normalizeBslLs(raw.stdout, { root: artifactRoot, base: root, only: files })
        : normalizeBslAnalyzer(raw.stdout, { root: artifactRoot, base: root });
    // Имена основной конфигурации и БСП в выгрузке внешней обработки отсутствуют физически —
    // ровно как у расширения, разобранного в одиночку. Понижаем те же коды по той же причине:
    // «не удалось разрешить» здесь относится к области анализа, а не к коду.
    for (const f of norm.findings) if (UNRESOLVED_WITHOUT_MAIN.has(f.code)) f.severity = 'info';
    findings.push(...norm.findings);
    for (const [k, v] of norm.metrics) metrics.set(k, v);
    for (const [k, v] of norm.unparsed) unparsed.set(k, v);
    for (const f of norm.seen || []) seen.add(f);
  }
  const standaloneRoots = standalone.groups.size;

  // Файл считается проверенным, только если движок его видел. Файлы вне корня конфигурации
  // (`orphans`) сюда попадают тем же путём — отдельно их перечислять не нужно.
  const unanalyzed = args.changed
    .map((f) => toRelative(resolve(f), root, root))
    .filter((f) => !seen.has(f));

  // Разбирали расширение в одиночку — значит имена основной конфигурации и БСП неразрешимы
  // по построению. Такие находки не удаляем (скрывать нельзя: среди них бывают и настоящие,
  // если неразрешимо имя из самого расширения), но понижаем до информационных, иначе они
  // забивают отчёт: на боевом расширении их было 523 из 2310.
  if (resolution === 'extension-only') {
    for (const f of findings) {
      if (UNRESOLVED_WITHOUT_MAIN.has(f.code)) f.severity = 'info';
    }
  }

  const evidence = toEvidence({ findings, sentinelResult, engine, version, unparsed, resolution, unanalyzed, standaloneRoots });

  // Отметка о прогоне ставится здесь, а не в `toEvidence`: та лишь строит строки и вызывается
  // кем угодно, включая тесты, — журнал же обязан значить «инструмент отработал по этим
  // файлам». Число непроверенных файлов уходит туда же: заявление о полноте, взятое из того
  // самого отчёта, который проверяется, ничего не подтверждает.
  recordRun({
    scope: 'static-analysis',
    tool: 'tools/analyzer-run.mjs',
    verdict: findings.length ? 'violation' : 'clean',
    // Пути, а не количество: покрытие сверяется с составом правки, а прогон по одному файлу
    // из десяти иначе закрывал бы заявление обо всех десяти.
    files: args.changed,
    unanalyzed: unanalyzed.length,
    root,
  });

  if (args.json) {
    out(JSON.stringify({ engine, version, sentinel: sentinelResult, resolution, findings, metrics: Object.fromEntries(metrics), unparsed: Object.fromEntries(unparsed), unanalyzed, evidence, orphans }, null, 2));
    return sentinelResult.status === 'found' ? 0 : 2;
  }

  if (!args.evidenceOnly) {
    if (orphans.length) {
      out(`Вне корня конфигурации (не анализировались): ${orphans.join(', ')}`);
    }
    if (resolution === 'extension-only') {
      out('Основная конфигурация не найдена: имена из неё и из БСП не разрешаются — неразрешённые вызовы к ним не выводятся как находки.');
    }
    if (unparsed.size) {
      out(`НЕ РАЗОБРАНО файлов: ${unparsed.size} — по ним не проверено ничего:`);
      for (const [f, n] of unparsed) out(`  ${f} (ошибок разбора: ${n})`);
    }
    if (unanalyzed.length) {
      out(`НЕ АНАЛИЗИРОВАЛИСЬ: ${unanalyzed.length} — движок не видел этих файлов, «чисто» к ним не относится:`);
      for (const f of unanalyzed) out(`  ${f}`);
    }
    out(`Движок: ${engine}${version ? ' ' + version : ''} | часовой: ${sentinelResult.status} | находок: ${findings.length}${versionSuffix()}`);
    report(findings, out, { all: args.all });
  }
  out('\n## quality evidence\n');
  for (const l of evidence) out(l);

  return sentinelResult.status === 'found' ? 0 : 2;

  function unavailable(reason) {
    for (const l of skipEvidence(reason)) out(l);
    if (cfg.required) {
      process.stderr.write(
        'Анализатор не найден, а analyzer.required=true: контур кода не может быть закрыт.\n'
      );
      return 2;
    }
    process.stderr.write('Анализатор не найден — контур кода пропущен с отметкой в следе.\n');
    return 1;
  }
}

if (process.argv[1]?.endsWith('analyzer-run.mjs')) {
  main(process.argv).then((code) => process.exit(code));
}
