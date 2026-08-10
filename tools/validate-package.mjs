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
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];
const fail = (where, message) => problems.push({ severity: 'error', where, message });
const warn = (where, message) => problems.push({ severity: 'warn', where, message });

const SKIP_DIRS = new Set(['.git', 'node_modules', '.remember', '.state', '.qg-analyzer']);

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
      warn(rel(f), `ссылка на несуществующий файл: ${target}`);
    }
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
