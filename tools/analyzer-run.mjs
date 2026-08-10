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
 * Коды выхода: 0 — прогон состоялся, 1 — анализатор недоступен и не обязателен,
 * 2 — обязателен и недоступен, либо часовой не подтверждён.
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readManifest, installed as bootstrapInstalled, install as installAnalyzer } from './analyzer-bootstrap.mjs';
import { DEFAULTS, readConfig } from './config.mjs';

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

export function projectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
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

/**
 * Находит исполняемый файл bsl-analyzer.
 *
 * Версионированный файл (`bsl-analyzer-0.2.66`) на Windows лежит БЕЗ расширения и через
 * spawn не запускается — CreateProcess его не видит (проверено: ENOENT). Поэтому берём
 * рабочий бинарник, а версию не угадываем по имени, а СПРАШИВАЕМ у него самого и сверяем
 * с закреплённой. Лаунчер (`bsl-analyzer.exe` рядом с местом установки) не используем
 * никогда: он умеет молча обновиться посреди задачи, и гейт перестаёт быть воспроизводимым.
 */
export function resolveBslAnalyzer(cfg) {
  if (cfg.binary) return existsSync(cfg.binary) ? cfg.binary : null;

  // Первым делом — своя установка в каталоге данных плагина: её версия закреплена манифестом
  // и сверена по SHA-256. Установку лаунчера берём следом, чтобы не заставлять скачивать
  // шестьдесят мегабайт того, что у пользователя уже есть.
  try {
    const own = bootstrapInstalled(readManifest());
    if (own) return own;
  } catch {
    /* манифеста нет или он повреждён — работаем как раньше */
  }

  const dir = join(homedir(), '.bsl-analyzer', 'bin');
  if (!existsSync(dir)) return null;
  const app = join(dir, IS_WINDOWS ? 'bsl-analyzer-app.exe' : 'bsl-analyzer-app');
  if (existsSync(app)) return app;
  // На не-Windows версионированный файл запускается напрямую — там он и есть лучший выбор.
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
 */
export async function ensureBslAnalyzer(cfg, log = () => {}) {
  const found = resolveBslAnalyzer(cfg);
  if (found) return { path: found, installed: false };
  if (!cfg.autoInstall) return { path: null, installed: false, reason: 'autoinstall_disabled' };

  let manifest;
  try {
    manifest = readManifest();
  } catch {
    return { path: null, installed: false, reason: 'manifest_missing' };
  }
  // Закреплённая пользователем версия, отличная от манифестной, проверяться нечем: сумм для
  // неё у нас нет. Молча скачать другую версию значит подменить то, что он закрепил.
  if (cfg.version && cfg.version !== manifest.version) {
    return { path: null, installed: false, reason: 'version_pin_without_checksum' };
  }
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
  return { findings: clean, metrics, unparsed };
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
  return { findings, metrics: new Map() };
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
    rmSync(out, { recursive: true, force: true });
    // Промежуточный каталог убираем ТОЛЬКО пустым: параллельный прогон может держать в нём
    // свой отчёт, и рекурсивное удаление снесло бы чужой результат.
    if (readdirSync(stage).length === 0) rmSync(stage, { recursive: true, force: true });
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
export function toEvidence({ findings, sentinelResult, engine, version, unparsed = new Map(), resolution = null }) {
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
  // Разрешение чужих имён без основной конфигурации невозможно: об этом надо сказать, иначе
  // отсутствие находок по межфайловым связям читается как их отсутствие в коде.
  if (resolution === 'extension-only') {
    lines.push('[qg not_verified: dimension=cross-config-resolution, reason=main_configuration_absent]');
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
 * Печатает находки, сворачивая информационные в одну строку.
 *
 * Причина не в том, что они не важны, а в том, что на реальном модуле их вдесятеро больше
 * содержательных: `MagicNumber`, смешение латиницы и кириллицы в идентификаторах вида
 * `ВызватьHTTPМетод` (для 1С это норма, а диагностика отличить не может). Утопленная в них
 * находка 🟠 не будет прочитана. Ничего не скрывается: количество названо, коды попадают в
 * след, полный список доступен по `--all`.
 */
function report(findings, out, { all = false } = {}) {
  const shown = all ? findings : findings.filter((f) => f.severity !== 'info');
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
    const codes = [...new Set(findings.filter((f) => f.severity === 'info').map((f) => f.code))].sort();
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
    }
  }

  // Разбирали расширение в одиночку — значит имена основной конфигурации и БСП неразрешимы
  // по построению. Такие находки не удаляем (скрывать нельзя: среди них бывают и настоящие,
  // если неразрешимо имя из самого расширения), но понижаем до информационных, иначе они
  // забивают отчёт: на боевом расширении их было 523 из 2310.
  if (resolution === 'extension-only') {
    for (const f of findings) {
      if (UNRESOLVED_WITHOUT_MAIN.has(f.code)) f.severity = 'info';
    }
  }

  const evidence = toEvidence({ findings, sentinelResult, engine, version, unparsed, resolution });

  if (args.json) {
    out(JSON.stringify({ engine, version, sentinel: sentinelResult, resolution, findings, metrics: Object.fromEntries(metrics), unparsed: Object.fromEntries(unparsed), evidence, orphans }, null, 2));
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
    out(`Движок: ${engine}${version ? ' ' + version : ''} | часовой: ${sentinelResult.status} | находок: ${findings.length}`);
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
