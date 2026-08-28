#!/usr/bin/env node
/**
 * Проверка целостности пакета плагина.
 *
 * Ловит то, что иначе проверяется руками и поэтому рано или поздно не проверяется:
 * битые ссылки на файлы references, рассинхрон производной карты с источником,
 * следы проектных данных, невалидные манифесты.
 *
 * Запускается в CI на каждый push и локально перед коммитом:
 *   node tools/validate-package.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { TOOL_BACKED, RENAMED, isKnownScope } from './evidence-scopes.mjs';

/**
 * Корень проверяемого пакета. По умолчанию — сам плагин; `--root` нужен тестам, чтобы
 * прогнать проверки на заведомо испорченном дереве. Без этого правила валидатора
 * проверялись бы только фактом «на нашем репозитории молчит», а молчание сломанной
 * проверки неотличимо от молчания исправной.
 */
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg === -1 ? join(dirname(fileURLToPath(import.meta.url)), '..') : process.argv[rootArg + 1];

const problems = [];
const fail = (where, message) => problems.push({ severity: 'error', where, message });
const warn = (where, message) => problems.push({ severity: 'warn', where, message });

const SKIP_DIRS = new Set(['.git', 'node_modules', '.remember', '.state', '.qg-analyzer']);

/** Предел размера SKILL.md: навык грузится целиком, и его объём — это контекст на каждый прогон. */
const SKILL_SIZE_LIMIT = 32_768;

/** Модели субагентов. Опечатка здесь не диагностируется средой — субагент просто не поднимется. */
const AGENT_MODELS = new Set(['haiku', 'sonnet', 'opus', 'inherit']);

/** Все файлы репозитория, кроме служебных. Запасной обход, когда git недоступен. */
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/**
 * Состав пакета. Источник истины — git: файлы под версией плюс ещё не закоммиченные,
 * но не игнорируемые. Рядом с репозиторием живут чужие рабочие каталоги (история сессий
 * других плагинов, состояние гейта), и обход дерева выдавал находки о них — шум о файлах,
 * которые в пакет не входят.
 *
 * Незакоммиченные включены намеренно: утечку проектных данных надо ловить ДО коммита,
 * иначе проверка бесполезна ровно в тот момент, когда нужна.
 */
function packageFiles() {
  try {
    // -z обязателен: без него git экранирует не-ASCII имена (core.quotepath), и файлы с
    // кириллицей в имени — а это все фикстуры метаданных — молча выпадают из проверки.
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const list = out.split('\0').filter(Boolean).map((p) => join(ROOT, p)).filter((p) => existsSync(p));
    if (list.length) return list;
  } catch {
    // git недоступен — пакет распакован из архива; обходим дерево сами
  }
  return walk(ROOT);
}

const files = packageFiles();
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

// --- 1. Манифесты ------------------------------------------------------------
const pluginJson = join(ROOT, '.claude-plugin', 'plugin.json');
const marketJson = join(ROOT, '.claude-plugin', 'marketplace.json');

let plugin = null;
let market = null;
for (const [path, label] of [
  [pluginJson, 'plugin.json'],
  [marketJson, 'marketplace.json'],
]) {
  if (!existsSync(path)) {
    fail(label, 'манифест отсутствует');
    continue;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (label === 'plugin.json') plugin = parsed;
    else market = parsed;
  } catch (e) {
    fail(label, `невалидный JSON: ${e.message}`);
  }
}

if (plugin) {
  for (const field of ['name', 'description', 'version']) {
    if (!plugin[field]) fail('plugin.json', `нет обязательного поля "${field}"`);
  }
  // Без version плагин ставится в каталог "unknown" и пиннится по хэшу коммита —
  // получается неуправляемый зоопарк параллельных установок.
  if (plugin.version && !/^\d+\.\d+\.\d+$/.test(plugin.version)) {
    fail('plugin.json', `version "${plugin.version}" не в формате semver`);
  }
}

