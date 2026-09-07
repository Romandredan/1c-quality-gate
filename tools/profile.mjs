#!/usr/bin/env node
/**
 * Профиль изменения — три оси (объём, архетипы, сложность) и их разрешение в глубину
 * контуров, одним детерминированным вызовом.
 *
 * Зачем отдельный инструмент. Раньше три оси вычислялись моделью в голове по таблицам
 * `quality-gate/SKILL.md`: копия правил в промпте расходится с копией в документации при
 * первой же правке одной из них, а «C1, потому что показалось» неотличимо от «C1, потому
 * что посчитано». Здесь правила ровно одни — эта таблица и функция разрешения, — и их
 * читает и `gate.mjs plan` (печатает план прогона), и `evidence-validator.mjs` (сверяет
 * заявленный в отчёте профиль со посчитанным).
 *
 * Источник данных о правке — не рабочее дерево «как получится», а git: `git diff --numstat
 * HEAD` даёт число изменённых строк, `git diff -U0 HEAD` — сами добавленные строки, по ним
 * ищутся маркеры архетипов. Файл без истории в HEAD (только что созданный, ещё не
 * закоммиченный) — все его строки добавленные; то же самое приближение действует, если
 * git недоступен вовсе или файл лежит вне корня проекта — тогда взять для сравнения нечего,
 * и это явно помечается (`note: 'no_git'`), а не выдаётся за точный подсчёт.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import { DEFAULTS } from './config.mjs';

/**
 * Таблица архетипов кода — перенесена из таблицы «Ось 2» `quality-gate/SKILL.md` (столбцы
 * «Маркер в изменениях», «Мин. code», «Мин. arch») и колонки `refs` из `bsl-code-review/SKILL.md`
 * («Стандарты под архетип»). Единственный источник истины: `evidence-validator.mjs` проверяет
 * метки поля `archetypes` записи `scope` по своему списку `ARCHETYPES`, и тест в
 * `tests/run-tests.mjs` держит два списка равными — расхождение молча отключало бы
 * требование, привязанное к архетипу.
 *
 * `checklist` — разделы `checklist-code.md`, которые обязаны быть в чеклисте контура code
 * при сработавшем архетипе (нужно `gate.mjs plan`, Task 12); есть не у всех архетипов.
 *
 * `minArch` архетипа `form-module` — единственный условный: уровень 1 требуется только при
 * `loc > 400` изменённых строк (см. `resolveMinArch`), а не всегда, как у прочих архетипов.
 * Представлено объектом `{ when: 'loc>400', level: 1 }`, а не текстом-«магией»: строку
 * пришлось бы разбирать заново на каждый вызов, а форма объекта проверяется тестом один раз.
 */
