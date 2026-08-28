/**
 * Журнал прогонов инструментов — след того, что проверка действительно выполнялась.
 *
 * Проблема, ради которой он существует. Строку `[qg applied: ... verdict=clean]` пишет в
 * отчёт модель. Инструмент, который эту строку печатает, и модель, которая её сочинила,
 * дают в отчёте один и тот же текст. Наблюдалось в живой сессии: вердикт по
 * `qg:QRY-ALIAS-SHADOWS-FIELD` четырежды попал в отчёты как результат чтения кода глазами,
 * а не прогона `query-lint.mjs`. Вердикты оказались верны — и это худший вариант: проверка,
 * которая случайно совпала, ничем не отличается от проведённой.
 *
 * Что journal даёт и чего НЕ даёт. Он делает обнаружимым МОЛЧАНИЕ: заявлено `applied` по
 * проверке, у которой есть инструмент, а инструмент в этом прогоне не запускался. Он не
 * является доказательством в сильном смысле — в отличие от поля `config`, где валидатор
 * заново выводит истину с диска и сверяет с заявленным. Независимого источника, из которого
 * можно перевывести «эти файлы проверены», у нас нет, а дописать строку в журнал руками
 * технически возможно. Это защита от добросовестной ошибки, не от умысла, и называется
 * здесь прямо, чтобы никто не принял её за большее.
 *
 * Свежесть. Запись годится, если она НЕ СТАРШЕ последней зафиксированной правки файлов
 * (`updatedAt` сессии гейта). Прогон, сделанный до правки, доказывает состояние, которого
 * уже нет, — то же правило, по которому гейт снимает отметки проверенного при изменении
 * файла.
 *
 * Файл: `.claude/.state/qg-runs.jsonl`, по строке на прогон, старые записи усекаются.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { projectRoot } from './project-root.mjs';
import { stateDirSegments } from './state-dir.mjs';

const STATE_DIR = stateDirSegments();
const JOURNAL_FILE = 'qg-runs.jsonl';

/** Сколько записей держим. Журнал — доказательство текущего прогона, а не история проекта. */
const KEEP = 500;

export function journalPath(root = projectRoot()) {
  return join(root, ...STATE_DIR, JOURNAL_FILE);
}

/**
 * Приводит путь к той же форме, в какой состав правки хранит гейт: относительно корня
 * проекта, слэши вперёд, нижний регистр.
 *
 * Регистр гасится намеренно: на Windows один и тот же файл приходит то как `src/CF/...`,
 * то как `src/cf/...`, и сверка покрытия по-разному написанных путей давала бы находку на
 * проверенном файле — ложный отказ, который дороже пропуска.
 */
export function normalizePath(p, root = projectRoot()) {
  const s = String(p);
  const rel = isAbsolute(s) ? relative(resolve(root), resolve(s)) : s;
  return rel.split('\\').join('/').replace(/^\.\//, '').toLowerCase();
}

/** Список путей либо null. Число (прежний формат поля) значит «пути неизвестны». */
function normalizePaths(files, root) {
  if (files === null || files === undefined) return null;
  if (!Array.isArray(files)) return null;
  const out = [...new Set(files.map((f) => normalizePath(f, root)).filter(Boolean))];
  return out.length ? out : null;
}

/**
 * Записывает факт прогона.
 *
 * Пишется САМИМ инструментом в момент печати следа — иначе запись доказывала бы лишь то,
 * что кто-то вызвал функцию записи. Ошибка записи не роняет инструмент: журнал полезен, но
 * проверка важнее, и падение на недоступном каталоге состояния оставило бы пользователя без
 * результата ради учёта этого результата.
 */
export function recordRun({ scope, tool, verdict = null, files = null, unanalyzed = null, root = projectRoot() }) {
  if (!scope || !tool) return null;
  const paths = normalizePaths(files, root);
  const entry = {
    ts: new Date().toISOString(),
    scope,
    tool,
    ...(verdict ? { verdict } : {}),
    // Пути, а не количество. Число отвечало на вопрос «сколько-то файлов проверено», из
    // которого не следует, что проверены ИМЕННО изменённые: прогон по одному файлу закрывал
    // заявление о десяти. С путями валидатор сверяет покрытие с составом правки, известным
    // из состояния гейта.
    ...(paths === null ? {} : { files: paths }),
    // Сколько файлов инструмент НЕ проверил. Живёт в журнале, а не только в отчёте, потому
    // что отчёт пишет модель: заявление о полноте, взятое из проверяемого документа, ничего
    // не подтверждает.
    ...(unanalyzed === null ? {} : { unanalyzed }),
  };
  try {
    const path = journalPath(root);
    mkdirSync(dirname(path), { recursive: true });
    const previous = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim()) : [];
    const lines = [...previous, JSON.stringify(entry)].slice(-KEEP);
    writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  } catch {
    /* журнал не пишется — проверка всё равно должна отработать и напечатать результат */
  }
  return entry;
}

/** Читает журнал. Битая строка пропускается: обрыв записи не должен обесценивать остальные. */
export function readJournal(root = projectRoot()) {
  const path = journalPath(root);
  if (!existsSync(path)) return [];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec.scope === 'string') out.push(rec);
    } catch {
      /* пропускаем */
    }
  }
  return out;
}

/**
 * Имена проверок, прогнанных инструментом не раньше момента `since`.
 *
 * `since` пустой — ограничения по времени нет: валидатор запускают и вне сессии гейта, и
 * тогда сказать, когда правился файл, нечем. Требование наличия записи при этом остаётся.
 */
export function scopesRun(root = projectRoot(), since = null) {
  const bound = since ? String(since) : null;
  const out = new Set();
  for (const rec of readJournal(root)) {
    if (bound && String(rec.ts || '') < bound) continue;
    out.add(rec.scope);
  }
  return out;
}

/**
 * Файлы, которые инструмент этой проверки видел, — объединение по всем годным записям.
 *
 * Объединение, а не последняя запись: контур законно гоняет инструмент несколькими вызовами
 * (по файлу, по группе), и требовать один вызов на всё значило бы предписывать способ работы
 * вместо результата.
 *
 * Записи без путей (прежний формат, где хранилось количество) возвращают `null` — «видел
 * что-то, но что именно, неизвестно». Отличать это от «не видел ничего» обязательно: иначе
 * журнал, созданный прошлой версией, читался бы как доказательство пропуска.
 */
export function coveredFiles(root = projectRoot(), scope, since = null) {
  const bound = since ? String(since) : null;
  const files = new Set();
  let any = false;
  let unknown = false;
  for (const rec of readJournal(root)) {
    if (rec.scope !== scope) continue;
    if (bound && String(rec.ts || '') < bound) continue;
    any = true;
    if (Array.isArray(rec.files)) for (const f of rec.files) files.add(String(f).toLowerCase());
    else unknown = true;
  }
  if (!any) return { ran: false, files: new Set(), unknown: false };
  return { ran: true, files, unknown };
}