if (plugin && market) {
  const entry = (market.plugins || []).find((p) => p.name === plugin.name);
  if (!entry) {
    fail('marketplace.json', `плагин "${plugin.name}" не объявлен в marketplace`);
  } else if (entry.version !== plugin.version) {
    fail('marketplace.json', `версия ${entry.version} расходится с plugin.json (${plugin.version})`);
  }

  // Запись пиннится на тег релиза: main остаётся рабочей веткой, а пользователю едет только
  // помеченное дерево. Поднятая версия при забытом ref означает, что пользователь получит
  // старый код под новым номером — ровно та ложная зелень, против которой написан весь плагин.
  const src = entry && entry.source;
  if (src && typeof src === 'object' && src.source === 'github') {
    const expected = `v${plugin.version}`;
    if (src.ref !== expected) {
      fail('marketplace.json', `source.ref "${src.ref}" расходится с версией плагина (ожидается "${expected}")`);
    }
  }
}

// --- 1а. Версия и точка входа для OpenCode ------------------------------------
// package.json в корне — манифест установки для OpenCode: по нему пакет ставится из
// репозитория и по нему же находится файл плагина. Третий манифест — третье место, где
// версия может отстать, поэтому сверяется тем же правилом, что и marketplace.json.
if (plugin) {
  const pkgPath = join(ROOT, 'package.json');
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    fail('package.json', 'нет в корне или не читается: без него OpenCode пакет не поставит');
  }
  if (pkg) {
    if (pkg.version !== plugin.version) {
      fail('package.json', `версия ${pkg.version} расходится с plugin.json (${plugin.version})`);
    }
    // type: module — не косметика: файл плагина .js, и без него Node 20 падает на import
    // ещё до первого вызова хука.
    if (pkg.type !== 'module') {
      fail('package.json', 'нет "type": "module": .js-плагин не загрузится на Node 20');
    }
    if (!pkg.main || !existsSync(join(ROOT, pkg.main))) {
      fail('package.json', `main "${pkg.main}" не указывает на существующий файл`);
    }
    // files отсекает часть пакета при установке. Навыки, инструменты и hooks обязаны
    // доехать целиком, иначе гейт установится без того, чем проверяет.
    if (pkg.files) {
      fail('package.json', 'поле files урезает пакет: навыки и инструменты не доедут');
    }
  }
}

// --- 1в. Строка установки OpenCode пиннится на ту же версию -------------------
// Тег живёт ещё и в прозе: в README, в docs/OPENCODE.md и в примере конфигурации. Прозу
// ни один манифест не сверяет, поэтому при выпуске она молча остаётся на старой версии —
// и два харнесса ставят разный код. Проверяем каждую строку установки.
if (plugin) {
  const expected = `#v${plugin.version}`;
  const spec = /1c-quality-gate@git\+https:\/\/github\.com\/[^"'\s]+/g;
  for (const rel of ['README.md', join('docs', 'OPENCODE.md'), join('opencode', 'opencode.json.example')]) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const found = text.match(spec) || [];
    if (!found.length) {
      fail(rel, 'нет строки установки OpenCode: пользователю неоткуда взять пакет');
      continue;
    }
    for (const s of found) {
      if (!s.endsWith(expected)) {
        fail(rel, `строка установки "${s}" не закреплена на ${expected}`);
      }
    }
  }
}

// --- 1б. Тег релиза совпадает с версией --------------------------------------
// Проверка живёт только в сборке по тегу: GITHUB_REF_TYPE выставляет CI. Локально переменной
// нет, и проверка молчит — сверять нечего.
if (plugin && process.env.GITHUB_REF_TYPE === 'tag') {
  const tag = process.env.GITHUB_REF_NAME || '';
  const expected = `v${plugin.version}`;
  if (tag !== expected) {
    fail('тег релиза', `тег ${tag} расходится с версией в plugin.json (ожидается ${expected})`);
  }
}

// --- 2. Все JSON валидны -----------------------------------------------------
for (const f of files.filter((f) => f.endsWith('.json'))) {
  try {
    JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    fail(rel(f), `невалидный JSON: ${e.message}`);
  }
}

// --- 3. Синтаксис скриптов ---------------------------------------------------
for (const f of files.filter((f) => f.endsWith('.mjs'))) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    fail(rel(f), `синтаксическая ошибка: ${String(e.stderr || e.message).split('\n')[0]}`);
  }
}

