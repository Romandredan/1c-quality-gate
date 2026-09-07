#!/usr/bin/env node
/**
 * Замер полноты читателя каталога по контрольным примерам.
 *
 * Вопрос, на который отвечает: ловит ли проход по каталогу те дефекты, ради которых карточки
 * написаны. Без этого замера экономия контекста доказуема, а сохранность обнаружения — нет.
 *
 * Не входит в run-tests.mjs: нужен доступ к модели. Запускается по команде и перед релизом:
 *   node tests/recall.mjs [--cases "AI-*"] [--model sonnet] [--concurrency 4] [--timeout 300]
 *                          [--min-recall 0.8] [--max-false-positive 0.1]
 * Результат — tests/recall/results/<дата>.json. Код возврата 1, если полнота ниже порога либо
 * доля ложных находок на clean.bsl выше порога.
 *
 * Числовые флаги разбираются простым парсером `--ключ значение`: флаг последним токеном без
 * значения (`... --min-recall`) читается как `true` → `Number(true)` → `1`, то есть валидный
 * порог 100%, а не ошибка. `numArg()` ловит только `NaN` (мусорное значение), не эту форму —
 * при ручном вызове с одиночными флагами без значений результат стоит перепроверить глазами.
 *
 * Зонд headless-режима (Claude Code 2.1.259, `claude -p ... --output-format json
 * --json-schema ...`): структурированный результат лежит в поле `structured_output` объекта
 * с `"type":"result"`, рядом с `result` — той же структурой в виде строки. Разбор берёт
 * `structured_output`, при его отсутствии — `JSON.parse(result)`.
 *
 * Windows-нюанс, которого нет в исходном черновике задачи: `claude` в этом окружении —
 * настоящий `.exe` (`where claude` → `claude.exe`), не `.cmd`-обёртка. `spawnSync`/`spawn`
 * с `shell: true` на Windows склеивает массив аргументов в одну строку и НЕ экранирует её —
 * проверено отдельным зондом: `-p "Верни JSON..."` доходит до процесса как пять раздельных
 * токенов, а JSON-схема с кавычками ломается ещё сильнее. `shell: false` передаёт argv как
 * есть и отработал на прогоне AI-07. Поэтому здесь всегда `shell: false`; если в другом
 * окружении `claude` окажется `.cmd`-обёрткой без прямого exe рядом, `spawn` вернёт ENOENT —
 * тогда способ запуска придётся пересмотреть, тихого исправления через shell:true не будет.
 *
 * Приближение, которое нужно знать при чтении результата: вызов идёт с `--allowedTools ""`,
 * то есть читателю недоступен даже Read — шаг 3 его инструкции («открой карточку и проверь
 * «Когда это не дефект»») не выполняется. Число ниже — полнота срабатывания триггера, а не
 * полнота итогового вердикта читателя в проде (там подтверждение по карточке доступно). Эта
 * оговорка печатается в сводке и пишется в результат (`note`, `toolsAllowed`), а не только
 * живёт здесь: кто читает цифру, не обязан читать код скрипта.
 *
 * Правило по AI-11: дефект виден только при сравнении версий (было/стало), одним файлом не
 * ловится. В `expected.json` карточки стоит `"detectable": "diff-only"` — для неё не
 * запрашивается `defect.bsl` (заведомый промах ничего не измеряет), запрос по `clean.bsl`
 * остаётся: ложные срабатывания меряются везде. Такие карточки не входят в знаменатель
 * полноты и печатаются отдельной строкой сводки.
 *
 * AI-04 и AI-05 в знаменатель входят, но проверяют распознавание маркерной фразы в тексте
 * кода, а не признак самого дефекта — это тоже отмечено отдельной строкой сводки.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readCatalog, renderIndex } from '../tools/gen-catalog-index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CASES = join(ROOT, 'tests', 'recall', 'cases');
const RESULTS = join(ROOT, 'tests', 'recall', 'results');

const MARKER_PHRASE_CASES = ['AI-04', 'AI-05'];

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? true] : []))
    .filter((e) => e.length)
);

/** Числовой флаг с проверкой: молчаливый NaN хуже явной ошибки — порог, который никогда
 * не выполняется, неотличим от прогона, где всё найдено, пока не прочитаешь код. */
function numArg(name, def) {
  const raw = args[name];
  const v = raw === undefined ? def : Number(raw);
  if (!Number.isFinite(v)) throw new Error(`--${name}: ожидалось число, получено ${JSON.stringify(raw)}`);
  return v;
}

const MODEL = args.model || 'sonnet';
const MIN_RECALL = numArg('min-recall', 0.8);
const MAX_FP = numArg('max-false-positive', 0.1);
const CONCURRENCY = Math.max(1, numArg('concurrency', 4));
const TIMEOUT_S = numArg('timeout', 300);
const glob = args.cases ? new RegExp('^' + String(args.cases).replace(/\*/g, '.*') + '$') : null;

const FIDELITY_NOTE =
  'Читатель вызван с --allowedTools "" — карточка не открывается, шаг «Когда это не дефект» ' +
  'не выполняется. Число — полнота срабатывания триггера по индексу, а не итоговый вердикт ' +
  'читателя в проде: полнота здесь оптимистичнее боевой (нечем себя поправить по карточке), ' +
  'а доля ложных срабатываний — наоборот, завышена (нет доступа к законным формам признака).';

