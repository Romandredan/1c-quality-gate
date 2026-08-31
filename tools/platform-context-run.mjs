#!/usr/bin/env node
/**
 * Второй движок контура кода: сверка модуля с фактическим API платформы 1С.
 *
 * Зачем отдельно от `analyzer-run.mjs`. Статический анализатор знает имена КОНФИГУРАЦИИ —
 * общие модули, реквизиты, поля запросов (`UnresolvedMethodCall`, `UnresolvedField`), — но
 * про саму платформу не знает ничего. Замер на одном файле, отданном обоим движкам
 * (31.08.2026, bsl-analyzer 0.2.73 с конфигом гейта): анализатор промолчал на
 * `Массив.Сортировать()`, на `ТипГруппыЭлементовОтбораКомпоновкиДанных.Группа`, на
 * `Новый ТаблицаЗначенийРасширенная`, на `ЗначениеЗаполненно(...)` и на
 * `ДиалогВыбораФайла.НачальныйКаталог`. Всё это компилируется и падает при выполнении —
 * то самое измерение `compilation`, которое плагин до сих пор закрывал записью
 * `not_verified: reason=no_platform`.
 *
 * Почему это не противоречит отказу от MCP как основы гейта (`docs/analyzer-integration.md`).
 * Отказ был не транспорту, а тому, что вопросы движку задаёт модель: что спросила, то и
 * проверено. Здесь запрос фиксированный и одинаковый для каждого изменённого файла, его
 * формирует этот скрипт, а не модель, — ровно такой же примитив принуждения, как
 * `analyze --incremental`, только по HTTP.
 *
 * Источник данных — сервер `bsl-context` (https://github.com/Regsorm/bsl-context), который
 * читает справку платформы `shcntx_ru.hbk`. По умолчанию контур ВЫКЛЮЧЕН: сервера нет ни у
 * кого, кроме тех, кто его поднял, а движок без адреса обязан молчать в след, а не в пустоту.
 *
 * Использование:
 *   node tools/platform-context-run.mjs --changed <файл> [--changed <файл> ...] [--json] [--all]
 *   node tools/platform-context-run.mjs --sentinel
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readConfig } from './config.mjs';
import { projectRoot } from './project-root.mjs';
import { recordRun } from './run-journal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = dirname(HERE);

/** Область следа: одна на весь движок, как `static-analysis` у анализатора. */
export const SCOPE = 'platform-api';
export const TOOL = 'tools/platform-context-run.mjs';

/**
 * Находки, которые уже выдаёт `bsl-analyzer`, — их выбрасываем, чтобы отчёт не двоился.
 *
 * Список получен замером, а не предположением: на одном файле анализатор дал
 * `MismatchedArgCount` + `IncorrectUseOfStrTemplate` там же, где здесь `wrong_argument_count`;
 * `LogicalOrInJoinQuerySection` — там же, где `or_in_join_condition`; `UnresolvedField` —
 * там же, где `unknown_metadata_object`. Дублирующая находка не бесплатна: она удваивает
 * строки следа по одному дефекту, и вердикт начинает зависеть от того, какой движок успел
 * отчитаться первым.
 *
 * Расширять список можно только таким же замером на общем файле. Убирать — если в конфиге
 * гейта соответствующая диагностика анализатора выключена: тогда дубля нет и находка нужна.
 */
export const DUPLICATED_BY_ANALYZER = new Set([
  'wrong_argument_count',
  'or_in_join_condition',
  'unknown_metadata_object',
]);

/**
 * Часовой требует находку, ЗАВИСЯЩУЮ ОТ СПРАВКИ ПЛАТФОРМЫ, — как часовой анализатора
 * требует диагностику, зависящую от метаданных.
 *
 * `unknown_enum_value` выбран не случайно: у него нулевая доля ложных срабатываний (значение
 * системного перечисления либо есть в справке, либо его нет) и он невозможен без загруженного
 * `hbk`. Сервер, поднявшийся без справки, отвечает на запросы, но находки не даёт — и пустой
 * ответ читался бы как «замечаний нет».
 */