// --- 4. Навыки: frontmatter --------------------------------------------------
const skillFiles = files.filter((f) => f.endsWith('SKILL.md'));
if (skillFiles.length === 0) fail('skills/', 'не найдено ни одного SKILL.md');

for (const f of skillFiles) {
  const text = readFileSync(f, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) {
    fail(rel(f), 'нет frontmatter');
    continue;
  }
  const fm = m[1];
  if (!/^name:\s*\S/m.test(fm)) fail(rel(f), 'во frontmatter нет поля name');
  if (!/^description:/m.test(fm)) fail(rel(f), 'во frontmatter нет поля description');

  // Поля чужого формата молча не работают в Claude Code: навык просто не активируется
  // по маске файлов, и это неотличимо от «правило не сработало».
  for (const stale of ['inclusion:', 'fileMatchPattern:']) {
    if (fm.includes(stale)) fail(rel(f), `поле "${stale}" не поддерживается — триггер должен жить в хуке`);
  }

  const dirName = rel(f).split('/').slice(-2)[0];
  const nameMatch = fm.match(/^name:\s*(\S+)/m);
  if (nameMatch && nameMatch[1] !== dirName) {
    fail(rel(f), `name "${nameMatch[1]}" не совпадает с именем каталога "${dirName}"`);
  }

  // Навык грузится целиком, и самый крупный из них — оркестратор — попадает в контекст при
  // каждом снятии гейта. Предел не запрет, а сигнал: если файл перерос его, содержимое пора
  // выносить в references, которые читаются по необходимости.
  const size = Buffer.byteLength(text, 'utf8');
  if (size > SKILL_SIZE_LIMIT) {
    fail(rel(f), `${size} байт при пределе ${SKILL_SIZE_LIMIT}: вынеси часть в references/`);
  }
}

// --- 4б. Субагенты и команды: frontmatter ------------------------------------
// Проверялись только навыки. Между тем субагент с испорченным frontmatter просто не
// поднимается, а контуры трактуют «субагента нет в среде» как законную деградацию с записью
// skipped: дефект пакета выглядит как штатное окружение пользователя и не расследуется.
for (const f of files.filter((p) => /(^|\/)agents\/[^/]+\.md$/.test(rel(p)))) {
  const text = readFileSync(f, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) {
    fail(rel(f), 'нет frontmatter');
    continue;
  }
  const fm = m[1];
  for (const key of ['name', 'description', 'tools']) {
    if (!new RegExp(`^${key}:\\s*\\S`, 'm').test(fm)) fail(rel(f), `во frontmatter нет поля ${key}`);
  }

  const fileName = rel(f).split('/').pop().replace(/\.md$/, '');
  const nameMatch = fm.match(/^name:\s*(\S+)/m);
  if (nameMatch && nameMatch[1] !== fileName) {
    fail(rel(f), `name "${nameMatch[1]}" не совпадает с именем файла "${fileName}"`);
  }

  const modelMatch = fm.match(/^model:\s*(\S+)/m);
  if (modelMatch && !AGENT_MODELS.has(modelMatch[1])) {
    fail(rel(f), `model "${modelMatch[1]}" вне набора ${[...AGENT_MODELS].join(', ')}`);
  }
}

// Отдельного каталога субагентов под OpenCode нет намеренно: те же файлы agents/ читает
// плагин, переводя frontmatter в opencode/plugin/registry.js. Копия расходится с оригиналом
// при первой правке одной из них, и расходится молча.
if (existsSync(join(ROOT, 'opencode', 'agents'))) {
  fail('opencode/agents/', 'копия субагентов: источник один — agents/, перевод в registry.js');
}

for (const f of files.filter((p) => /(^|\/)commands\/[^/]+\.md$/.test(rel(p)))) {
  const text = readFileSync(f, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) {
    fail(rel(f), 'нет frontmatter');
    continue;
  }
  const fm = m[1];
  if (!/^description:\s*\S/m.test(fm)) fail(rel(f), 'во frontmatter нет поля description');

  // Имена полей у команд пишутся через дефис. camelCase из других сред не читается: команда
  // запускается, но без подсказки об аргументах и без объявленных инструментов.
  for (const [stale, correct] of [['argumentHint', 'argument-hint'], ['allowedTools', 'allowed-tools']]) {
    if (new RegExp(`^${stale}:`, 'm').test(fm)) fail(rel(f), `поле "${stale}" не читается — правильно "${correct}"`);
  }
}

