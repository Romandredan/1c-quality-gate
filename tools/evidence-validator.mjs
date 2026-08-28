#!/usr/bin/env node
/**
 * Валидатор следа проверок (evidence).
 *
 * Зачем: невыполненная проверка неотличима от выполненной, если после неё ничего не
 * остаётся. Каждая проверка обязана оставить одну машиночитаемую строку — включая
 * ОБОСНОВАННЫЙ пропуск. Валидатор отвергает записи, которые лишь выглядят заполненными.
 *
 * Использование:
 *   node evidence-validator.mjs <файл> [--gate] [--root <каталог проекта>]
 *
 * Режимы:
 *   lint  (по умолчанию) — только оформление; ноль записей = чисто.
 *   gate  (--gate)       — строгий: нужны scope, sentinel=found и хотя бы одна проверка;
 *                          вердикт «чисто» без отметки о непроверенных измерениях отвергается.
 *
 * Коды выхода: 0 — чисто, 1 — предупреждения, 2 — блокирующие нарушения.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolve as resolveConfig, evidenceValue } from './config.mjs';
import { SCOPES, TOOL_BACKED, RENAMED, isKnownScope, isKnownQgId } from './evidence-scopes.mjs';
import { readJournal, coveredFiles } from './run-journal.mjs';
import { projectRoot } from './project-root.mjs';
import { stateDirSegments } from './state-dir.mjs';

export const SECTION = '## quality evidence';

const LAYERS = ['code', 'arch', 'xml', 'hygiene'];
const VOLUMES = ['C0', 'C1', 'C2', 'C3'];

/**
 * Измерения, которые доступными средствами не проверяются, и потому обязаны быть заявлены.
 *
 * `compilation` — тела модулей: ни выгрузка, ни валидаторы XML их не компилируют.
 * `query-execution` — текст запроса: он строковый литерал, его не разбирает ни анализатор,
 * ни сборка бинарника. Ошибка вроде «Неоднозначное поле» доживает до первого выполнения.
 * `static-analysis` и `cross-config-resolution` печатает `analyzer-run.mjs`, когда файл не
 * разобран или основной конфигурации нет.
 * `artifact-freshness` печатает `gate.mjs release`, когда собранный артефакт старше своих
 * исходников (по парам из секции `artifacts` настройки проекта).
 *
 * Список закрытый: опечатка в имени измерения оставила бы запись, которая выглядит
 * заполненной, но ничего не закрывает. Пополнять его нужно вместе с инструментом, который
 * новое имя печатает, — иначе валидатор ругается на собственный вывод плагина.
 */
const DIMENSIONS = ['compilation', 'query-execution', 'static-analysis', 'cross-config-resolution', 'artifact-freshness'];

/**
 * Метки архетипов из таблицы `quality-gate/SKILL.md`.
 *
 * Поле `archetypes` пишет модель, инструмент его не печатает — и на нём завязано требование
 * об исполнении запроса. Метка `queries` вместо `query` не сработала бы ничем: требование
 * молча не предъявляется, гейт снимается, а в отчёте всё выглядит заполненным. Поэтому
 * список закрытый, а проектные архетипы добавляются к нему из `archetypes.custom`.
 *
 * `none` — законная форма «ни одна метка не сработала»: пустой список запрещён отдельно.
 */
const ARCHETYPES = [
  'none',
  'query',
  'transaction',
  'record-set',
  'object-event',
  'integration',
  'rights',
  'cfe-patch',
  'scheduled-job',
  'client-server',
  'user-dialog',
  'form-module',
  'async-client',
  'new-common-module',
  'new-metadata-object',
];

/** Поля, без которых запись бессмысленна. Пустое значение приравнивается к отсутствию. */
const REQUIRED = {
  scope: ['volume', 'files', 'archetypes', 'driver', 'resolved'],
  applied: ['layer', 'scope', 'ids', 'verdict'],
  skipped: ['layer', 'reason'],
  not_verified: ['dimension', 'reason'],
  sentinel: ['target', 'status'],
};