export const SENTINEL_KIND = 'unknown_enum_value';

/** Шкала плагина: critical / major / minor / info. */
const SEVERITY_BY_CONFIDENCE = { high: 'major', low: 'info' };
const SEVERITY_MARK = { critical: '🔴', major: '🟠', minor: '🟡', info: '·' };
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2, info: 3 };

/**
 * Настройка контура. Секция `platformContext` проектного конфига плагина.
 *
 * `url` и `repo` без умолчаний намеренно: адрес сервера и алиас конфигурации знает только
 * проект, а угаданный алиас — худший исход из возможных. Сервер отвечает на промах по имени
 * не ошибкой вызова, а обычным ответом `{"ok": false}`, и движок, который этого не проверяет,
 * печатает «находок нет» на каждый файл.
 */
export function readPlatformContextConfig(root = projectRoot(), env = process.env) {
  return readConfig(root, env).platformContext;
}

/** Настроен ли контур: без адреса и алиаса конфигурации запускать нечего. */
export function isConfigured(cfg) {
  return Boolean(cfg && cfg.enabled && cfg.url && cfg.repo);
}

/**
 * Путь модуля в выгрузке — обязательный параметр запроса, когда он известен.
 *
 * Без него сервер не отличает модуль объекта от произвольного фрагмента и считает, что
 * неявного контекста объекта нет: обращения к реквизитам и табличным частям
 * (`Товары.Очистить()`) дают ложную находку «нет такого общего модуля». Хвост пути ещё и
 * опознаёт модуль формы, включая проверку имён, занятых членами формы.
 */
export function modulePathOf(file, root = projectRoot()) {
  const rel = relative(root, resolve(file));
  const norm = (rel.startsWith('..') ? resolve(file) : rel).split(sep).join('/');
  return norm;
}

/**
 * Один запрос `validate_module` по протоколу MCP поверх HTTP (stateless, без рукопожатия).
 *
 * `fetchImpl` инжектируется ради тестов: движок обязан проверяться без живого сервера, иначе
 * его тесты зелены ровно на той машине, где сервер поднят.
 */