// --- 5. Ссылки на файлы references -------------------------------------------
for (const f of files.filter((f) => f.endsWith('.md'))) {
  const text = readFileSync(f, 'utf8');
  const dir = dirname(f);
  const re = /(?:^|[\s(`])((?:\.\.\/)?[a-z0-9-]+\/[a-z0-9.-]+\.(?:md|json|mjs|py))/gim;
  let m;
  while ((m = re.exec(text)) !== null) {
    const target = m[1];
    if (target.startsWith('http')) continue;
    const candidates = [join(dir, target), join(ROOT, target)];
    if (!candidates.some(existsSync)) {
      // Ссылки на файлы проекта пользователя (не плагина) не проверяем.
      if (/^(src|docs|openspec|tools\/xml)\//.test(target)) continue;
      // Раньше это было предупреждением, а предупреждения не влияли на код возврата: проверка
      // существовала, но ничего не запрещала, и битая ссылка спокойно уезжала в релиз.
      fail(rel(f), `ссылка на несуществующий файл: ${target}`);
    }
  }
}

// --- 5б. Ссылки на разделы других навыков ------------------------------------
// Форма «раздел «Название» навыка `имя`» — единственная в своде, где название раздела
// указывает на ЧУЖОЙ файл. Переименование заголовка её не ломает заметно: инструкция
// продолжает выглядеть исправной и просто ведёт в никуда.
const headingsCache = new Map();
function headingsOf(path) {
  if (!headingsCache.has(path)) {
    const set = new Set();
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const h = line.match(/^#{1,6}\s+(.+?)\s*$/);
        if (h) set.add(h[1].replace(/[`*_]/g, '').trim());
      }
    }
    headingsCache.set(path, set);
  }
  return headingsCache.get(path);
}

for (const f of files.filter((p) => p.endsWith('.md'))) {
  const text = readFileSync(f, 'utf8');
  // Разделители пишутся как `[\s>]`, а не `\s`: ссылка может быть внутри цитаты и перенесена
  // на следующую строку, где строка начинается с «> ». Без этого проверка находит дефект в
  // исправной ссылке — ровно та ложная находка, которой быть не должно.
  const re = /раздел[а-я]*[\s>]+«([^»]+)»[\s>]+(?:в[\s>]+)?навыка?[а-я]*[\s>]+`([a-z0-9-]+)`/giu;
  let m;
  while ((m = re.exec(text)) !== null) {
    const heading = m[1].replace(/[\s>]+/g, ' ').trim();
    const skill = m[2];
    const target = join(ROOT, 'skills', skill, 'SKILL.md');
    if (!existsSync(target)) {
      fail(rel(f), `ссылка на раздел несуществующего навыка: ${skill}`);
      continue;
    }
    // Заголовок может нести уточнение в скобках: «Путь к инструментам плагина (`$QG`)».
    const found = [...headingsOf(target)].some((h) => h === heading || h.startsWith(`${heading} (`));
    if (!found) fail(rel(f), `в навыке ${skill} нет раздела «${heading}»`);
  }
}

// --- 5в. Имена проверок в документации — из словаря --------------------------
//
// Расхождение этого рода не читается как ошибка: пример в навыке выглядит правильным, и
// модель добросовестно его копирует. Так в отчёты попадали `static-diagnostics` и
// `lsp-diagnostics` — имена, которых нет ни в одном инструменте. Валидатор следа их теперь
// отвергает, но узнать об этом на живом прогоне дороже, чем здесь.
{
  // Фикстуры тестов исключены намеренно: заведомо испорченный след — их содержимое, а не
  // дефект. Валидатор следа обязан на них ругаться, этот — нет.
  const FIXTURES = join(ROOT, 'tests', 'fixtures') + sep;
  const docs = files.filter((f) => f.endsWith('.md') && !f.startsWith(FIXTURES));
  for (const f of docs) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/scope=([a-z0-9-]+)/g)) {
      const scope = m[1];
      if (isKnownScope(scope)) continue;
      const hint = RENAMED[scope] ? ` — переименован в «${RENAMED[scope]}»` : '';
      fail(rel(f), `scope=${scope} отсутствует в словаре проверок (tools/evidence-scopes.mjs)${hint}`);
    }
  }
}