// `bslls:*` — законный идентификатор «весь набор правил анализатора»: перечислять полторы
// сотни проверенных кодов в чистом прогоне бессмысленно, а формат уже использует эту форму
// в поле `planned` записи skipped.
// Пространство `qg:` проверяется не формой, а реестром (`QG_IDS` в evidence-scopes.mjs):
// форма пропускала любое правдоподобное имя, и в живой сессии больше половины `qg:*` в
// отчётах не существовало в плагине. Шаблон ниже — для ЧУЖИХ пространств, у которых
// собственного реестра здесь нет.
const ID_PATTERN = /^(std\d{3,4}|bslls:(\*|[A-Za-z][\w-]*)|acc:\d{3,4}|v8cs:[\w-]+|patterns:[\w:-]+)$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Настройка, применённая к прогону: `default` либо `custom:<секция>[+<секция>]`. Печатает её
// `tools/config.mjs show`, откуда она и переносится в след. Список секций закрытый: выдуманное
// имя означает, что строку сочинили, а не скопировали из вывода инструмента.
const CONFIG_SECTIONS = ['analyzer', 'volume', 'complexity', 'archetypes', 'sentinel', 'artifacts'];
const CONFIG_PATTERN = new RegExp(`^(default|custom:(${CONFIG_SECTIONS.join('|')})(\\+(${CONFIG_SECTIONS.join('|')}))*)$`);

/**
 * Внешний источник, которым подтверждается идентификатор.
 *
 * Наши собственные эвристики (`qg:`, `patterns:`) внешнего источника не имеют — часового по
 * ним требовать не с кого. Всё остальное опирается на живой сервис или на живой анализатор,
 * и «нарушений нет» по такому идентификатору достоверно лишь тогда, когда источник отвечал.
 */
function sentinelTarget(id) {
  if (id.startsWith('bslls:')) return 'bslls';
  if (/^std\d/.test(id) || id.startsWith('acc:') || id.startsWith('v8cs:')) return 'v8std';
  return null;
}

/** Разбирает `k=v, k=[a,b]` в объект. Списки отличаются от скаляров по квадратным скобкам. */
function parseFields(body) {
  const fields = {};
  let i = 0;
  while (i < body.length) {
    const eq = body.indexOf('=', i);
    if (eq === -1) break;
    const key = body.slice(i, eq).trim().replace(/^,\s*/, '');
    let value;
    let j = eq + 1;
    while (j < body.length && body[j] === ' ') j++;
    if (body[j] === '[') {
      const close = body.indexOf(']', j);
      if (close === -1) {
        value = body.slice(j).trim();
        i = body.length;
      } else {
        value = body
          .slice(j + 1, close)
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        i = close + 1;
      }
    } else {
      let comma = body.indexOf(',', j);
      if (comma === -1) comma = body.length;
      value = body.slice(j, comma).trim();
      i = comma;
    }
    if (key) fields[key] = value;
    while (i < body.length && (body[i] === ',' || body[i] === ' ')) i++;
  }
  return fields;
}

/**
 * Вытаскивает записи вида `[qg <тип>: ...]` из секции evidence.
 *
 * Запись может занимать несколько строк: длинный `scope` естественно переносится, и
 * отвергать его за перенос значило бы наказывать за форматирование. Незакрытая запись
 * склеивается со следующими строками до закрывающей скобки.
 */