export async function validateModule({
  url,
  repo,
  level = 2,
  timeoutMs = 15000,
  moduleText,
  modulePath = null,
  fetchImpl = globalThis.fetch,
}) {
  const args = { module: moduleText, level, profile: 'full', repo };
  if (modulePath) args.module_path = modulePath;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'validate_module', arguments: args },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, transport: `http_${res.status}` };
    return parseToolResult(await res.text());
  } catch (e) {
    return { ok: false, transport: e?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Разбирает ответ инструмента MCP: чистый JSON либо поток событий.
 *
 * Отдельная функция с тестами, потому что здесь два тихих отказа. Первый: транспорт может
 * ответить потоком `data: {...}` вместо тела JSON. Второй, важнее: сервер сообщает об отказе
 * (`{"ok": false, "message": "параметр repo обязателен"}`) внутри УСПЕШНОГО ответа
 * инструмента — потребитель, читающий только список находок, принимает отказ за «чисто».
 */
export function parseToolResult(raw) {
  let envelope;
  const text = String(raw ?? '').trim();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  try {
    envelope = JSON.parse(dataLine ? dataLine.slice(6) : text);
  } catch {
    return { ok: false, transport: 'malformed_response' };
  }
  if (envelope.error) return { ok: false, transport: 'rpc_error', message: envelope.error.message };
  const content = envelope?.result?.content;
  const first = Array.isArray(content) ? content.find((c) => c?.type === 'text') : null;
  if (!first) return { ok: false, transport: 'malformed_response' };
  let payload;
  try {
    payload = JSON.parse(first.text);
  } catch {
    return { ok: false, transport: 'malformed_response' };
  }
  if (payload.ok === false) return { ok: false, refusal: payload.message || 'отказ без пояснения' };
  return { ok: true, payload };
}

/**
 * Приводит ответ сервера к находкам плагина.
 *
 * `confidence` отображается в severity, а не в решение «показывать или нет»: `high` —
 * содержательная находка (`major`), `low` — подсказка (`info`). Выбрасывать `low` нельзя,
 * хотя соблазн есть: замер на боевом коде дал в этом классе И ложные (переменная названа
 * именем платформенного типа — `ЗаписьДанных`, `Соединение`, `Блокировка`, — и имя перебивает
 * вывод типа из присваивания), И настоящие (`ДиалогВыбораФайла.НачальныйКаталог`, свойства
 * нет, присваивание падает при выполнении). Класс смешанный, поэтому он показывается с
 * пометкой уверенности, а решение остаётся за читателем.
 *
 * Профиль `strict` самого сервера для этой роли не годится: он форсирует уровень 1, а
 * `unknown_type_member` существует только с уровня 2 — то есть strict выключает ровно тот
 * класс, ради которого движок и добавлен.
 */
export function normalizeFindings(payload, { file }) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const findings = [];
  for (const e of errors) {
    if (DUPLICATED_BY_ANALYZER.has(e.kind)) continue;
    findings.push({
      file,
      line: Number(e.line) || 0,
      code: `pc:${e.kind}`,
      kind: e.kind,
      confidence: e.confidence === 'high' ? 'high' : 'low',
      severity: SEVERITY_BY_CONFIDENCE[e.confidence] || 'info',
      message: String(e.message || ''),
      suggestion: e.suggestion || null,
    });
  }
  const degraded = [];
  if (payload?.tree_parsed === false) degraded.push('tree_not_parsed');
  if (payload?.symbols_available === false) degraded.push('symbols_unavailable');
  return { findings, degraded };
}

/**
 * Версия движка и версия платформы, чью справку он отдаёт.
 *
 * Обе нужны в следе, и вторая важнее первой. Состав системных перечислений и сигнатуры между
 * релизами платформы отличаются — потому сервер и не выбирает версию сам, а требует указать
 * её явно. Без отметки два прогона, сверявшие один и тот же код с 8.3.25 и с 8.3.27, дают
 * побайтово одинаковый след, и вопрос «почему находка была вчера и нет сегодня» становится
 * неразрешимым. Анализатор ту же проблему решает закреплением `analyzer.version`.
 *
 * Недоступность `/health` прогон не отменяет: поле останется пустым, а сам разбор модулей
 * от него не зависит.
 */
export async function serverInfo({ url, timeoutMs = 5000, fetchImpl = globalThis.fetch }) {
  const health = String(url || '').replace(/\/mcp\/?$/, '/health');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(health, { signal: controller.signal });
    if (!res.ok) return null;
    const body = JSON.parse(await res.text());
    // Из пути платформы берём только номер версии: полный путь в следе бесполезен и зависит
    // от машины, а `8.3.27.1688` сравнимо между прогонами.
    const platform = String(body.platform_path || '').match(/8\.3\.\d+\.\d+/)?.[0] || null;
    return { version: body.version || null, platform };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Отметка движка для следа: версия сервера и версия платформы, чья справка загружена. */
export function engineStamp(info) {
  if (!info?.version) return 'bsl-context';
  return info.platform ? `bsl-context@${info.version}/${info.platform}` : `bsl-context@${info.version}`;
}

/**
 * Часовой: доказывает, что справка платформы загружена, а не что сервер ответил.
 *
 * Проверок две, и обе обязательны. Находка на фикстуре — что `hbk` разобран и правила
 * работают. Отсутствие отказа — что запрос вообще принят: промах по `repo` приходит успешным
 * ответом, и без этой проверки часовой рапортовал бы «не найдено» с той же формулировкой,
 * что и при пустой справке, пряча ошибку настройки под видом поломки сервера.
 */
export async function sentinel({ url, repo, timeoutMs = 15000, fetchImpl = globalThis.fetch }) {
  const fixture = join(PLUGIN_ROOT, 'assets', 'platform-context', 'sentinel-fixture.bsl');
  if (!existsSync(fixture)) return { status: 'not_found', reason: 'fixture_missing' };
  const res = await validateModule({
    url,
    repo,
    level: 2,
    timeoutMs,
    moduleText: readFileSync(fixture, 'utf8'),
    modulePath: 'CommonModules/QG_PlatformSentinel/Ext/Module.bsl',
    fetchImpl,
  });
  if (!res.ok) {
    return { status: 'not_found', reason: res.refusal ? 'request_refused' : res.transport };
  }
  if (res.payload?.tree_parsed === false) return { status: 'not_found', reason: 'tree_not_parsed' };
  const hit = (res.payload?.errors || []).some((e) => e.kind === SENTINEL_KIND);
  return hit ? { status: 'found' } : { status: 'not_found', reason: 'finding_absent' };
}

/**
 * Строит записи следа.
 *
 * Отказ сервера и деградация источника имён попадают в след как `not_verified`, а не
 * растворяются в вердикте: проверка, прошедшая без справочника конфигурации, закрывает
 * меньше, чем полная, и читать её как полную нельзя.
 */
export function toEvidence({ findings, sentinelResult, degraded = [], unchecked = [], info = null }) {
  const lines = [];
  const stamp = engineStamp(info);
  lines.push(
    `[qg sentinel: target=${SCOPE}, id=${SENTINEL_KIND}, status=${sentinelResult.status}, engine=${stamp}]`
  );
  if (unchecked.length) {
    lines.push(`[qg not_verified: dimension=platform-api, reason=request_failed, files=${unchecked.length}]`);
  }
  for (const reason of [...new Set(degraded)].sort()) {
    lines.push(`[qg not_verified: dimension=platform-api, reason=${reason}]`);
  }
  const codes = [...new Set(findings.map((f) => f.code))].sort();
  if (codes.length === 0) {
    lines.push(`[qg applied: layer=code, scope=${SCOPE}, ids=[pc:*], verdict=clean]`);
  } else {
    for (const c of codes) {
      lines.push(`[qg applied: layer=code, scope=${SCOPE}, ids=[${c}], verdict=violation:${c}]`);
    }
  }
  return lines;
}

export function skipEvidence(reason) {
  return [`[qg skipped: layer=code, scope=${SCOPE}, planned=[pc:*], reason=${reason}]`];
}

/** Печать для человека: уверенность видна сразу, иначе `low` чинят как подтверждённый дефект. */
export function report(findings, out, { all = false } = {}) {
  const shown = all ? findings : findings.filter((f) => f.severity !== 'info' || f.confidence === 'low');
  const byFile = new Map();
  for (const f of shown) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, list] of [...byFile.entries()].sort()) {
    out(`\n${file}`);
    for (const f of list.sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.line - b.line
    )) {
      const tail = f.confidence === 'low' ? ' [низкая уверенность]' : '';
      out(`  ${SEVERITY_MARK[f.severity]} :${f.line} — ${f.kind}: ${f.message}${tail}`);
    }
  }
  if (findings.some((f) => f.confidence === 'low')) {
    out(
      '\nНаходки с низкой уверенностью проверяйте глазами: типичное ложное срабатывание — ' +
        'переменная названа именем платформенного типа (ЗаписьДанных, Соединение, Блокировка), ' +
        'и имя перебивает вывод типа из присваивания.'
    );
  }
}