// --- 5г. У каждой проверки с инструментом инструмент существует ---------------
for (const [scope, tool] of Object.entries(TOOL_BACKED)) {
  if (!existsSync(join(ROOT, tool))) {
    fail('evidence-scopes.mjs', `проверка ${scope} ссылается на несуществующий инструмент ${tool}`);
  }
}

// --- 6. Производная карта синхронна с источником -----------------------------
const signsJson = join(ROOT, 'skills', 'bsl-architecture-review', 'references', 'signs-map.json');
const signsMd = join(ROOT, 'skills', 'bsl-architecture-review', 'references', 'signs-map.md');
if (existsSync(signsJson) && existsSync(signsMd)) {
  try {
    const map = JSON.parse(readFileSync(signsJson, 'utf8'));
    const md = readFileSync(signsMd, 'utf8');
    for (const sign of map.signs || []) {
      if (!md.includes(sign.id)) {
        fail('signs-map.md', `признак ${sign.id} есть в источнике, но отсутствует в производной карте — перегенерируй`);
      }
    }
    for (const p of (map.signs || []).flatMap((s) => s.principles || [])) {
      if (!/^https:\/\/[^\s()]+$/.test(p.url)) fail('signs-map.json', `битый URL: ${p.url}`);
      if (/\(\[/.test(p.title)) fail('signs-map.json', `в заголовке остался мусор разметки: ${p.title}`);
    }
  } catch (e) {
    fail('signs-map.json', `не разобран: ${e.message}`);
  }
}

// --- 7. Следы проектных данных -----------------------------------------------
// Плагин публичный: имена систем, полей контрактов и модулей конкретного проекта
// не должны попадать в артефакт.
const LEAK_PATTERNS = [
  /\bап_[А-Яа-яЁё]/,
  /\bSbSh_/,
  /\bсм_[А-Яа-яЁё]/,
  /АккордПост/i,
  /TradeProd/i,
  /Сбершоп|СберШоп/i,
  /VoucherAPI/i,
  /СберСпасибо/i,
  /\bzdoc_id\b|\border_row_id\b|\bidoc_id\b|\border_state\b|\bparcel_state\b/,
  /ЦепочкаПродажиЗавершена|СостоянияЗаказовОтправлений|КлассифицироватьТерминал/,
  /[A-Z]:\\Users\\/,
  /H:\\\.GitHub/,
];
// Список ловит ИЗВЕСТНЫЕ имена и не ловит доменные термины, под которые образца не заведено:
// однажды так в документ уехали имена объектов чужой конфигурации вместе с фрагментом
// запроса. Перед публичным пушем документы читает человек — grep это не заменяет, а удешевляет.
//
// Сам этот файл содержит перечисленные образцы как данные и из проверки исключается —
// иначе валидатор находит утечку в собственном списке образцов.
const SELF = rel(fileURLToPath(import.meta.url));

for (const f of files.filter((f) => /\.(md|mjs|json|py|yml)$/.test(f))) {
  const relPath = rel(f);
  if (relPath.startsWith('.git/') || relPath === SELF) continue;
  const text = readFileSync(f, 'utf8');
  for (const re of LEAK_PATTERNS) {
    const hit = text.match(re);
    if (hit) fail(relPath, `след проектных данных: "${hit[0]}"`);
  }
}

// --- Итог --------------------------------------------------------------------
const errors = problems.filter((p) => p.severity === 'error');
const warns = problems.filter((p) => p.severity === 'warn');

for (const p of problems) {
  process.stdout.write(`${p.severity === 'error' ? 'ОШИБКА' : 'ВНИМАНИЕ'} ${p.where} — ${p.message}\n`);
}
process.stdout.write(
  `\nПроверено файлов: ${files.length}, навыков: ${skillFiles.length}. ` +
    `Ошибок: ${errors.length}, предупреждений: ${warns.length}.\n`
);

process.exit(errors.length ? 1 : 0);