export function extractRecords(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === SECTION);
  const offset = start === -1 ? 0 : start + 1;
  const scan = start === -1 ? lines : lines.slice(start + 1);

  const records = [];
  for (let i = 0; i < scan.length; i++) {
    if (!/^\s*\[qg\s/.test(scan[i])) continue;

    let buffer = scan[i].trim();
    let consumed = 0;
    // Собираем продолжение, пока запись не закрыта. Пустая строка и начало новой записи
    // прерывают сбор: незакрытая запись должна упасть как дефект, а не съесть соседей.
    while (!buffer.endsWith(']') && i + consumed + 1 < scan.length) {
      const next = scan[i + consumed + 1];
      if (!next.trim() || /^\s*\[qg\s/.test(next)) break;
      buffer += ' ' + next.trim();
      consumed++;
    }

    const m = buffer.match(/^\[qg\s+([a-z_]+)\s*:\s*(.*)\]$/);
    if (m) {
      records.push({
        type: m[1],
        fields: parseFields(m[2]),
        line: offset + i + 1,
        raw: buffer,
      });
    } else {
      records.push({ type: '__malformed__', fields: {}, line: offset + i + 1, raw: buffer });
    }
    i += consumed;
  }
  return records;
}

/**
 * Проверяет имя проверки по закрытому словарю.
 *
 * Раньше здесь стояла проверка на kebab-case, и любое похожее на имя слово проходило. Этим
 * пользовалась не злая воля, а документация: она предлагала `static-diagnostics` и
 * `lsp-diagnostics` там, где инструмент печатает `static-analysis`. Запись со свободным
 * именем закрывает требование, которого нет, — и выглядит при этом как проверка.
 *
 * Переименованные имена называются вместе с заменой: «неизвестный scope» без подсказки
 * заставляет гадать, а прежние отчёты ещё существуют.
 */
function checkScopeName(rec, add) {
  const scope = rec.fields.scope;
  if (!scope) return;
  if (isKnownScope(scope)) {
    const expected = SCOPES[scope].layer;
    if (rec.fields.layer && rec.fields.layer !== expected) {
      add('warn', rec.line, `scope="${scope}" относится к слою ${expected}, а в записи layer=${rec.fields.layer}`);
    }
    return;
  }
  if (RENAMED[scope]) {
    add('error', rec.line, `scope="${scope}" переименован — правильно "${RENAMED[scope]}"`);
    return;
  }
  if (!KEBAB.test(scope)) {
    add('error', rec.line, `scope="${scope}" не в kebab-case и не из словаря проверок`);
    return;
  }
  add(
    'error',
    rec.line,
    `scope="${scope}" не из словаря проверок (tools/evidence-scopes.mjs): ` +
      'запись выглядит заполненной, но не соответствует ни одной проверке плагина'
  );
}

function isEmpty(value) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return String(value).trim().length === 0;
}

/**
 * Время последней зафиксированной правки — граница годности доказательств.
 *
 * Прогон инструмента, сделанный до правки файла, доказывает состояние, которого уже нет.
 * Состояние гейта читается напрямую, без импорта `gate.mjs`: тот сам вызывает валидатор, и
 * импорт был бы кольцевым.
 *
 * Граница берётся ТОЛЬКО из своей сессии. Максимум по всем сессиям вернул бы через чёрный
 * ход ровно то, что состояние гейта разделяет по сессиям намеренно: правка в соседней сессии
 * в 14:00 обесценивала бы прогон, честно сделанный в 13:00 по своим файлам. Когда сессия не
 * названа, а их несколько, определить свою нечем — тогда ограничения по времени нет, и
 * проверка вырождается в «отметка о прогоне вообще есть». Требовать больше значило бы
 * блокировать добросовестную работу по чужой активности.
 */
function ownSession(root, sessionId = null) {
  const file = join(root, ...stateDirSegments(), 'qg-pending.json');
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const sessions = state?.sessions || {};
    const ids = Object.keys(sessions);
    const own = sessionId && ids.includes(sessionId) ? sessionId : ids.length === 1 ? ids[0] : null;
    if (!own) return null;
    const s = sessions[own] || {};
    return {
      since: String(s.updatedAt || s.armedAt || '') || null,
      files: Object.keys(s.files || {}).map((p) => p.split('\\').join('/').toLowerCase()),
    };
  } catch {
    return null;
  }
}

/**
 * Покрыт ли файл прогоном инструмента.
 *
 * Совпадение по префиксу каталога обязательно: валидаторам XML путь дают и файлом
 * (`.../Ext/Rights.xml`), и каталогом объекта (`Roles/QG_Роль`), а состав правки хранит
 * файлы. Без этого правки роли давали бы отказ на честно прогнанной проверке.
 */