export const ARCHETYPES = [
  { label: 'query', markers: [/Новый\s+Запрос/i, /ВЫБРАТЬ\s/i], minCode: 'L2', minArch: null, refs: ['bsl-query-optimization.md', 'bsl-query-reference.md'], checklist: [6, 7] },
  { label: 'transaction', markers: [/НачатьТранзакцию/i, /Заблокировать\s*\(/i, /БлокировкаДанных/i], minCode: 'L2', minArch: null, refs: ['bsl-coding-standards.md'], checklist: [8] },
  { label: 'record-set', markers: [/Записать\s*\(\s*Истина\s*\)/i, /СоздатьНаборЗаписей/i], minCode: 'L2', minArch: null, refs: [] },
  { label: 'object-event', markers: [/Процедура\s+(ПередЗаписью|ПриЗаписи|ОбработкаПроведения|ОбработкаУдаленияПроведения|ПередУдалением)\b/i], minCode: 'L2', minArch: 1, refs: [], checklist: [9] },
  { label: 'integration', markers: [/HTTPСоединение/i, /WSПрокси/i, /Новый\s+COMОбъект/i], minCode: 'L2', minArch: 1, refs: [], checklist: [15] },
  { label: 'rights', markers: [/УстановитьПривилегированныйРежим/i], pathMarker: /\/Roles\/[^/]+\/Ext\/Rights\.xml$/i, minCode: 'L2', minArch: 2, refs: [], checklist: [13, 14] },
  { label: 'cfe-patch', markers: [/&(Перед|После|Вместо|ИзменениеИКонтроль)\s*\(/i], minCode: 'L2', minArch: 1, refs: [] },
  { label: 'scheduled-job', markers: [/ФоновыеЗадания\./i, /РегламентныеЗадания\./i], pathMarker: /\/ScheduledJobs\//i, minCode: 'L2', minArch: null, refs: [], checklist: [12] },
  { label: 'client-server', markers: [/&НаСервере(БезКонтекста)?\b/i, /&НаКлиенте(НаСервере)?\b/i], minCode: 'L1', minArch: 1, refs: [], checklist: [10] },
  { label: 'user-dialog', markers: [/ПоказатьВопрос/i, /ВопросАсинх/i, /ОповещениеОЗавершении/i], minCode: 'L1', minArch: 1, refs: [] },
  { label: 'form-module', markers: [], pathMarker: /\/Forms?\/[^/]+\/(Ext\/Form\/)?Module\.bsl$/i, minCode: 'L1', minArch: { when: 'loc>400', level: 1 }, refs: ['bsl-form-module-rules.md'], checklist: [10] },
  { label: 'async-client', markers: [/\bАсинх\b/i, /\bЖдать\b/i, /Обещание/i], minCode: 'L1', minArch: null, refs: ['bsl-async.md'] },
  {
    label: 'new-common-module',
    markers: [],
    newFile: /\/CommonModules\/[^/]+\/Ext\/Module\.bsl$/i,
    // Голого нового Module.bsl недостаточно: тот же путь получает и правка расширения,
    // перехватывающего существующий базовый общий модуль впервые (Module.bsl расширения
    // тоже «без истории» в HEAD). Настоящий НОВЫЙ модуль приносит с собой декларацию объекта
    // — CommonModules/<Имя>.xml (или .mdo) — в том же составе правки; без неё это не
    // регистрация нового объекта метаданных, а такое же локальное изменение, как любое
    // другое, и не обязано тащить за собой C3/уровень arch 2.
    declarationFrom: (rel) => rel.replace(/\/Ext\/Module\.bsl$/i, ''),
    minCode: 'L1',
    minArch: 2,
    refs: ['bsl-coding-standards.md', 'bsp-common-modules.md'],
  },
  {
    label: 'new-metadata-object',
    markers: [],
    // `(^|\/)src\/` — не `\/src\/`: пути от корня проекта («src/cf/...», «src/cfe/...») не
    // получают ведущего слэша перед `src`, а буквальный `\/src\/` требовал бы, чтобы `src` был
    // вложен глубже (`.../src/...`), и на раскладке этого же плагина не срабатывал бы никогда.
    newFile: /(^|\/)src\/.*\.(xml|mdo)$/i,
    // Декларация общего модуля (`CommonModules/<Имя>.xml`) — та же корневая ксмл-декларация
    // объекта под `src/`, но у неё уже есть собственный, более лёгкий архетип
    // (`new-common-module`, `minArch: 2`) — без исключения оба сработали бы одновременно, и
    // более строгий минимум `new-metadata-object` (3) всегда перебивал бы более точный (2).
    newFileExclude: /\/CommonModules\/[^/]+\.xml$/i,
    minCode: 'L1',
    minArch: 3,
    refs: [],
  },
];

const CODE_RANK = { skip: 0, L1: 1, L2: 2 };

function codeMax(...values) {
  let best = 'skip';
  for (const v of values) {
    if (v && CODE_RANK[v] > CODE_RANK[best]) best = v;
  }
  return best;
}

/** Уровень `arch` архетипа. `form-module` его вычисляет по `loc`, остальные хранят число (или null). */
function resolveMinArch(archetype, loc) {
  const m = archetype.minArch;
  if (m === null || m === undefined) return null;
  if (typeof m === 'object') return loc > (m.when === 'loc>400' ? 400 : 0) ? m.level : null;
  return Number(m);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Архетипы проекта (`archetypes.custom` настройки) в той же форме, что и встроенные. */
function customArchetypes(config) {
  const list = config?.archetypes?.custom;
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && a.name)
    .map((a) => ({
      label: String(a.name),
      markers: Array.isArray(a.markers) ? a.markers.map((m) => new RegExp(escapeRegExp(m), 'i')) : [],
      minCode: a.minCode === 'L2' ? 'L2' : 'L1',
      minArch: a.minArch === undefined || a.minArch === null || a.minArch === '' ? null : Number(a.minArch),
      refs: [],
    }));
}

function normalize(p) {
  return String(p).split(sep).join('/');
}

/** Есть ли рабочее дерево git, из которого стоит вообще пробовать читать историю. */
function gitAvailable(root) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  return !r.error && r.status === 0;
}

/** Текущее содержимое файла построчно, без BOM и без одного завершающего перевода строки. */
function currentLines(absPath) {
  if (!existsSync(absPath)) return [];
  let text = readFileSync(absPath, 'utf8').replace(/^﻿/, '');
  text = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return text === '' ? [] : text.split('\n');
}

/**
 * Изменения одного файла: добавленные/удалённые строки и сами добавленные строки (для
 * поиска маркеров). `isNew` — файла не было в HEAD (значит все его строки добавленные);
 * `note: 'no_git'` — сравнивать было не с чем: git недоступен либо файл вне корня проекта.
 */
function diffFile(file, root, gitOk) {
  const abs = resolvePath(root, file);
  const rel = normalize(relative(resolvePath(root), abs));

  if (!gitOk || !rel || rel.startsWith('..')) {
    const lines = currentLines(abs);
    return { rel: rel || normalize(file), added: lines.length, removed: 0, addedLines: lines, isNew: true, note: 'no_git' };
  }

  const head = spawnSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const hasHistory = !head.error && head.status === 0;
  if (!hasHistory) {
    const lines = currentLines(abs);
    return { rel, added: lines.length, removed: 0, addedLines: lines, isNew: true };
  }

  let added = 0;
  let removed = 0;
  const num = spawnSync('git', ['diff', '--numstat', 'HEAD', '--', rel], { cwd: root, encoding: 'utf8' });
  if (!num.error && num.status === 0) {
    const firstLine = String(num.stdout || '').trim().split('\n')[0] || '';
    const m = firstLine.match(/^(\d+|-)\s+(\d+|-)\s+/);
    if (m) {
      added = m[1] === '-' ? 0 : Number(m[1]);
      removed = m[2] === '-' ? 0 : Number(m[2]);
    }
  }

  const addedLines = [];
  const u = spawnSync('git', ['diff', '-U0', 'HEAD', '--', rel], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (!u.error && u.status === 0) {
    for (const line of String(u.stdout || '').split('\n')) {
      if (line.startsWith('+++')) continue;
      if (line.startsWith('+')) addedLines.push(line.slice(1));
    }
  }
  return { rel, added, removed, addedLines, isNew: false };
}

/**
 * Сложность изменённых методов — из метрик `analyzer-run.mjs --json` (`metrics[file].functions`).
 * Инструмент их не запускает сам: подсчёт метрик — работа анализатора, а не этого модуля.
 * Форма `functions[i]` у самого анализатора не задокументирована жёстко, поэтому поля
 * читаются по нескольким правдоподобным именам и молча пропускаются, если ни одно не нашлось —
 * приближение объявлено, а не выдаётся за точный разбор (см. отчёт по задаче).
 */
function complexityFindings(files, metrics, cfg) {
  const labels = [];
  const seen = new Set();
  const add = (label) => {
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  };
  if (!metrics || typeof metrics !== 'object') return labels;

  for (const file of files) {
    const rec = metrics[file] || metrics[normalize(file)];
    const fns = rec && Array.isArray(rec.functions) ? rec.functions : [];
    for (const fn of fns) {
      const nesting = fn.nesting ?? fn.nestingDepth ?? fn.max_nesting ?? fn.maxNesting;
      const lines = fn.lines ?? fn.lineCount ?? fn.line_count;
      const params = Array.isArray(fn.parameters)
        ? fn.parameters.length
        : (fn.params ?? fn.paramCount ?? fn.param_count);
      if (Number.isFinite(nesting) && nesting >= cfg.maxNesting) add(`nesting:${nesting}`);
      if (Number.isFinite(lines) && lines > cfg.maxMethodLines) add(`method-lines:${lines}`);
      if (Number.isFinite(params) && params >= cfg.maxParams) add(`params:${params}`);
    }
  }
  return labels;
}

/**
 * `config=` записи `scope`: `default`, если ни одна секция настройки не отличается от
 * умолчаний плагина (`DEFAULTS` из `config.mjs`), иначе `custom:<секция>[+<секция>]`.
 *
 * Не то же самое, что `evidenceValue()` из `config.mjs`: та смотрит на ИСТОЧНИК каждого
 * значения (файл/окружение/умолчание) через `resolve()`, а сюда приходят уже разрешённые
 * значения без источника (ровно форма `readConfig()`, без `.sources`) — так их передаёт тест
 * задачи и так их удобно собирать вызывающему (`gate.mjs plan`, Task 12) из `readConfig()`.
 * Секция, отсутствующая в переданном `config`, считается умолчанием: `computeProfile`
 * принимает частичный объект (см. тест) и не обязан достраивать его до полного перед вызовом.
 * Единственный случай, где это расходится с `evidenceValue()`, — секция, для которой файл
 * настройки явно повторил значение умолчания: `evidenceValue()` всё равно назвал бы её
 * переопределённой (переопределение — это факт «значение пришло из файла», а не «значение
 * отличается»), а сравнение по значению здесь этого не заметит. Расхождение неопасно: в
 * строгом режиме `evidence-validator.mjs` сверяет отметку `config=` не с этим инструментом, а
 * с живой настройкой проекта (`evidenceValue(resolveConfig(root))`) — источник истины один.
 */
function configStamp(config) {
  const changed = [];
  for (const section of Object.keys(DEFAULTS)) {
    const provided = config?.[section];
    if (provided === undefined) continue;
    if (JSON.stringify(provided) !== JSON.stringify(DEFAULTS[section])) changed.push(section);
  }
  return changed.length ? `custom:${changed.join('+')}` : 'default';
}

/**
 * Считает профиль изменения по трём осям и разрешает его в глубину контуров `code`/`arch`
 * (плюс `xml`/`hygiene` — по матрице объёма из «Шага 2» `quality-gate/SKILL.md`).
 *
 * `files` — пути от корня проекта (`root`), как их печатает `gate.mjs status`. `config` —
 * разрешённые значения настройки (форма `readConfig()`: секции `volume`, `complexity`,
 * `archetypes.custom`; остальные секции не читаются профилем, но участвуют в `configStamp`,
 * если переданы). `metrics` — `metrics` из `analyzer-run.mjs --json` (`{}`, если анализатор
 * не запускался — тогда сложность считается пустой, а не приближается вручную).
 */
export function computeProfile({ files, root, config, metrics }) {
  const cfg = {
    c1MaxFiles: config?.volume?.c1MaxFiles ?? DEFAULTS.volume.c1MaxFiles,
    c1MaxLines: config?.volume?.c1MaxLines ?? DEFAULTS.volume.c1MaxLines,
    maxNesting: config?.complexity?.maxNesting ?? DEFAULTS.complexity.maxNesting,
    maxMethodLines: config?.complexity?.maxMethodLines ?? DEFAULTS.complexity.maxMethodLines,
    maxParams: config?.complexity?.maxParams ?? DEFAULTS.complexity.maxParams,
  };

  const gitOk = gitAvailable(root);
  const diffs = files.map((f) => ({ file: f, ...diffFile(f, root, gitOk) }));

  const added = diffs.reduce((s, d) => s + d.added, 0);
  const removed = diffs.reduce((s, d) => s + d.removed, 0);
  const allAddedLines = diffs.flatMap((d) => d.addedLines);
  const addedText = allAddedLines.join('\n');
  const noGit = diffs.some((d) => d.note === 'no_git');

  // --- ось 2: архетипы --------------------------------------------------------
  const dirsPresent = new Set(diffs.map((d) => normalize(d.rel).toLowerCase()));
  const catalog = [...ARCHETYPES, ...customArchetypes(config)];
  const fired = [];
  for (const a of catalog) {
    const byMarker = a.markers && a.markers.length > 0 && a.markers.some((re) => re.test(addedText));
    const byPath = a.pathMarker ? diffs.some((d) => a.pathMarker.test(d.rel)) : false;
    const byNewFile = a.newFile
      ? diffs.some((d) => {
          if (!d.isNew || !a.newFile.test(d.rel)) return false;
          if (a.newFileExclude && a.newFileExclude.test(d.rel)) return false;
          if (!a.declarationFrom) return true;
          const base = a.declarationFrom(d.rel).toLowerCase();
          return dirsPresent.has(`${base}.xml`) || dirsPresent.has(`${base}.mdo`);
        })
      : false;
    if (byMarker || byPath || byNewFile) fired.push(a);
  }
  const archetypeLabels = fired.map((a) => a.label);

  // --- ось 3: сложность --------------------------------------------------------
  const complexity = complexityFindings(files, metrics, cfg);
  const complexityFired = complexity.length > 0;

  // --- ось 1: объём -------------------------------------------------------------
  const cosmeticOnly = allAddedLines.every((l) => l.trim() === '' || l.trim().startsWith('//'));
  // Новый модуль или объект метаданных выводит правку из C1 БЕЗУСЛОВНО — так прямо
  // сказано в определении C1 (`SKILL.md`, «Ось 1»): «нет новых экспортов, изменённых
  // сигнатур, новых модулей и объектов метаданных». Поэтому проверка идёт раньше размера:
  // однострочный новый общий модуль — всё равно C3, а не C1 по числу строк.
  const newModuleOrMetadata = archetypeLabels.includes('new-metadata-object') || archetypeLabels.includes('new-common-module');
  let volume;
  if (cosmeticOnly) volume = 'C0';
  else if (newModuleOrMetadata) volume = 'C3';
  else if (files.length <= cfg.c1MaxFiles && added + removed <= cfg.c1MaxLines) volume = 'C1';
  else volume = 'C2';

  const totalLoc = added + removed;

  // --- разрешение code/arch: max(объём, максимум минимумов архетипов, сложность) ----------
  const codeBase = volume === 'C0' ? 'skip' : volume === 'C1' ? 'L1' : 'L2';

  const codeFromArchetypes = codeMax(...fired.map((a) => a.minCode));
  const archFromArchetypes = fired
    .map((a) => resolveMinArch(a, totalLoc))
    .filter((v) => v !== null);

  const codeFromComplexity = complexityFired ? 'L2' : 'skip';
  const archFromComplexity = complexityFired ? 1 : null;

  const resolvedCode = codeMax(codeBase, codeFromArchetypes, codeFromComplexity);
  // У `arch`, в отличие от `code`, объём САМ ПО СЕБЕ не даёт минимума. Ячейка C2 таблицы
  // «Ось 1» («ур. 1-2») — это диапазон, в котором arch работает, КОГДА его поднял архетип
  // или сложность, а не гарантированный пол при любом C2: живые примеры следа (например,
  // task-9-report.md, `evidence-format.md`) показывают `arch:skip` ровно при `volume=C2` без
  // сработавших архетипов. Жёсткий пол в 3 при C3 к тому же перебивал бы собственный
  // `minArch: 2` архетипа `new-common-module`, из-за которого правка и стала C3, — то есть
  // противоречил бы таблице архетипов, которую этот же модуль переносит дословно.
  const archCandidates = [...archFromArchetypes, archFromComplexity].filter((v) => v !== null);
  const resolvedArch = archCandidates.length ? Math.max(...archCandidates) : null;

  const hasXmlChange = files.some((f) => /\.xml$/i.test(f));
  const resolvedXml =
    volume === 'C0' ? 'skip' : !hasXmlChange ? 'n/a' : volume === 'C1' ? 'changed' : volume === 'C2' ? 'changed+registration' : 'full';
  const resolvedHygiene = 'full';

  // --- driver: что именно подняло глубину ------------------------------------
  let driver;
  if (complexityFired && CODE_RANK[codeFromComplexity] > Math.max(CODE_RANK[codeBase], CODE_RANK[codeFromArchetypes])) {
    driver = `complexity:${complexity[0].split(':')[0]}`;
  } else if (fired.length > 0 && CODE_RANK[codeFromArchetypes] > CODE_RANK[codeBase]) {
    const top = fired.find((a) => a.minCode === resolvedCode) || fired[0];
    driver = `archetype:${top.label}`;
  } else {
    driver = 'volume';
  }

  const resolved = { code: resolvedCode, arch: resolvedArch, xml: resolvedXml, hygiene: resolvedHygiene };

  const archetypesText = archetypeLabels.length ? archetypeLabels.join(',') : 'none';
  const complexityText = complexity.length ? complexity.join(',') : 'none';
  const archText = resolvedArch === null ? 'skip' : String(resolvedArch);
  const scopeLine =
    `[qg scope: volume=${volume}, files=${files.length}, loc=+${added}/-${removed}, ` +
    `archetypes=[${archetypesText}], complexity=[${complexityText}], driver=${driver}, ` +
    `resolved=code:${resolvedCode}|arch:${archText}|xml:${resolvedXml}|hygiene:${resolvedHygiene}, ` +
    `config=${configStamp(config)}]`;

  const result = {
    volume,
    files: files.length,
    loc: { added, removed },
    archetypes: archetypeLabels,
    complexity,
    driver,
    resolved,
    scopeLine,
  };
  if (noGit) result.note = 'no_git';
  return result;
}