const SCHEMA = {
  type: 'object',
  properties: {
    examined: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          method: { type: 'string' },
          quote: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['id', 'file', 'line', 'quote'],
      },
    },
    unreadable: { type: 'array', items: { type: 'string' } },
  },
  required: ['examined', 'files', 'findings', 'unreadable'],
};

const agentBody = readFileSync(join(ROOT, 'agents', 'antipattern-reader.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');
const cards = readCatalog().filter((c) => !c.tool);
const index = renderIndex(cards);

/** Один вызов читателя в headless-режиме. Промис вместо spawnSync — нужен для пула воркеров. */
function ask(fileName, code) {
  const prompt = [
    'Индекс триггеров:', '', index, '',
    `Файл ${fileName}:`, '', '```bsl', code, '```', '',
    'Верни JSON по схеме.',
  ].join('\n');

  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p', prompt,
        '--output-format', 'json',
        '--model', MODEL,
        '--allowedTools', '',
        '--system-prompt', agentBody,
        '--json-schema', JSON.stringify(SCHEMA),
      ],
      { shell: false }
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    // Без таймаута зависший claude -p (ждёт ввод, оборвалась сеть) не разрешает промис
    // никогда: пул встаёт молча, без строки в консоли, без файла результата и без кода
    // возврата — пропавшая проверка неотличима от идущей.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`claude -p не ответил за ${TIMEOUT_S} с на ${fileName} — процесс убит`));
    }, TIMEOUT_S * 1000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (status !== 0) {
        reject(new Error(`claude -p завершился с кодом ${status} на ${fileName}: ${stderr}`));
        return;
      }
      let out;
      try {
        out = JSON.parse(stdout);
      } catch (e) {
        reject(new Error(`не разобрался JSON-конверт claude -p на ${fileName}: ${e.message}\n${stdout.slice(0, 500)}`));
        return;
      }
      try {
        resolve(out.structured_output ?? JSON.parse(out.result));
      } catch (e) {
        reject(new Error(`не разобрался structured_output/result на ${fileName}: ${e.message}`));
      }
    });
  });
}

/** Простой пул воркеров: до `limit` промисов в работе одновременно, без зависимостей. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let firstError = null;
  async function run() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        firstError = firstError ?? e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  if (firstError) throw firstError;
  return results;
}

const caseNames = readdirSync(CASES)
  .filter((name) => !glob || glob.test(name))
  .sort();

const tasks = [];
const notMeasured = [];
for (const name of caseNames) {
  const dir = join(CASES, name);
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  const kinds = expected.detectable === 'diff-only' ? ['clean'] : ['defect', 'clean'];
  if (expected.detectable === 'diff-only') notMeasured.push(name);
  for (const kind of kinds) tasks.push({ name, dir, kind, expected });
}

let rows;
try {
  rows = await pool(tasks, CONCURRENCY, async ({ name, dir, kind, expected }) => {
    const code = readFileSync(join(dir, `${kind}.bsl`), 'utf8').replace(/^\uFEFF/, '');
    const got = await ask(`${name}/${kind}.bsl`, code);
    const found = [...new Set(got.findings.map((f) => f.id))];
    const want = expected[kind];
    const row = {
      case: name,
      kind,
      want,
      found,
      hit: want.every((id) => found.includes(id)),
      falsePositive: kind === 'clean' && found.length > 0,
    };
    process.stdout.write(
      `${row.hit && !row.falsePositive ? ' ok ' : 'FAIL'}  ${name}/${kind}  ожидалось [${want}] найдено [${found}]\n`
    );
    return row;
  });
} catch (e) {
  // Первая ошибка из pool() — истёкший таймаут, ненулевой код claude -p или неразобранный
  // конверт: без явного выхода здесь top-level await падает в сырой стек, а не в понятный
  // код возврата, который ждёт вызывающий (CI, релизный чек-лист).
  process.stderr.write(`Прогон прерван: ${e.message}\n`);
  process.exit(1);
}

const defects = rows.filter((r) => r.kind === 'defect');
const recall = defects.length ? defects.filter((r) => r.hit).length / defects.length : 1;
const cleans = rows.filter((r) => r.kind === 'clean');
const fpRate = cleans.length ? cleans.filter((r) => r.falsePositive).length / cleans.length : 0;

mkdirSync(RESULTS, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
writeFileSync(
  join(RESULTS, `${stamp}.json`),
  JSON.stringify({ model: MODEL, recall, fpRate, notMeasured, toolsAllowed: false, note: FIDELITY_NOTE, rows }, null, 2),
  'utf8'
);

process.stdout.write(`\nПолнота: ${(recall * 100).toFixed(0)}% (порог ${MIN_RECALL * 100}%), ложные на чистых: ${(fpRate * 100).toFixed(0)}% (порог ${MAX_FP * 100}%)\n`);
process.stdout.write(`Оговорка: ${FIDELITY_NOTE}\n`);
if (notMeasured.length) {
  process.stdout.write(`не измеряется парой файлов: ${notMeasured.length} (${notMeasured.join(', ')})\n`);
}
const measuredMarkerCases = MARKER_PHRASE_CASES.filter((c) => caseNames.includes(c));
if (measuredMarkerCases.length) {
  process.stdout.write(`измеряют маркерную фразу, а не признак кода: ${measuredMarkerCases.join(', ')}\n`);
}

process.exit(recall >= MIN_RECALL && fpRate <= MAX_FP ? 0 : 1);