function isCovered(file, covered) {
  if (covered.has(file)) return true;
  for (const c of covered) {
    if (c && file.startsWith(c.endsWith('/') ? c : `${c}/`)) return true;
  }
  return false;
}

export function validate(text, { gate = false, root = null, session = null } = {}) {
  const projectDir = root || projectRoot();
  const problems = [];
  const add = (severity, line, message) => problems.push({ severity, line, message });

  const records = extractRecords(text);

  for (const rec of records) {
    if (rec.type === '__malformed__') {
      add('error', rec.line, `запись не разобрана (не закрыта скобка или сломан формат): ${rec.raw.slice(0, 80)}`);
      continue;
    }
    const required = REQUIRED[rec.type];
    if (!required) {
      add('error', rec.line, `неизвестный тип записи "${rec.type}" (ожидались: ${Object.keys(REQUIRED).join(', ')})`);
      continue;
    }

    for (const field of required) {
      if (isEmpty(rec.fields[field])) {
        // Пустой обязательный список — не «проверил ничего», а отсутствие проверки.
        add('error', rec.line, `поле "${field}" отсутствует или пустое`);
      }
    }

    if (rec.fields.layer && !LAYERS.includes(rec.fields.layer)) {
      add('error', rec.line, `layer="${rec.fields.layer}" вне списка ${LAYERS.join('|')}`);
    }
    if (rec.type === 'scope' && rec.fields.volume && !VOLUMES.includes(rec.fields.volume)) {
      add('error', rec.line, `volume="${rec.fields.volume}" вне списка ${VOLUMES.join('|')}`);
    }
    if (rec.type === 'scope' && rec.fields.config && !CONFIG_PATTERN.test(String(rec.fields.config))) {
      add(
        'error',
        rec.line,
        `config="${rec.fields.config}": ожидается default либо custom:<секция>[+<секция>] ` +
          `(${CONFIG_SECTIONS.join(', ')}) — строку печатает config.mjs show`
      );
    }
    // В нестрогом режиме отсутствие поля — предупреждение: отчёты, собранные до появления
    // этого поля, читать и линтовать по-прежнему можно. Снятие гейта его требует.
    if (rec.type === 'scope' && !gate && isEmpty(rec.fields.config)) {
      add('warn', rec.line, 'в записи scope нет поля config: неизвестно, по чьим порогам выбрана глубина');
    }
    if (rec.type === 'skipped') checkScopeName(rec, add);
    if (rec.type === 'applied') {
      const v = rec.fields.verdict;
      if (v && v !== 'clean' && !/^violation:.+/.test(v)) {
        add('error', rec.line, `verdict="${v}": ожидается clean либо violation:<id>`);
      }
      checkScopeName(rec, add);
      const ids = Array.isArray(rec.fields.ids) ? rec.fields.ids : [];
      for (const id of ids) {
        // Свои признаки — только из реестра, и это ошибка, а не предупреждение: вымышленный
        // `qg:*` делает отчёт строже настоящего, ничем при этом не проверив. Чужие
        // пространства (std, bslls, acc, v8cs) проверяются формой — их реестры не наши.
        if (id.startsWith('qg:')) {
          if (!isKnownQgId(id)) {
            add(
              'error',
              rec.line,
              `идентификатор "${id}" не из реестра признаков (tools/evidence-scopes.mjs): ` +
                'такого признака у плагина нет — запись выглядит проверкой, но не соответствует ни одной'
            );
          }
        } else if (!ID_PATTERN.test(id)) {
          add('warn', rec.line, `идентификатор "${id}" непохож на stdNNN / bslls:X / acc:NNN / v8cs:X`);
        }
      }
    }
    if (rec.type === 'sentinel' && rec.fields.status && !['found', 'not_found'].includes(rec.fields.status)) {
      add('error', rec.line, `status="${rec.fields.status}": ожидается found|not_found`);
    }
    if (rec.type === 'not_verified' && rec.fields.dimension && !DIMENSIONS.includes(String(rec.fields.dimension))) {
      add(
        'warn',
        rec.line,
        `dimension="${rec.fields.dimension}" вне списка ${DIMENSIONS.join('|')}: ` +
          'запись выглядит заполненной, но требуемое измерение не закрывает'
      );
    }
  }

  // Измерение считается закрытым, если о нём заявлено: либо оно проверено (запись applied с
  // тем же именем в scope), либо признано непроверяемым (not_verified). Молчание — нет.
  //
  // Два пространства имён здесь намеренно сведены в одно, и это накладывает ограничение на
  // будущие требования: имя измерения не должно совпадать с распространённым `scope` записи
  // applied, иначе требование удовлетворялось бы само собой. Так, `static-analysis` —
  // одновременно измерение и scope, которые печатает `analyzer-run.mjs`; сегодня закрывать
  // его никто не требует, но новое требование по такому имени было бы пустым.
  const closes = new Set();
  for (const rec of records) {
    if (rec.type === 'not_verified' && rec.fields.dimension) closes.add(String(rec.fields.dimension).trim());
    if (rec.type === 'applied' && rec.fields.scope) closes.add(String(rec.fields.scope).trim());
  }

  // Настройка проекта нужна дважды: для сверки поля `config` и для списка проектных
  // архетипов. Читается один раз; если не читается — сверять не с чем, и требования,
  // опирающиеся на неё, смягчаются до предупреждения.
  let project = null;
  try {
    project = resolveConfig(projectDir);
  } catch {
    /* настройка недоступна */
  }
  const knownArchetypes = new Set([
    ...ARCHETYPES,
    ...(project?.values?.archetypes?.custom || []).map((a) => String(a?.name ?? '').trim()).filter(Boolean),
  ]);

  const archetypesOf = (rec) => (Array.isArray(rec.fields.archetypes) ? rec.fields.archetypes : []);

  // Метка архетипа — единственное поле следа, от которого зависит требование и которое при
  // этом пишет модель, а не инструмент. Опечатка здесь не даёт ни ошибки, ни находки: правило
  // просто не предъявляется, и гейт снимается на полном молчании.
  for (const rec of records.filter((r) => r.type === 'scope')) {
    for (const label of archetypesOf(rec)) {
      if (knownArchetypes.has(label)) continue;
      add(
        project && gate ? 'error' : 'warn',
        rec.line,
        `архетип "${label}" не из таблицы quality-gate и не объявлен в archetypes.custom: ` +
          'требования, привязанные к архетипам, по такой метке не сработают'
      );
    }
  }

  // Архетип «запрос» обязывает отчитаться о выполнении запроса. Прогон, который его ни разу
  // не выполнил, вправе так и написать — но не вправе промолчать: статический разбор текста
  // запроса не заменяет попытки его выполнить.
  const queryArchetype = records.some((r) => r.type === 'scope' && archetypesOf(r).includes('query'));
  if (queryArchetype && !closes.has('query-execution')) {
    add(
      gate ? 'error' : 'warn',
      records.find((r) => r.type === 'scope')?.line || 0,
      'сработал архетип query, но об исполнении запроса не заявлено: нужна запись ' +
        '[qg applied: layer=code, scope=query-execution, ...] либо ' +
        '[qg not_verified: dimension=query-execution, reason=no_platform]'
    );
  }

  if (!gate) {
    return { records, problems, exitCode: problems.some((p) => p.severity === 'error') ? 2 : problems.length ? 1 : 0 };
  }

  // --- строгий режим ---------------------------------------------------------
  if (records.length === 0) {
    add('error', 0, 'нет ни одной записи: прогон без следа не считается выполненным');
  }

  const scopes = records.filter((r) => r.type === 'scope');
  if (scopes.length === 0) add('error', 0, 'нет записи scope: неизвестно, как выбиралась глубина проверки');
  if (scopes.length > 1) add('error', scopes[1].line, 'записей scope больше одной: профиль изменения определяется один раз');

  // Настройка проекта меняет пороги, по которым выбран класс. Без этой отметки «C1» в одном
  // отчёте не означает того же, что «C1» в другом, а прогон, не заглянувший в настройку,
  // неотличим от прогона, который её учёл.
  //
  // Отметка не принимается на слово, а СВЕРЯЕТСЯ с фактической настройкой проекта. Заявление,
  // которое никто не проверяет, — это ровно та подпись под непрогнанной проверкой, против
  // которой написан весь формат: приписать `config=default` в проекте с задранными порогами
  // не сложнее, чем забыть посмотреть настройку.
  // Настройка прочитана выше — сверять не с чем только тогда, когда её не удалось прочесть.
  const actual = project ? evidenceValue(project) : null;
  for (const s of scopes) {
    if (isEmpty(s.fields.config)) {
      add(
        'error',
        s.line,
        'в записи scope нет поля config: неизвестно, по чьим порогам выбрана глубина — ' +
          'строку печатает `node tools/config.mjs show`'
      );
    } else if (actual && String(s.fields.config) !== actual) {
      add(
        'error',
        s.line,
        `config="${s.fields.config}" расходится с настройкой проекта (сейчас "${actual}"): ` +
          'след относится к другим порогам — перепроверь профиль и перенеси строку из `config.mjs show`'
      );
    }
  }

  const checks = records.filter((r) => r.type === 'applied' || r.type === 'skipped');
  if (checks.length === 0) add('error', 0, 'нет ни одной записи applied/skipped: ни один контур не отчитался');

  const sentinels = records.filter((r) => r.type === 'sentinel');
  if (sentinels.length === 0) {
    add('error', 0, 'нет записи sentinel: невозможно отличить «нарушений нет» от «источник стандартов недоступен»');
  } else if (!sentinels.some((s) => s.fields.status === 'found')) {
    add('error', sentinels[0].line, 'sentinel не подтверждён (status=not_found): результат прогона недостоверен');
  }

  const applied = records.filter((r) => r.type === 'applied');

  // Часовой проверяется ПО ЦЕЛЯМ, а не «хотя бы один живой».
  //
  // Иначе подтверждённый v8std маскирует мёртвый анализатор: в следе стоит `bslls:...` с
  // вердиктом clean, рядом `sentinel target=v8std status=found` — и правило выполнено, хотя
  // про анализатор неизвестно ничего. Каждое «нарушений нет» обязано опираться на источник,
  // который в этом прогоне доказал, что жив.
  const neededTargets = new Set();
  for (const rec of applied) {
    if (rec.fields.verdict !== 'clean') continue;
    const ids = Array.isArray(rec.fields.ids) ? rec.fields.ids : [];
    for (const id of ids) {
      const target = sentinelTarget(id);
      if (target) neededTargets.add(target);
    }
  }
  for (const target of [...neededTargets].sort()) {
    const confirmed = sentinels.some((s) => s.fields.target === target && s.fields.status === 'found');
    if (!confirmed) {
      add(
        'error',
        0,
        `вердикт «clean» опирается на источник "${target}", но подтверждённого часового по нему нет ` +
          `(нужна запись sentinel с target=${target} и status=found)`
      );
    }
  }

  // Вердикт «чисто» обязан признавать то, что проверить было нечем.
  //
  // Требование именно по измерению `compilation`, а не «хотя бы одна запись not_verified».
  // Иначе появление второго измерения ослабляет проверку: прогон заявляет непроверенным
  // что-нибудь одно, о компилируемости молчит — и полностью зелёный отчёт снова проходит.
  const allClean = applied.length > 0 && applied.every((r) => r.fields.verdict === 'clean');
  if (allClean && !closes.has('compilation')) {
    add(
      'error',
      0,
      'все проверки «clean», но компилируемость тел модулей не заявлена. Её не проверяет ни выгрузка ' +
        'конфигурации, ни валидаторы XML — если /CheckConfig не запускался, нужна запись ' +
        '[qg not_verified: dimension=compilation, reason=no_platform]'
    );
  }

  // --- сверка с журналом прогонов --------------------------------------------
  //
  // У части проверок есть исполняемый инструмент. Для них строка `applied` обязана
  // происходить из прогона: инструмент печатает её сам и одновременно отмечается в журнале.
  // Без этой сверки вердикт, полученный чтением кода глазами, попадает в отчёт в том же
  // виде, что и полученный прогоном, — наблюдалось в живой сессии четыре раза подряд.
  //
  // Чего сверка НЕ делает: она не доказывает, что инструмент проверял именно эти файлы, и
  // не защищает от записи, дописанной в журнал вручную. Независимого источника, из которого
  // такое можно перевывести, у плагина нет. Это обнаружение молчания, и только.
  const journal = readJournal(projectDir);
  const own = ownSession(projectDir, session);
  const since = own?.since || null;
  const fresh = journal.filter((r) => !since || String(r.ts || '') >= since);
  const runScopes = new Set(fresh.map((r) => r.scope));

  // `skipped` с причиной `not_applicable` или `no_queries_found` — тоже утверждение о
  // работе инструмента: кто-то посмотрел файлы и заключил, что правило к ним не относится
  // (или что запросов в них нет). Инструменты такую отметку ставят; без требования она была
  // бы дырой ровно того же вида, что и вердикт без прогона, только шире — ею закрывается
  // любая проверка. Прочие причины (инструмент недоступен, контур не установлен) отметки не
  // требуют: писать её некому.
  const claimsRun = [
    ...applied,
    ...records.filter(
      (r) =>
        r.type === 'skipped' &&
        ['not_applicable', 'no_queries_found', 'no_metadata_resolved'].includes(String(r.fields.reason || ''))
    ),
  ];

  for (const rec of claimsRun) {
    const scope = String(rec.fields.scope || '');
    const tool = TOOL_BACKED[scope];
    if (!tool) continue;
    if (!runScopes.has(scope)) {
      const ranEarlier = journal.some((r) => r.scope === scope);
      add(
        'error',
        rec.line,
        ranEarlier
          ? `проверка "${scope}" заявлена как выполненная, но последний прогон ${tool} старше ` +
            'последней правки файлов: доказательство относится к прежнему состоянию — прогони заново'
          : `проверка "${scope}" заявлена как выполненная, но ${tool} в этом прогоне не запускался. ` +
            'Строку следа печатает сам инструмент — запусти его и перенеси вывод'
      );
      continue;
    }

    // Прогон был — но по тем ли файлам? Без этой сверки инструмент, запущенный по одному
    // файлу, закрывал заявление обо всех изменённых.
    const meta = SCOPES[scope] || {};
    if (meta.granularity !== 'files' || !own) continue;
    const { files: covered, unknown } = coveredFiles(projectDir, scope, since);
    // Записи прежнего формата хранили количество, а не пути: сверять нечем, и обвинять не в
    // чем — прогон был. Молчать об этом тоже нельзя, отсюда предупреждение.
    if (unknown) {
      add('warn', rec.line, `в журнале нет путей для "${scope}": покрытие не сверено (запись прежнего формата)`);
      continue;
    }
    const applicable = own.files.filter((f) => !meta.applies || meta.applies.some((ext) => f.endsWith(ext)));
    const missing = applicable.filter((f) => !isCovered(f, covered));
    if (missing.length) {
      // Строгость — только там, где инструмент применим к каждому файлу своего расширения.
      // У проверки структуры это не так: часть служебных XML выгрузки не проверяет никто, и
      // ошибка на них была бы находкой за отсутствующий инструмент.
      add(
        meta.coverage === 'advisory' ? 'warn' : 'error',
        rec.line,
        `проверка "${scope}" заявлена по всей правке, но ${tool} не видел ${missing.length} из ` +
          `${applicable.length} подходящих файлов: ${missing.slice(0, 3).join(', ')}` +
          (missing.length > 3 ? ' и др.' : '') +
          ' — прогони инструмент по всему составу правки'
      );
    }
  }

  // Инструмент сообщает в журнал, сколько изменённых файлов он НЕ смотрел. Если такие есть,
  // отчёт обязан их признать: «нарушений не найдено» по непрочитанному файлу — самая дорогая
  // из возможных ложных зелёных отметок.
  const lastStatic = [...fresh].reverse().find((r) => r.scope === 'static-analysis');
  const declaredUnanalyzed = records.some(
    (r) => r.type === 'not_verified' && String(r.fields.dimension || '') === 'static-analysis'
  );
  if (lastStatic && Number(lastStatic.unanalyzed) > 0 && !declaredUnanalyzed) {
    add(
      'error',
      0,
      `анализатор не смотрел ${lastStatic.unanalyzed} из изменённых файлов, а в следе это не заявлено: ` +
        'нужна запись [qg not_verified: dimension=static-analysis, reason=not_in_analyzer_report, files=N] — ' +
        'её печатает analyzer-run.mjs'
    );
  }

  // То же требование для остальных инструментов, которые считают непроверенные файлы. Правило
  // общее намеренно: правило под одно имя (`static-analysis` выше) пришлось бы дописывать на
  // каждый новый инструмент, а пока оно не дописано — молчание о непроверенном снова проходит.
  for (const scope of new Set(fresh.filter((r) => Number(r.unanalyzed) > 0).map((r) => r.scope))) {
    if (scope === 'static-analysis') continue; // разобрано выше, со своим текстом
    const last = [...fresh].reverse().find((r) => r.scope === scope);
    const declared = records.some(
      (r) => (r.type === 'skipped' || r.type === 'not_verified') && String(r.fields.scope || '') === scope
    );
    if (!declared) {
      add(
        'error',
        0,
        `${last.tool || scope} не проверил ${last.unanalyzed} из переданных файлов, а в следе это не ` +
          `заявлено: нужна запись [qg skipped: ... scope=${scope}, reason=..., files=N] — её печатает сам инструмент`
      );
    }
  }

  const errors = problems.filter((p) => p.severity === 'error').length;
  return { records, problems, exitCode: errors ? 2 : problems.length ? 1 : 0 };
}

