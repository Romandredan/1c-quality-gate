#!/usr/bin/env node
/**
 * Каталог антипаттернов: чтение для читателя и аттестация его результата.
 *
 * Зачем аттестация. Проход по каталогу делает модель, и запись «проверил, чисто» она может
 * написать, не проверяя. Полностью это не лечится ничем, но проход можно сделать
 * ОТЛИЧИМЫМ от его отсутствия: читатель отдаёт структурированный результат, а этот
 * инструмент сверяет его с каталогом и с файлами — список проверенных признаков полон,
 * файлы те самые, у каждой находки настоящая строка с настоящей цитатой, — и только тогда
 * печатает строки следа и пишет журнал. Выдуманная находка становится дороже настоящей.
 *
 * Использование:
 *   node tools/catalog.mjs index [--archetypes query,transaction]
 *   node tools/catalog.mjs card qg:AI-07
 *   node tools/catalog.mjs list --json
 *   node tools/catalog.mjs attest --result <файл.json> --files <f> [<f> ...] [--archetypes a,b]
 *                                  [--diff <файл> | --no-diff-available]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCatalog, renderIndex } from './gen-catalog-index.mjs';
import { isKnownQgId } from './evidence-scopes.mjs';
import { recordRun, normalizePath } from './run-journal.mjs';
import { projectRoot } from './project-root.mjs';

const TOOL = 'tools/catalog.mjs';

function activeCards(cards, archetypes) {
  const set = new Set(archetypes);
  return cards.filter((c) => c.archetypes.includes('always') || c.archetypes.some((a) => set.has(a)));
}

/** Признаки, которые читатель обязан проверить: без инструмента и активные по архетипам. */
export function expectedExamined(archetypes, cards = readCatalog()) {
  return activeCards(cards, archetypes).filter((c) => !c.tool).map((c) => c.id).sort();
}

function scopeOf(id) {
  return id.startsWith('qg:AI-') ? 'ai-antipatterns' : 'platform-antipatterns';
}

function squash(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/**
 * Строки, удалённые правкой (`-`-строки диффа), с их номером в версии ДО правки.
 *
 * Номер строки старой версии восстанавливается по заголовку hunk (`@@ -a,b +c,d @@`) и по
 * счётчику: контекстные строки и удалённые двигают его, добавленные — нет (их не было в
 * старой версии).
 */
export function parseRemovedLines(diffText) {
  const removed = [];
  let oldLine = 0;
  for (const raw of String(diffText).split(/\r?\n/)) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); continue; }
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;
    if (raw.startsWith('-')) { removed.push({ line: oldLine, text: raw.slice(1) }); oldLine++; continue; }
    if (raw.startsWith('+')) continue;
    if (raw.startsWith(' ')) { oldLine++; continue; }
    // остальные строки метаданных диффа (`diff --git`, `index …`, `\ No newline …`) счётчик не двигают
  }
  return removed;
}

/**
 * Удалённые строки файла относительно HEAD, либо причина, почему сравнить не с чем.
 *
 * Находка `basis: "diff"` не сверяется с рабочим деревом (там строки уже нет — в этом и
 * находка) — сверяется с самим диффом. Недоступный git или файл без версии в HEAD делает
 * находку непроверяемой, а не автоматически верной: читатель не должен получить способ
 * протащить недоказуемую находку через отсутствие истории.
 */
