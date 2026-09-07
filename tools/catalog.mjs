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
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

export function attest({ result, files, archetypes = [], root = projectRoot() }) {
  const problems = [];
  const cards = readCatalog();
  const expected = expectedExamined(archetypes, cards);
  const examined = Array.isArray(result?.examined) ? [...new Set(result.examined)].sort() : [];
  if (JSON.stringify(examined) !== JSON.stringify(expected)) {
    const missing = expected.filter((id) => !examined.includes(id));
    const extra = examined.filter((id) => !expected.includes(id));
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
  for (const [i, f] of findings.entries()) {
    const where = `находка ${i + 1} (${f?.id || '?'})`;
    if (!isKnownQgId(String(f?.id || ''))) { problems.push(`${where}: идентификатор не из реестра`); continue; }
    if (!examined.includes(f.id)) { problems.push(`${where}: признак не входит в examined`); continue; }
    const key = normalizePath(String(f.file || ''), root);
    const lines = contents.get(key);
    if (!lines) { problems.push(`${where}: файл ${f.file} не из состава прогона`); continue; }
    const line = Number(f.line);
    if (!Number.isInteger(line) || line < 1 || line > lines.length) { problems.push(`${where}: строка ${f.line} вне файла (${lines.length} строк)`); continue; }
    const quote = squash(f.quote || '');
    if (!quote) { problems.push(`${where}: пустая цитата`); continue; }
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
  return { ok: true, problems: [], evidence };
}

function parseArgs(argv) {
  const out = { files: [], archetypes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--files') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) out.files.push(argv[++i]); }
    else if (a === '--archetypes') out.archetypes = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--result') out.result = argv[++i];
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
      const r = attest({ result, files: args.files, archetypes: args.archetypes });
      if (!r.ok) { process.stderr.write('Результат читателя отвергнут:\n' + r.problems.map((p) => `  - ${p}`).join('\n') + '\n'); return 2; }
      process.stdout.write(r.evidence.join('\n') + '\n');
      return 0;
    }
    default:
      process.stderr.write('Команды: index | card <ID> | list [--json] | attest --result <json> --files <f>...\n');
      return 1;
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