function main(argv) {
  const args = argv.slice(2);
  const gate = args.includes('--gate');
  // Корень проекта обычно определяется сам. Явный `--root` нужен, когда отчёт проверяют для
  // чужого дерева — например, из тестов: журнал прогонов и настройка лежат в проекте, а не
  // рядом с файлом отчёта.
  const rootArg = args.indexOf('--root');
  const root = rootArg === -1 ? null : args[rootArg + 1];
  const skip = rootArg === -1 ? -1 : rootArg + 1;
  const file = args.find((a, i) => !a.startsWith('--') && i !== skip);

  if (!file) {
    process.stderr.write('Использование: node evidence-validator.mjs <файл> [--gate]\n');
    return 2;
  }
  if (!existsSync(file)) {
    process.stderr.write(`Файл не найден: ${file}\n`);
    return 2;
  }

  const { records, problems, exitCode } = validate(readFileSync(file, 'utf8'), { gate, root });

  for (const p of problems) {
    const where = p.line ? `${file}:${p.line}` : file;
    process.stdout.write(`${p.severity === 'error' ? 'ОШИБКА' : 'ПРЕДУПРЕЖДЕНИЕ'} ${where} — ${p.message}\n`);
  }

  const errors = problems.filter((p) => p.severity === 'error').length;
  const warns = problems.length - errors;
  process.stdout.write(
    `\nЗаписей: ${records.length}. Ошибок: ${errors}, предупреждений: ${warns}. Режим: ${gate ? 'gate' : 'lint'}.\n`
  );
  return exitCode;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('evidence-validator.mjs')) {
  process.exit(main(process.argv));
}