function diffRemovedLinesOf(fileRel, root) {
  const relForGit = relative(resolve(root), resolve(root, fileRel)).split(sep).join('/');
  const head = spawnSync('git', ['show', `HEAD:${relForGit}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (head.error) return { ok: false, reason: 'git недоступен' };
  if (head.status !== 0) return { ok: false, reason: `нет версии HEAD файла ${fileRel}` };
  const diff = spawnSync('git', ['diff', 'HEAD', '--', relForGit], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (diff.error || diff.status !== 0) return { ok: false, reason: 'git недоступен' };
  return { ok: true, removed: parseRemovedLines(diff.stdout || '') };
}

/** Строки удалённого пути к файлу без ведущего `./`, слэши приведены к прямым. */
function posixPath(f) {
  return String(f).split(sep).join('/').replace(/^\.\//, '');
}

/**
 * Файл `--diff`: настоящее сравнение версий, а не пустышка или диф от других файлов.
 *
 * Диф не строит сам attest — он приходит от оркестратора (`git diff HEAD -- <файлы>`,
 * сохранённый ДО делегирования читателю: у него нет оболочки). Здесь только проверка, что
 * переданный файл годится: непустой и упоминает каждый файл из `--files` — без этого пустой
 * или чужой файл, подставленный за `--diff`, проходил бы точно так же, как настоящий, и
 * признак `needs: [diff]` снова заявлялся бы без сравнения версий за ним.
 */
function loadDiff(diffFile, files, root, problems) {
  if (!diffFile) return null;
  let text;
  try {
    text = readFileSync(resolve(root, diffFile), 'utf8');
  } catch {
    problems.push(`--diff указывает на файл, который не читается: ${diffFile}`);
    return null;
  }
  if (!text.trim()) {
    problems.push(`--diff файл пуст: сравнения версий в нём нет (${diffFile})`);
    return null;
  }
  // Регистр без строгости: `--files` приходит из состояния гейта уже в нижнем регистре
  // (`run-journal.mjs normalizePath`), а заголовки диффа несут регистр рабочего дерева —
  // `Module.bsl` против `module.bsl` для одного и того же файла на Windows. Строгое
  // сравнение отвергало бы настоящий diff как «не упоминает файл», а это дороже пропуска.
  const textLower = text.toLowerCase();
  const missing = files.filter((f) => !textLower.includes(posixPath(f).toLowerCase()));
  if (missing.length) {
    problems.push(`--diff не упоминает файлы состава прогона: ${missing.join(', ')} (${diffFile})`);
    return null;
  }
  return text;
}

export function attest({ result, files, archetypes = [], root = projectRoot(), diffFile = null, noDiffAvailable = false }) {
  const problems = [];
  const cards = readCatalog();
  const expectedAll = expectedExamined(archetypes, cards);
  // Признаки, которым для проверки нужно сравнение версий (сегодня — только qg:AI-11): без
  // переданного `--diff` их нечем проверить, и заявлять проход по ним — тот самый разрыв
  // между «числится examined» и «действительно проверено» (task-22).
  const needsDiff = activeCards(cards, archetypes)
    .filter((c) => !c.tool && (c.needs || []).includes('diff'))
    .map((c) => c.id);

  const examined = Array.isArray(result?.examined) ? [...new Set(result.examined)].sort() : [];

  if (diffFile && noDiffAvailable) problems.push('--diff и --no-diff-available нельзя передавать одновременно');
  const diffText = loadDiff(diffFile, files, root, problems);
  const diffAvailable = diffText !== null;

  if (!diffAvailable) {
    for (const id of examined.filter((x) => needsDiff.includes(x))) {
      problems.push(`признак ${id} требует сравнения версий, но --diff не передан`);
    }
  }

  const expected = diffAvailable ? expectedAll : expectedAll.filter((id) => !needsDiff.includes(id));
  const examinedForCompare = diffAvailable ? examined : examined.filter((id) => !needsDiff.includes(id));
  if (JSON.stringify(examinedForCompare) !== JSON.stringify(expected)) {
    const missing = expected.filter((id) => !examinedForCompare.includes(id));
    const extra = examinedForCompare.filter((id) => !expected.includes(id));
    problems.push(`examined не совпадает с активными признаками каталога: не хватает [${missing.join(', ')}], лишние [${extra.join(', ')}]`);
  }

  const wanted = files.map((f) => normalizePath(f, root));
  const declared = (Array.isArray(result?.files) ? result.files : []).map((f) => normalizePath(f, root));
  if (JSON.stringify([...declared].sort()) !== JSON.stringify([...wanted].sort())) {
    problems.push(`files результата не совпадают с переданными: ${JSON.stringify(declared)} против ${JSON.stringify(wanted)}`);
  }

  // Читаем каждый файл сами, а не на слово читателя: без этого читатель объявляет
  // «unreadable» любой файл и уходит от правила 3 (настоящая цитата) — заявленная нечитаемость
  // дешевле выдуманной находки, если её никто не проверяет.
  const contents = new Map();
  const actuallyUnreadable = new Set();
  for (const f of files) {
    const abs = resolve(root, f);
    const key = normalizePath(f, root);
    try {
      if (!existsSync(abs)) { actuallyUnreadable.add(key); continue; }
      contents.set(key, readFileSync(abs, 'utf8').split(/\r?\n/));
    } catch {
      actuallyUnreadable.add(key);
    }
  }

  const declaredUnreadable = Array.isArray(result?.unreadable) ? result.unreadable : [];
  const unreadable = [];
  for (const [i, f] of declaredUnreadable.entries()) {
    const where = `unreadable[${i}] (${f})`;
    const key = normalizePath(String(f || ''), root);
    if (!wanted.includes(key)) { problems.push(`${where}: файл вне состава прогона (--files)`); continue; }
    if (!actuallyUnreadable.has(key)) { problems.push(`${where}: файл объявлен нечитаемым, но читается`); continue; }
    unreadable.push(f);
  }

  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const fileByKey = new Map(files.map((f) => [normalizePath(f, root), f]));
  const diffCache = new Map();
  for (const [i, f] of findings.entries()) {
    const where = `находка ${i + 1} (${f?.id || '?'})`;
    if (!isKnownQgId(String(f?.id || ''))) { problems.push(`${where}: идентификатор не из реестра`); continue; }
    if (!examined.includes(f.id)) { problems.push(`${where}: признак не входит в examined`); continue; }
    const key = normalizePath(String(f.file || ''), root);
    if (!wanted.includes(key)) { problems.push(`${where}: файл ${f.file} не из состава прогона (--files)`); continue; }
    const line = Number(f.line);
    if (!Number.isInteger(line) || line < 1) { problems.push(`${where}: строка ${f.line} некорректна`); continue; }
    const quote = squash(f.quote || '');
    if (!quote) { problems.push(`${where}: пустая цитата`); continue; }

    if (f.basis === 'diff') {
      // Находка по дифу: строки рабочего дерева не годятся — строка удалена как раз в этом и
      // состоит находка. Сверяем с исчезнувшими строками `git diff HEAD -- <файл>`.
      if (!diffCache.has(key)) diffCache.set(key, diffRemovedLinesOf(fileByKey.get(key), root));
      const d = diffCache.get(key);
      if (!d.ok) { problems.push(`${where}: basis=diff — ${d.reason}`); continue; }
      const around = d.removed.filter((r) => r.line >= line - 2 && r.line <= line + 2).map((r) => r.text);
      const window = squash(around.join(' '));
      if (!window.includes(quote)) problems.push(`${where}: цитата не найдена среди удалённых строк ${line - 2}…${line + 2} (basis=diff) файла ${f.file}`);
      continue;
    }

    const lines = contents.get(key);
    if (!lines) { problems.push(`${where}: файл ${f.file} не читается`); continue; }
    if (line > lines.length) { problems.push(`${where}: строка ${f.line} вне файла (${lines.length} строк)`); continue; }
    const window = squash(lines.slice(Math.max(0, line - 3), line + 2).join(' '));
    if (!window.includes(quote)) problems.push(`${where}: цитата не найдена в строках ${line - 2}…${line + 2} файла ${f.file}`);
  }

  if (problems.length) return { ok: false, problems, evidence: [] };

  const evidence = [];
  for (const scope of ['ai-antipatterns', 'platform-antipatterns']) {
    const ids = examined.filter((id) => scopeOf(id) === scope);
    if (ids.length === 0) {
      evidence.push(`[qg skipped: layer=code, scope=${scope}, reason=not_applicable]`);
      recordRun({ scope, tool: TOOL, verdict: 'not_applicable', files, root });
      continue;
    }
    // `not_verified: dimension=<scope>` не годится: список измерений в evidence-validator.mjs
    // закрытый (compilation, query-execution, static-analysis, cross-config-resolution,
    // artifact-freshness, platform-api) и не включает имена скоупов каталога — такая запись
    // была бы отвергнута собственным валидатором плагина. `skipped ... reason=unreadable` —
    // тоже утверждение о работе инструмента («attest посмотрел файлы, часть не читается»), и
    // валидатор требует по нему отметку в журнале наравне с `not_applicable`: иначе читатель
    // объявляет unreadable без единого прогона и уходит от всех проверок разом.
    if (unreadable.length) {
      evidence.push(`[qg skipped: layer=code, scope=${scope}, reason=unreadable, files=${unreadable.length}]`);
      recordRun({ scope, tool: TOOL, verdict: 'unreadable', files, root });
      continue;
    }
    const hit = findings.find((f) => scopeOf(f.id) === scope);
    const verdict = hit ? `violation:${hit.id}` : 'clean';
    evidence.push(`[qg applied: layer=code, scope=${scope}, ids=[${ids.join(',')}], verdict=${verdict}]`);
    recordRun({ scope, tool: TOOL, verdict: hit ? 'violation' : 'clean', files, root });
  }

  // Честность на случай, когда сравнивать действительно не с чем (новый файл без истории,
  // репозиторий без git): --no-diff-available печатает эту запись явно, а не оставляет
  // needs:[diff]-признаки молча выпавшими из examined без единого следа их отсутствия.
  if (noDiffAvailable && !diffAvailable && needsDiff.length > 0) {
    evidence.push(`[qg skipped: layer=code, scope=ai-antipatterns-diff, planned=[${needsDiff.join(',')}], reason=no_diff]`);
    recordRun({ scope: 'ai-antipatterns-diff', tool: TOOL, verdict: 'no_diff', files, root });
  }

  return { ok: true, problems: [], evidence };
}

function parseArgs(argv) {
  const out = { files: [], archetypes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--files') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) out.files.push(argv[++i]); }
    else if (a === '--archetypes') out.archetypes = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--result') out.result = argv[++i];
    else if (a === '--diff') out.diff = argv[++i];
    else if (a === '--no-diff-available') out.noDiffAvailable = true;
    else if (a === '--json') out.json = true;
    else out._ = [...(out._ || []), a];
  }
  return out;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  const cards = readCatalog();
  switch (cmd) {
    case 'index': {
      process.stdout.write(renderIndex(activeCards(cards, args.archetypes)));
      return 0;
    }
    case 'card': {
      const id = args._?.[0];
      const c = cards.find((x) => x.id === id || x.id === `qg:${id}`);
      if (!c) { process.stderr.write(`Карточки ${id} нет в каталоге\n`); return 1; }
      process.stdout.write(readFileSync(c.file, 'utf8'));
      return 0;
    }
    case 'list': {
      process.stdout.write(args.json ? JSON.stringify(cards.map(({ file, ...c }) => c), null, 2) + '\n' : cards.map((c) => `${c.id}\t${c.severity}\t${c.tool || 'чтение'}\t${c.title}`).join('\n') + '\n');
      return 0;
    }
    case 'attest': {
      if (!args.result || args.files.length === 0) { process.stderr.write('нужны --result <json> и --files <f> ...\n'); return 1; }
      const result = JSON.parse(readFileSync(args.result, 'utf8'));
      const r = attest({
        result,
        files: args.files,
        archetypes: args.archetypes,
        diffFile: args.diff || null,
        noDiffAvailable: !!args.noDiffAvailable,
      });
      if (!r.ok) { process.stderr.write('Результат читателя отвергнут:\n' + r.problems.map((p) => `  - ${p}`).join('\n') + '\n'); return 2; }
      process.stdout.write(r.evidence.join('\n') + '\n');
      return 0;
    }
    default:
      process.stderr.write(
        'Команды: index | card <ID> | list [--json] | ' +
          'attest --result <json> --files <f>... [--diff <файл> | --no-diff-available]\n'
      );
      return 1;
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
