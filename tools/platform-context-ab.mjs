#!/usr/bin/env node
/**
 * A/B находок сервера справки платформы (bsl-context) перед сдвигом закрепления.
 *
 * Критерий «сервер поднимается и отвечает» пропускает то, что меняет вердикт гейта: при
 * переходе 0.19.1 → 0.22.0 он не заметил ни отказа на пустом модуле, ни ухода тысячи ложных
 * находок. Поэтому ревью сдвига сравнивает находки двух версий на модулях проекта тем же
 * вызовом, которым их получает `platform-context-run.mjs`: тот же `module_path`, тот же
 * разбор ответа, пустые модули так же не отправляются.
 *
 * Оба сервера поднимаются заранее (старый — свой демон плагина, новый — вручную на другом
 * порту, см. RELEASING.md). Инструмент только читает: в проект и в каталог данных не пишет.
 *
 *   node tools/platform-context-ab.mjs --project <корень> --a <url> --b <url> \
 *        [--glob 'src/cfe/*.bsl'] [--out <файл.json>]
 *
 * Код возврата: 0 — находки совпали, 3 — есть расхождения или отказы, 1 — ошибка вызова.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateModule, normalizeFindings, modulePathOf } from './platform-context-run.mjs';

/** Ключ находки: строка, вид, уверенность. Текст сообщения не входит — его автор правит свободно. */
const keyOf = (f) => `${f.line}|${f.kind}|${f.confidence}`;

/**
 * Сравнение двух прогонов. Строка входа — `{ file, a, b }`, где сторона — `{ findings: [ключ] }`
 * либо `{ error }`. Итог — счёт по виду и уверенности и перечень файлов с расхождением.
 */
export function compareRuns(rows) {
  const table = {};
  const bump = (side, key) => {
    const kind = key.split('|').slice(1).join('|');
    table[kind] ??= { a: 0, b: 0 };
    table[kind][side]++;
  };
  const diffs = [];
  for (const r of rows) {
    for (const side of ['a', 'b']) for (const k of r[side].findings || []) bump(side, k);
    const A = new Set(r.a.findings || []);
    const B = new Set(r.b.findings || []);
    const gone = [...A].filter((k) => !B.has(k));
    const added = [...B].filter((k) => !A.has(k));
    if (gone.length || added.length || r.a.error || r.b.error) {
      diffs.push({ file: r.file, gone, added, errorA: r.a.error || null, errorB: r.b.error || null });
    }
  }
  return {
    files: rows.length,
    table: Object.entries(table).sort(([x], [y]) => x.localeCompare(y)).map(([kind, n]) => ({ kind, ...n })),
    diffs,
  };
}

async function side(url, text, modulePath) {
  if (!text.trim()) return { findings: [] };
  const r = await validateModule({ url, moduleText: text, modulePath, timeoutMs: 120000 });
  if (!r.ok) return { error: r.refusal ? `отказ: ${r.refusal}` : r.transport };
  return { findings: normalizeFindings(r.payload, { file: modulePath }).findings.map(keyOf) };
}

function parseArgs(argv) {
  const out = { glob: 'src/cfe/*.bsl' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--a') out.a = argv[++i];
    else if (a === '--b') out.b = argv[++i];
    else if (a === '--glob') out.glob = argv[++i];
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.project || !args.a || !args.b) {
    process.stderr.write('Нужны --project <корень>, --a <url старой версии> и --b <url новой>.\n');
    return 1;
  }
  const root = resolve(args.project);
  const files = execFileSync('git', ['-C', root, 'ls-files', args.glob], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const rows = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const abs = join(root, files[next++]);
      const text = readFileSync(abs, 'utf8');
      const modulePath = modulePathOf(abs, root);
      const [a, b] = await Promise.all([side(args.a, text, modulePath), side(args.b, text, modulePath)]);
      rows.push({ file: modulePath, a, b });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const result = compareRuns(rows);
  if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 1), 'utf8');

  const errA = result.diffs.filter((d) => d.errorA).length;
  const errB = result.diffs.filter((d) => d.errorB).length;
  process.stdout.write(`Модулей: ${result.files}; с расхождением: ${result.diffs.length}; отказов A: ${errA}, B: ${errB}\n`);
  for (const t of result.table) {
    process.stdout.write(`${t.kind.padEnd(40)} ${String(t.a).padStart(6)} → ${t.b}${t.a === t.b ? '' : '   *'}\n`);
  }
  return result.diffs.length ? 3 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Код полем, а не process.exit: при stdout-трубе мгновенный выход обрывает вывод
  // (разбор — в конце platform-context-run.mjs).
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`${e?.stack || e}\n`);
      process.exitCode = 1;
    }
  );
}