function parseArgs(argv) {
  const out = { changed: [], json: false, sentinel: false, evidenceOnly: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--changed') out.changed.push(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--sentinel') out.sentinel = true;
    else if (a === '--evidence') out.evidenceOnly = true;
    else if (a === '--all') out.all = true;
    else if (!a.startsWith('--')) out.changed.push(a);
  }
  return out;
}

const BSL_EXT = /\.(bsl|os)$/i;

async function main(argv) {
  const args = parseArgs(argv.slice(2));
  const out = (s) => process.stdout.write(s + '\n');
  const root = projectRoot();
  const cfg = readPlatformContextConfig(root);

  if (!isConfigured(cfg)) {
    for (const l of skipEvidence(cfg?.enabled ? 'platform_context_not_configured' : 'platform_context_disabled')) {
      out(l);
    }
    if (cfg?.required) {
      process.stderr.write(
        'Контур платформенного API включён как обязательный, но не настроен: задайте platformContext.url и platformContext.repo.\n'
      );
      return 2;
    }
    process.stderr.write('Контур платформенного API выключен — пропущен с отметкой в следе.\n');
    return 1;
  }

  const info = await serverInfo({ url: cfg.url, fetchImpl: globalThis.fetch });
  const sentinelResult = await sentinel({ url: cfg.url, repo: cfg.repo, timeoutMs: cfg.timeoutMs });

  if (args.sentinel) {
    out(
      `Часовой (${engineStamp(info)}): ${sentinelResult.status}` +
        (sentinelResult.reason ? ` — ${sentinelResult.reason}` : '')
    );
    return sentinelResult.status === 'found' ? 0 : 2;
  }

  if (args.changed.length === 0) {
    process.stderr.write('Нечего проверять: не передан ни один --changed <файл>.\n');
    return 2;
  }

  // Правка без единого `.bsl` — законный исход, но НЕ «чисто». Раньше проверка стояла на
  // `args.changed`, а цикл шёл по отфильтрованному списку: набор из одних XML давал ноль
  // итераций и запись `verdict=clean` — ровно тот ложный зелёный вердикт, ради которого этот
  // движок и написан. Состав правки в реальном потоке смешанный: оркестратор передаёт всё,
  // что видит `gate.mjs status`.
  const targets = args.changed.filter((f) => BSL_EXT.test(f));
  if (targets.length === 0) {
    for (const l of skipEvidence('no_bsl_files')) out(l);
    process.stderr.write('В составе правки нет файлов .bsl/.os — контур не применим.\n');
    return 0;
  }

  const findings = [];
  const degraded = [];
  const unchecked = [];
  for (const file of targets) {
    const abs = resolve(file);
    if (!existsSync(abs)) {
      unchecked.push({ file, reason: 'missing' });
      continue;
    }
    const res = await validateModule({
      url: cfg.url,
      repo: cfg.repo,
      level: cfg.level,
      timeoutMs: cfg.timeoutMs,
      moduleText: readFileSync(abs, 'utf8'),
      modulePath: modulePathOf(abs, root),
    });
    if (!res.ok) {
      unchecked.push({ file, reason: res.refusal ? `отказ: ${res.refusal}` : res.transport });
      continue;
    }
    const norm = normalizeFindings(res.payload, { file: modulePathOf(abs, root) });
    findings.push(...norm.findings);
    degraded.push(...norm.degraded);
  }

  const evidence = toEvidence({ findings, sentinelResult, degraded, unchecked, info });

  recordRun({
    scope: SCOPE,
    tool: TOOL,
    verdict: findings.length ? 'violation' : 'clean',
    files: targets.filter((f) => !unchecked.some((u) => u.file === f)),
    unanalyzed: unchecked.length,
    root,
  });

  if (args.json) {
    out(JSON.stringify({ engine: engineStamp(info), sentinel: sentinelResult, findings, degraded, unchecked, evidence }, null, 2));
    return sentinelResult.status === 'found' ? 0 : 2;
  }

  if (!args.evidenceOnly) {
    if (unchecked.length) {
      out(`НЕ ПРОВЕРЕНО файлов: ${unchecked.length} — «чисто» к ним не относится:`);
      for (const u of unchecked) out(`  ${u.file} (${u.reason})`);
    }
    if (degraded.includes('symbols_unavailable')) {
      out('Имена конфигурации серверу недоступны: применены только правила платформы.');
    }
    out(`Движок: ${engineStamp(info)} | часовой: ${sentinelResult.status} | находок: ${findings.length}`);
    report(findings, out, { all: args.all });
  }
  out('\n## quality evidence\n');
  for (const l of evidence) out(l);

  return sentinelResult.status === 'found' ? 0 : 2;
}

if (process.argv[1]?.endsWith('platform-context-run.mjs')) {
  main(process.argv).then((code) => process.exit(code));
}
