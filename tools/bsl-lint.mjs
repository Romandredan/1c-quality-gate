#!/usr/bin/env node
/**
 * Лексические проверки кода BSL — то, что видно по тексту модуля и его пути.
 *
 * Проверки:
 *   - `qg:BSL-TXN-IN-HANDLER` — собственная транзакция внутри обработчика события объекта,
 *     который платформа и так выполняет в транзакции;
 *   - `qg:BSL-ENUM-STRING-ASSIGN` — присваивание примитива ("", 0, Ложь, Истина) полю,
 *     которое по XML объекта метаданных имеет строго ссылочный тип (EnumRef, CatalogRef…).
 *     Сборка на такое молчит — тела модулей не компилируются, — а падение приходит при
 *     записи, часто в редко исполняемой ветке. Пустое значение ссылки — `ПустаяСсылка()`.
 *   - `qg:BSL-UNBOUNDED-STRING-COLUMN` — колонка таблицы, объявленная как «Строка» без
 *     `КвалификаторыСтроки`, у таблицы, которая в том же модуле уходит в
 *     `УстановитьПараметр`. Поле неограниченной длины движок запросов не умеет сравнивать:
 *     `РАЗЛИЧНЫЕ`, `СГРУППИРОВАТЬ ПО`, соединение, `ГДЕ` (#std432 п. 3.1).
 *   - `qg:BSL-DISPATCH-NO-FALLBACK` — цепочка `Если … ИначеЕсли …` перебирает значения
 *     перечисления или типы документа в трёх и более ветках и не закрыта веткой `Иначе`.
 *     Значение, не попавшее ни в одну ветку, проходит цепочку молча, и метод продолжает
 *     работу так, будто разбор состоялся.
 *   - `qg:BSL-FORM-ATTR-SHADOW` — в модуле формы локальная переменная названа именем реквизита
 *     примитивного типа. Присваивание уходит В РЕКВИЗИТ и приводится к его типу, обращение
 *     через точку падает в рантайме. В `&НаСервереБезКонтекста` контекста формы нет, и там тот
 *     же код работает — оттого дефект выглядит случайным.
 *
 * Зачем отдельный инструмент, а не правило в своде. Правило «не открывай транзакцию в
 * обработчике» формулируется одной строкой и ровно поэтому его легко не применить: проверка
 * «посмотри внимательно» неотличима от непроведённой. Условие срабатывания здесь текстовое —
 * имя обработчика из закрытого списка, модуль объекта или набора записей, вызов
 * `НачатьТранзакцию` в теле, — и потому считается механически.
 *
 * Почему не в `query-lint.mjs`: у того контракт — строковые литералы текстов запросов, это
 * записано в его шапке. Проверки уровня модуля живут здесь.
 *
 * Приближения заявлены прямо:
 *   - логика, вынесенная из обработчика в общий модуль, инструменту не видна: он читает один
 *     файл и графа вызовов не строит;
 *   - модуль определяется по имени файла (`ObjectModule.bsl`, `RecordSetModule.bsl`);
 *     переименованный или собранный на лету модуль в проверку не попадёт;
 *   - для присваиваний приёмник НЕ разрешается: `Запись.Статус = ""` даёт находку и тогда,
 *     когда «Запись» — структура со строковым полем того же имени. Поэтому находка —
 *     предупреждение, а не ошибка, и это сказано в её тексте;
 *   - XML объекта ищется вверх от модуля (`<Вид>/<Имя>/Ext/*.bsl` → `<Вид>/<Имя>.xml`);
 *     модуль вне выгрузки метаданных проверяется только на транзакции;
 *   - имена обработчиков только русские: английские идентификаторы платформа понимает, но в
 *     прикладном коде они не встречаются;
 *   - колонка без квалификатора связывается с запросом только через `УстановитьПараметр` в
 *     ТОМ ЖЕ модуле и по корневому идентификатору таблицы. Самая коварная форма — таблица
 *     уходит параметром в чужой метод, и запрос делает он — здесь не ловится вообще: графа
 *     вызовов инструмент не строит. Эта половина остаётся за читателем (`qg:AI-16`);
 *   - тип колонки читается только из литерала прямо в вызове: `ОписаниеТипов`, собранное
 *     в переменную выше по тексту, инструменту не видно;
 *   - реквизиты формы читаются из `Ext/Form.xml` рядом с модулем и только примитивных типов:
 *     у реквизита-таблицы обращение через точку законно, а у составного типа законно и
 *     объектное присваивание. Переменная, названная именем КОЛОНКИ реквизита-таблицы,
 *     безопасна и в проверку не попадает.
 *
 * Использование:
 *   node bsl-lint.mjs <файл.bsl> [<файл.bsl> ...] [--json]
 *
 * Коды возврата: 0 — чисто, 1 — есть предупреждения, 2 — есть ошибки либо ошибка вызова.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { recordRun } from './run-journal.mjs';
import { versionSuffix } from './config.mjs';

/** Символы идентификатора 1С: кириллица делает `\b` в JS бесполезной. */
const W = 'A-Za-zА-Яа-яЁё0-9_';
const IDENT = `[A-Za-zА-Яа-яЁё_][${W}]*`;

function word(w, flags = 'gi') {
  return new RegExp(`(?<![${W}])(?:${w})(?![${W}])`, flags);
}

/**
 * Модули, где платформа открывает транзакцию сама.
 *
 * Модуль менеджера сюда не входит: его методы вызываются вне неявной транзакции, и
 * `НачатьТранзакцию` в них — штатная форма. Модуль формы тем более: обработчик `ПередЗаписью`
 * формы — другое событие, к транзакции записи объекта отношения не имеющее. Без этого
 * различения проверка давала бы находку на каждой форме с таким обработчиком.
 */
const IMPLICIT_TRANSACTION_MODULES = new Set(['ObjectModule.bsl', 'RecordSetModule.bsl']);

/**
 * Обработчики, тело которых исполняется внутри транзакции, открытой платформой.
 *
 * `ПередЗаписью`, `ПриЗаписи`, `ПередУдалением` — вокруг записи и удаления ссылочного объекта;
 * `ОбработкаПроведения` и `ОбработкаУдаленияПроведения` — вокруг проведения и отмены.
 */
const TRANSACTIONAL_HANDLERS = new Set([
  'передзаписью',
  'призаписи',
  'передудалением',
  'обработкапроведения',
  'обработкаудаленияпроведения',
]);

/**
 * Гасит комментарии и строковые литералы, сохраняя длину текста.
 *
 * Длина важна: позиция находки в маске равна позиции в исходном файле, иначе пришлось бы
 * вести карту смещений — а она разъезжается первой.
 */
export function maskModule(source) {
  const chars = source.split('');
  let i = 0;
  let inString = false;
  while (i < chars.length) {
    if (!inString && chars[i] === '/' && chars[i + 1] === '/') {
      while (i < chars.length && chars[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }
    if (chars[i] === '"') {
      // Удвоенная кавычка внутри литерала — экранирование, а не его конец.
      if (inString && chars[i + 1] === '"') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
        continue;
      }
      chars[i] = ' ';
      inString = !inString;
      i++;
      continue;
    }
    if (inString && chars[i] !== '\n') chars[i] = ' ';
    i++;
  }
  return chars.join('');
}

/** Тела процедур и функций модуля: имя, границы, смещение начала тела. */
export function parseRoutines(masked) {
  const routines = [];
  const header = new RegExp(`(?<![${W}])(Процедура|Функция)\\s+(${IDENT})\\s*\\(`, 'giu');
  const ends = { Процедура: word('КонецПроцедуры'), Функция: word('КонецФункции') };

  let m;
  while ((m = header.exec(masked)) !== null) {
    const kind = m[1];
    const name = m[2];
    const endRe = ends[kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase()] || ends['Процедура'];
    endRe.lastIndex = m.index;
    const end = endRe.exec(masked);
    routines.push({
      name,
      start: m.index,
      bodyStart: m.index + m[0].length,
      end: end ? end.index : masked.length,
    });
  }
  return routines;
}

function lineAt(source, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

/**
 * Своя транзакция внутри неявной.
 *
 * Платформа открывает транзакцию вокруг записи, удаления и проведения объекта. Вложенных
 * транзакций она не поддерживает: `НачатьТранзакцию` внутри обработчика создаёт видимость
 * точки сохранения, а `ОтменитьТранзакцию` в нём отменяет ВНЕШНЮЮ транзакцию целиком.
 * Дальше внешний код продолжает работу с уже отменённой транзакцией и получает
 * «В этой транзакции уже происходили ошибки» — в месте, не связанном с причиной.
 *
 * Якорь: #std783 п. 1.4 и 1.4.1.
 */
export function lintSource(source, fileName) {
  if (!IMPLICIT_TRANSACTION_MODULES.has(fileName)) return [];

  const masked = maskModule(source);
  const findings = [];
  const beginRe = word('НачатьТранзакцию');

  for (const routine of parseRoutines(masked)) {
    if (!TRANSACTIONAL_HANDLERS.has(routine.name.toLowerCase())) continue;

    const body = masked.slice(routine.bodyStart, routine.end);
    beginRe.lastIndex = 0;
    let hit;
    while ((hit = beginRe.exec(body)) !== null) {
      const pos = routine.bodyStart + hit.index;
      findings.push({
        severity: 'warn',
        rule: 'qg:BSL-TXN-IN-HANDLER',
        line: lineAt(source, pos),
        handler: routine.name,
        message:
          `«НачатьТранзакцию» внутри обработчика «${routine.name}»: платформа уже открыла транзакцию, ` +
          'вложенные не поддерживаются — «ОтменитьТранзакцию» здесь отменит внешнюю целиком (#std783 п.1.4)',
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Присваивание примитива ссылочному полю

/**
 * Ссылочные типы конфигурации и менеджеры, дающие `ПустаяСсылка()` для каждого.
 */
const REF_MANAGERS = {
  EnumRef: 'Перечисления',
  CatalogRef: 'Справочники',
  DocumentRef: 'Документы',
  ChartOfCharacteristicTypesRef: 'ПланыВидовХарактеристик',
  ChartOfAccountsRef: 'ПланыСчетов',
  ChartOfCalculationTypesRef: 'ПланыВидовРасчета',
  BusinessProcessRef: 'БизнесПроцессы',
  TaskRef: 'Задачи',
  ExchangePlanRef: 'ПланыОбмена',
};
const REF_TYPE_RE = new RegExp(`cfg:(${Object.keys(REF_MANAGERS).join('|')})\\.([\\w\\u0400-\\u04FF]+)`, 'u');

/**
 * Корневой элемент выгрузки объекта метаданных — `MetaDataObject`; у описания формы там
 * `Form`, у макета — своё.
 *
 * Проверка нужна, потому что подъём по каталогам натыкается не только на объект: у модуля
 * формы первым по пути лежит `Ext/Form.xml` — описание ФОРМЫ. Его `<Attribute>` устроены
 * иначе (имя в атрибуте `name=`, а не дочерним `<Name>`), поэтому разбор возвращал пустой
 * список полей, `metaResolved` становился истиной, и проверка ссылочных присваиваний
 * печатала «clean» на модуле, полей которого не видела. Ложная зелень ровно того вида,
 * против которого заведён след прогона.
 */
function isObjectXml(path) {
  try {
    // Корневой элемент лежит в первых сотнях байт: читать файл целиком незачем.
    return /<MetaDataObject[\s>]/.test(readFileSync(path, 'utf8').slice(0, 1024));
  } catch {
    return false;
  }
}

/**
 * XML объекта метаданных для модуля: ближайший предок каталога, рядом с которым лежит
 * одноимённый .xml. Для `Documents/Заказ/Ext/ObjectModule.bsl` это `Documents/Заказ.xml`;
 * для `Documents/Заказ/Forms/Форма/Ext/Form/Module.bsl` — тот же файл, а не `Ext/Form.xml`
 * по дороге.
 */
export function findObjectXml(bslPath) {
  let dir = dirname(bslPath);
  for (let depth = 0; depth < 6 && dir && dir !== dirname(dir); depth++) {
    const candidate = `${dir}.xml`;
    if (existsSync(candidate) && isObjectXml(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

/**
 * Поля СТРОГО ссылочного типа из XML объекта: имя → тип.
 *
 * Составные типы пропускаются намеренно: у поля «Строка или Ссылка» присваивание "" законно,
 * а ложная находка дороже пропущенной.
 */
export function refTypedFields(xml) {
  const out = new Map();
  const blockRe = /<(Attribute|Resource|Dimension|AddressingAttribute)[\s>][\s\S]*?<\/\1>/g;
  let b;
  while ((b = blockRe.exec(xml)) !== null) {
    const name = b[0].match(/<Name>([\wЀ-ӿ]+)<\/Name>/u);
    const typeBlock = b[0].match(/<Type>([\s\S]*?)<\/Type>/);
    if (!name || !typeBlock) continue;
    const types = [...typeBlock[1].matchAll(/<v8:Type>([^<]+)<\/v8:Type>/g)].map((m) => m[1].trim());
    if (types.length !== 1) continue;
    if (!REF_TYPE_RE.test(types[0])) continue;
    out.set(name[1], types[0]);
  }
  return out;
}

/**
 * Присваивания вида `<Приёмник>.<Поле> = ""` (и 0, Ложь, Истина) для ссылочных полей.
 *
 * Присваивание отличается от сравнения по позиции: оператор начинает строку. Сравнение
 * `Если Запись.Статус = "" Тогда` стоит после «Если» и находкой не является — оно всегда
 * ложно, но не роняет запись, и это другой класс.
 */
export function lintRefAssignments(source, fields) {
  if (!fields || fields.size === 0) return [];
  const masked = maskModule(source);
  const findings = [];

  for (const [name, type] of fields) {
    const re = new RegExp(`(?<![${W}.])(${IDENT})\\s*\\.\\s*${name}\\s*=(?!=)`, 'giu');
    let m;
    while ((m = re.exec(masked)) !== null) {
      const lineStart = masked.lastIndexOf('\n', m.index) + 1;
      if (masked.slice(lineStart, m.index).trim() !== '') continue;

      // Правая часть читается из ИСХОДНИКА: маска гасит содержимое литералов вместе с
      // кавычками, и `""` в ней уже не виден.
      const rhs = source.slice(m.index + m[0].length, m.index + m[0].length + 40).match(/^[ \t]*(""|0|Ложь|Истина)[ \t]*;/iu);
      if (!rhs) continue;

      const refMatch = type.match(REF_TYPE_RE);
      const empty = refMatch ? `${REF_MANAGERS[refMatch[1]]}.${refMatch[2]}.ПустаяСсылка()` : 'ПустаяСсылка()';
      findings.push({
        severity: 'warn',
        rule: 'qg:BSL-ENUM-STRING-ASSIGN',
        line: lineAt(source, m.index),
        field: name,
        type,
        message:
          `«${m[1]}.${name} = ${rhs[1]}»: поле «${name}» по XML объекта имеет строго ссылочный тип ` +
          `${type} — примитив вместо ссылки молчит на сборке и падает при записи. Пустое значение: ` +
          `${empty}. Приёмник не разрешается: если «${m[1]}» — не объект с этим реквизитом, находка ложная`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Строковая колонка без квалификатора длины у таблицы, уходящей в запрос

/**
 * Гасит комментарии, СОХРАНЯЯ содержимое литералов, — и снова без сдвига позиций.
 *
 * `maskModule` для этой проверки не годится: тип колонки записан строковым литералом
 * (`Новый ОписаниеТипов("Строка")`), а маска гасит именно литералы. Структурный разбор
 * (границы вызова, запятые верхнего уровня) при этом всё равно идёт по `maskModule`:
 * скобка или запятая внутри литерала — «Артикул (осн.)» — иначе рвала бы баланс.
 * Обе маски равной длины с исходником, поэтому позиции одной применимы к другой.
 */
export function maskComments(source) {
  const chars = source.split('');
  let i = 0;
  let inString = false;
  while (i < chars.length) {
    if (!inString && chars[i] === '/' && chars[i + 1] === '/') {
      while (i < chars.length && chars[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }
    if (chars[i] === '"') {
      if (inString && chars[i + 1] === '"') {
        i += 2;
        continue;
      }
      inString = !inString;
    }
    i++;
  }
  return chars.join('');
}

/** Границы аргументов вызова по балансу скобок; `open` — позиция открывающей. */
function callArgs(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') {
      depth--;
      if (depth === 0) return { start: open + 1, end: i };
    }
  }
  return null;
}

/** Аргументы, разделённые запятыми ВЕРХНЕГО уровня: вложенный вызов не считается границей. */
function splitArgs(masked, start, end) {
  const parts = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push({ start: from, end: i });
      from = i + 1;
    }
  }
  parts.push({ start: from, end });
  return parts;
}

const ROOT_IDENT_RE = new RegExp(`^\\s*(${IDENT})`, 'u');

/** Первый идентификатор выражения: для «Результат.Таблица.Скопировать()» это «Результат». */
function rootIdent(text) {
  const m = text.match(ROOT_IDENT_RE);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Таблицы, уходящие в запрос: вторые аргументы всех `УстановитьПараметр` модуля.
 *
 * Ключ — корневой идентификатор, а не полное выражение: `УстановитьПараметр("Т", Данные.Строки)`
 * и `Данные.Строки.Колонки.Добавить(…)` должны сойтись. Плата за это — более широкое
 * совпадение (другое поле того же «Данные» тоже сойдётся), и потому находка — предупреждение.
 */
export function queryParameterTables(masked) {
  const tables = new Set();
  const re = word('УстановитьПараметр');
  let m;
  while ((m = re.exec(masked)) !== null) {
    const open = masked.indexOf('(', m.index + m[0].length);
    if (open === -1 || masked.slice(m.index + m[0].length, open).trim() !== '') continue;
    const range = callArgs(masked, open);
    if (!range) continue;
    const parts = splitArgs(masked, range.start, range.end);
    if (parts.length < 2) continue;
    const root = rootIdent(masked.slice(parts[1].start, parts[1].end));
    if (root) tables.add(root);
  }
  return tables;
}

const COLUMNS_ADD_RE = new RegExp(
  `(?<![${W}.])(${IDENT}(?:\\s*\\.\\s*${IDENT})*)\\s*\\.\\s*Колонки\\s*\\.\\s*(?:Добавить|Вставить)\\s*\\(`,
  'giu'
);
const NEW_TYPE_DESC_RE = word('Новый\\s+ОписаниеТипов');
const STRING_QUALIFIER_RE = word('КвалификаторыСтроки');

/** Первый литерал диапазона — им задан либо список типов, либо имя колонки. */
function firstLiteral(withLiterals, start, end) {
  const m = withLiterals.slice(start, end).match(/"([^"]*)"/);
  return m ? m[1] : null;
}

/**
 * Строка без квалификатора длины в колонке таблицы, уходящей в запрос.
 *
 * Колонка, объявленная как `Новый ОписаниеТипов("Строка")`, имеет НЕОГРАНИЧЕННУЮ длину.
 * Помещённая во временную таблицу, она роняет запрос везде, где значения сравниваются
 * между собой: `РАЗЛИЧНЫЕ`, `ОБЪЕДИНИТЬ` без `ВСЕ`, `СГРУППИРОВАТЬ ПО`, условие соединения,
 * `ГДЕ`, `УПОРЯДОЧИТЬ ПО`, `ИНДЕКСИРОВАТЬ ПО` — «Нельзя сравнивать поля неограниченной
 * длины». Ни сборка, ни анализатор этого не видят: тип задан в рантайме, а текст запроса
 * остаётся литералом.
 *
 * Якорь: #std432 п. 3.1 (приведение к длине для сравнения, группировки и `РАЗЛИЧНЫЕ`) и
 * п. 2 (когда неограниченная строка законна).
 */
export function lintUnboundedColumns(source) {
  const masked = maskModule(source);
  const withLiterals = maskComments(source);
  const tables = queryParameterTables(masked);
  if (tables.size === 0) return [];

  const findings = [];
  COLUMNS_ADD_RE.lastIndex = 0;
  let m;
  while ((m = COLUMNS_ADD_RE.exec(masked)) !== null) {
    const receiver = m[1].replace(/\s+/g, '');
    if (!tables.has(rootIdent(m[1]))) continue;

    const range = callArgs(masked, m.index + m[0].length - 1);
    if (!range) continue;

    // Квалификатор ищется во ВСЕЙ скобке вызова: он лежит третьим аргументом
    // «ОписаниеТипов», а тот может быть завёрнут во что угодно.
    STRING_QUALIFIER_RE.lastIndex = 0;
    if (STRING_QUALIFIER_RE.test(masked.slice(range.start, range.end))) continue;

    NEW_TYPE_DESC_RE.lastIndex = range.start;
    const typeDesc = NEW_TYPE_DESC_RE.exec(masked);
    if (!typeDesc || typeDesc.index >= range.end) continue;

    const typeOpen = masked.indexOf('(', typeDesc.index + typeDesc[0].length);
    if (typeOpen === -1 || typeOpen >= range.end) continue;
    const typeRange = callArgs(masked, typeOpen);
    if (!typeRange) continue;

    // Список типов — первый аргумент «ОписаниеТипов». Строгое совпадение с «Строка»
    // отсекает «СтрокаТабличнойЧасти» и прочие имена, начинающиеся так же.
    const typeParts = splitArgs(masked, typeRange.start, typeRange.end);
    const declared = firstLiteral(withLiterals, typeParts[0].start, typeParts[0].end) || '';
    if (!declared.split(',').some((t) => t.trim().toLowerCase() === 'строка')) continue;

    const columnParts = splitArgs(masked, range.start, range.end);
    const column = firstLiteral(withLiterals, columnParts[0].start, columnParts[0].end);
    const where = column ? `«${column}»` : 'колонка';

    findings.push({
      severity: 'warn',
      rule: 'qg:BSL-UNBOUNDED-STRING-COLUMN',
      line: lineAt(source, m.index),
      table: receiver,
      column: column || null,
      message:
        `${where} у «${receiver}»: «Строка» без «КвалификаторыСтроки» — колонка неограниченной длины, ` +
        `а «${receiver}» в этом же модуле уходит в «УстановитьПараметр». В РАЗЛИЧНЫЕ, СГРУППИРОВАТЬ ПО, ` +
        'соединении и сравнении такое поле даёт ошибку выполнения «Нельзя сравнивать поля неограниченной ' +
        'длины» (#std432 п.3.1). Квалификатор: Новый ОписаниеТипов("Строка", , Новый КвалификаторыСтроки(N)). ' +
        'Если колонка несёт длинный текст, квалификатор её обрежет — тогда длину назначает запрос: ' +
        'ВЫРАЗИТЬ(… КАК СТРОКА(N)). Попадает ли колонка в сравнение, отсюда не видно: если поле только ' +
        'выводится, находка ложная',
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Разыменование ссылки через точку

/**
 * Поля, чтение которых обращения к базе не требует.
 *
 * `Ссылка.Ссылка` возвращает саму ссылку — объект не читается. `НомерСтроки` у ссылки не
 * существует вовсе: встретив его, мы почти наверняка смотрим на строку табличной части, а не
 * на ссылку, и молчание тут дешевле догадки.
 */
const FREE_FIELDS = new Set(['ссылка', 'номерстроки']);

/**
 * Сегменты, после которых имя на «Ссылка» означает не ссылку.
 *
 * `Отбор.Ссылка.Значение` — свойство элемента отбора: имя сегмента совпадает с именем
 * реквизита по построению, чтения из базы нет. Без этого исключения правило давало бы находку
 * на каждой установке отбора — самая частая законная форма из всех похожих.
 */
const NON_REF_CHAIN = new Set(['отбор', 'отборы', 'элементыотбора', 'параметрыотбора', 'структураотбора']);

/** Менеджеры: `Справочники.Товары.ПустаяСсылка()` ссылкой в этом смысле не является. */
const MANAGERS = new Set([
  'справочники', 'документы', 'перечисления', 'планывидовхарактеристик', 'планысчетов',
  'планывидоврасчета', 'регистрысведений', 'регистрынакопления', 'регистрыбухгалтерии',
  'регистрырасчета', 'бизнеспроцессы', 'задачи', 'планыобмена', 'метаданные', 'обработки',
  'отчеты', 'константы', 'последовательности', 'документыссылка', 'справочникиссылка',
]);

const CHAIN_RE = new RegExp(`(?<![${W}.])(${IDENT})((?:\\s*\\.\\s*${IDENT})+)`, 'giu');

/**
 * Типы из описания метода (#std453), означающие ссылку.
 *
 * Список закрытый: `ЛюбаяСсылка` включён, `СправочникОбъект` и коллекции — нет, и это не
 * симметрия. Объект уже прочитан целиком, обращение к его реквизиту законно; у структуры и
 * соответствия точка вообще не читает базу.
 */
const REF_TYPES = [
  'справочникссылка.', 'документссылка.', 'перечислениессылка.', 'планвидовхарактеристикссылка.',
  'плансчетовссылка.', 'планвидоврасчетассылка.', 'бизнеспроцессссылка.', 'задачассылка.',
  'планобменассылка.', 'любаяссылка',
];
/** Типы, при которых точка законна: они отменяют ссылочность даже в составном описании. */
const NON_REF_TYPES = ['объект.', 'структура', 'соответствие', 'таблицазначений', 'списокзначений'];

/**
 * Менеджеры, у которых поиск возвращает ССЫЛКУ. Перечислений здесь нет: у них поиска нет.
 */
const REF_MANAGER_ROOTS = 'Справочники|Документы|ПланыВидовХарактеристик|ПланыСчетов|'
  + 'ПланыВидовРасчета|БизнесПроцессы|Задачи|ПланыОбмена';

/**
 * Присваивания, доказывающие ссылочность.
 *
 * Поиск обязан быть **у менеджера объекта**, и это не педантизм, а результат замера на живом
 * коде: `НайтиПо…` без этого условия ловил `СписокЗначений.НайтиПоЗначению` (возвращает
 * элемент списка), `ТабличнаяЧасть.НайтиПоИдентификатору` (строку) и
 * `Метаданные.НайтиПоПолномуИмени` (объект метаданных). На расширениях одного проекта это
 * дало под сотню ложных находок — больше, чем настоящих: у элемента списка есть и `.Значение`,
 * и `.Представление`, то есть форма обращения выглядит точно как разыменование.
 *
 * Выражение обязано составлять ПРАВУЮ ЧАСТЬ ЦЕЛИКОМ, а не встречаться в ней. Второй замер на
 * том же коде: `Настройки = ОбщийМодуль.Получить(…, Справочники.Склады.ПустаяСсылка(), Дата)`
 * помечал переменную ссылкой, потому что образец нашёлся в АРГУМЕНТЕ чужого вызова. Что
 * вернёт обёртка — неизвестно, и любая обёртка снимает доказательство.
 */
const REF_SOURCES = [
  new RegExp(`^${IDENT}(?:\\s*\\.\\s*${IDENT})*\\s*\\.\\s*Ссылка$`, 'iu'),
  new RegExp(`^(?:${REF_MANAGER_ROOTS})\\s*\\.\\s*${IDENT}\\s*\\.\\s*НайтиПо${IDENT}\\s*\\(.*\\)$`, 'iu'),
  new RegExp(`^(?:${REF_MANAGER_ROOTS})\\s*\\.\\s*${IDENT}\\s*\\.\\s*(?:ПустаяСсылка|ПолучитьСсылку)\\s*\\(.*\\)$`, 'iu'),
];

/**
 * Ссылочные параметры метода — из описания над объявлением (#std453).
 *
 * Тип параметра в шапке — единственная семантика, которая доступна инструменту без вывода
 * типов и без графа вызовов: её написал автор метода, и стандарт требует её писать. Ссылку,
 * пришедшую параметром, иначе не опознать никак — а именно так она чаще всего и приходит.
 *
 * Комментарий может устареть, поэтому находка по нему — предупреждение, а не ошибка.
 */
export function refParamsFromHeader(source, routineStart) {
  const before = source.slice(0, routineStart);
  const lines = before.split('\n');
  const block = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '') {
      if (block.length) break;
      continue;
    }
    if (!line.startsWith('//')) break;
    block.unshift(line);
  }

  const refs = new Set();
  for (const line of block) {
    // Строка описания параметра: «// Имя - Тип - пояснение». Поля структуры («// * Ключ - …»)
    // под шаблон не подходят намеренно: они описывают не параметр, а его содержимое.
    const m = line.match(new RegExp(`^//\\s*(${IDENT})\\s*[-–—]\\s*(.+)$`, 'u'));
    if (!m) continue;
    const declared = m[2].split(/\s[-–—]\s/)[0].toLowerCase();
    if (NON_REF_TYPES.some((t) => declared.includes(t))) continue;
    if (REF_TYPES.some((t) => declared.includes(t))) refs.add(m[1].toLowerCase());
  }
  return refs;
}

/**
 * История ссылочности переменных в пределах метода: имя → события «с этой позиции».
 *
 * Не «последнее состояние», а именно история. Типовая последовательность — получить ссылку,
 * прочитать по ней реквизиты, затем получить объект:
 *
 *     Заказ = Выборка.Ссылка;        // ссылка
 *     Клиент = Заказ.Контрагент;     // ← находка здесь
 *     Заказ = Заказ.ПолучитьОбъект();// дальше объект, точка законна
 *
 * Хранили бы только итог — потеряли бы находку в середине, потому что к концу метода
 * переменная ссылкой уже не является. Событие с `ground: null` — снятие доказательства.
 *
 * Позиция важна и в другую сторону: до присваивания переменная ссылкой не является, и
 * находка выше по тексту утверждала бы то, чего в тот момент ещё нет.
 */
export function refVarsInRoutine(masked, routine, headerRefs) {
  const history = new Map();
  const add = (name, event) => {
    if (!history.has(name)) history.set(name, []);
    history.get(name).push(event);
  };
  for (const name of headerRefs) add(name, { from: routine.bodyStart, ground: 'header' });

  const assign = new RegExp(`(?<![${W}.])(${IDENT})\\s*=(?!=)([^;\\n]*)`, 'giu');
  assign.lastIndex = routine.bodyStart;
  let m;
  while ((m = assign.exec(masked)) !== null) {
    if (m.index >= routine.end) break;
    // Оператор начинает строку — иначе это сравнение внутри условия, а не присваивание.
    const lineStart = masked.lastIndexOf('\n', m.index) + 1;
    if (masked.slice(lineStart, m.index).trim() !== '') continue;

    const rhs = m[2].trim();
    const proven = REF_SOURCES.some((re) => re.test(rhs));
    // Событие ставится в конец присваивания: в правой части переменная ещё в прежнем
    // состоянии, и `Заказ = Заказ.ПолучитьОбъект()` не должен снимать доказательство с
    // самого себя раньше, чем это выражение прочитано.
    add(m[1].toLowerCase(), { from: m.index + m[0].length, ground: proven ? 'assignment' : null });
  }
  return history;
}

/**
 * Обращение к реквизиту ссылочного значения через точку.
 *
 * Точка у ссылки читает объект ЦЕЛИКОМ — все реквизиты и все табличные части — ради одного
 * поля. Замена: `ОбщегоНазначения.ЗначениеРеквизитаОбъекта`, для нескольких полей
 * `ЗначенияРеквизитовОбъекта` одним вызовом. Якорь — #std437, антипаттерн «Чтение реквизита
 * через точку» (🔴), разбор в `references/catalog/BSL-REF-DOT-ACCESS.md` и
 * `references/catalog/AI-02.md`.
 *
 * Почему инструментом. Статический анализатор эту форму не видит в принципе: чтобы понять,
 * что база цепочки — ссылка, нужен вывод типов через границы методов и модулей, а
 * синтаксически `Структура.Ключ.Поле` неотличимо от обращения к вложенной структуре. До
 * этого правила проверка закрывалась только чтением глазами, и её «чисто» ничем не
 * фальсифицировалось: в живой сессии четыре разыменования пережили два прогона гейта с
 * рукописной строкой следа.
 *
 * Три основания, и каждое печатается в тексте находки — они разной силы:
 *
 *   1. ПРИСВАИВАНИЕ в этом же методе: `Заказ = Выборка.Ссылка`, `= …НайтиПоКоду(…)`,
 *      `= …ПустаяСсылка()`, `= …ПолучитьСсылку(…)`. Доказательство из кода, 🔴.
 *   2. ОПИСАНИЕ МЕТОДА (#std453): параметр объявлен как `СправочникСсылка.X` и подобные. Тип
 *      написал автор метода, и это единственная семантика, доступная инструменту без вывода
 *      типов. 🟠 — комментарий может пережить смену типа параметра, код не может.
 *   3. ИМЯ базы оканчивается на «Ссылка» — конвенция, которой автор следовал сам, 🔴.
 *
 * Чего инструмент НЕ делает и делать не будет: не сопоставляет имена переменных с именами
 * объектов конфигурации. Переменную называют как угодно, и такое сопоставление давало бы
 * находки на совпадении слов, а не на типе значения.
 *
 * Покрытие частичное: инструмент задаёт нижнюю границу проверки #std437, а не верхнюю.
 * Ссылка, пришедшая параметром недокументированного метода или из чужой функции, остаётся
 * неопознанной — и это заявлено в навыке.
 */
export function lintRefDotAccess(source) {
  const masked = maskModule(source);
  const findings = [];

  // Доказательства считаются по методам: одно и то же имя в соседних процедурах — разные
  // переменные, и знание о нём за границу метода не переносится.
  const routines = parseRoutines(masked).map((routine) => ({
    ...routine,
    refs: refVarsInRoutine(masked, routine, refParamsFromHeader(source, routine.start)),
  }));
  const proofAt = (name, pos) => {
    const routine = routines.find((r) => pos >= r.bodyStart && pos < r.end);
    const events = routine?.refs.get(name);
    if (!events) return null;
    // Действует последнее событие ДО этой позиции: доказательство живёт от присваивания до
    // следующего, а не до конца метода.
    let ground = null;
    for (const event of events) {
      if (event.from > pos) break;
      ground = event.ground;
    }
    return ground;
  };

  CHAIN_RE.lastIndex = 0;
  let m;
  while ((m = CHAIN_RE.exec(masked)) !== null) {
    const raw = m[0];
    const segments = raw.split('.').map((s) => s.trim());
    const lower = segments.map((s) => s.toLowerCase());
    if (MANAGERS.has(lower[0])) continue;

    for (let i = 1; i < segments.length; i++) {
      const baseSegment = segments[i - 1];
      const field = segments[i];
      // Доказательство относится к переменной, а не к цепочке: `Параметры.Заказ` — это поле
      // структуры, о типе которого в файле не сказано ничего.
      const proven = i === 1 ? proofAt(lower[0], m.index) : null;
      if (!lower[i - 1].endsWith('ссылка') && !proven) continue;
      // `continue`, а не `break`: свободное поле — пропуск ОДНОГО звена, а не конца цепочки.
      // В `ЗаказСсылка.Ссылка.Дата` первое звено чтения не делает, второе делает, и обрыв
      // разбора здесь прятал бы настоящее разыменование за безобидным префиксом.
      if (FREE_FIELDS.has(lower[i])) continue;
      // А вот отбор обрывает цепочку целиком: ссылкой не является ни одно её звено.
      if (lower.slice(0, i).some((s) => NON_REF_CHAIN.has(s))) break;

      // Вызов метода объектом не читает: `Ссылка.ПолучитьОбъект()`, `Ссылка.Пустая()`.
      // Проверяется только последний сегмент — у промежуточного за именем всегда точка.
      if (i === segments.length - 1) {
        const after = masked.slice(m.index + raw.length).match(/^\s*\(/);
        if (after) break;
      }

      const base = segments.slice(0, i).join('.');
      // Основание печатается в находке: доказательство из кода и совпадение по имени — разной
      // силы аргументы, и читатель вправе взвешивать их по-разному.
      const ground = proven === 'assignment'
        ? `в этом методе «${baseSegment}» присвоена ссылка (.Ссылка, НайтиПо…, ПустаяСсылка)`
        : proven === 'header'
          ? `в описании метода (#std453) параметр «${baseSegment}» объявлен ссылочным — если описание устарело, находка ложная`
          : `имя «${baseSegment}» оканчивается на «Ссылка»: если это структура, элемент отбора или уже полученный объект, находка ложная`;
      findings.push({
        // Доказанное присваиванием и конвенция имени — 🔴, как антипаттерн в своде. Описание
        // метода — 🟠: комментарий может пережить смену типа параметра, код не может.
        severity: proven === 'header' ? 'warn' : 'error',
        rule: 'qg:BSL-REF-DOT-ACCESS',
        line: lineAt(source, m.index),
        base,
        field,
        ground: proven || 'name',
        message:
          `«${base}.${field}»: обращение через точку у ссылочного значения — платформа прочитает объект ` +
          'целиком, все реквизиты и табличные части, ради одного поля (#std437, антипаттерн «Чтение ' +
          `реквизита через точку»). Замена: ОбщегоНазначения.ЗначениеРеквизитаОбъекта(${base}, "${field}"), ` +
          `для нескольких полей — ЗначенияРеквизитовОбъекта одним вызовом. Основание — ${ground}`,
      });
      break;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Локальная переменная под именем реквизита формы

/**
 * Описание формы рядом с модулем: `<...>/Ext/Form/Module.bsl` → `<...>/Ext/Form.xml`.
 *
 * Ищется точным путём, а не подъёмом вверх: подъём находит и XML объекта, у которого
 * реквизиты совсем другие, и правило начало бы сверять имена не с тем списком.
 */
export function findFormXml(bslPath) {
  if (basename(bslPath) !== 'Module.bsl') return null;
  const formDir = dirname(bslPath);
  if (basename(formDir) !== 'Form') return null;
  const extDir = dirname(formDir);
  if (basename(extDir) !== 'Ext') return null;
  const candidate = join(extDir, 'Form.xml');
  return existsSync(candidate) ? candidate : null;
}

/** Примитивные типы реквизита формы: только на них приведение молча портит значение. */
const PRIMITIVE_FORM_TYPES = new Set(['xs:string', 'xs:decimal', 'xs:dateTime', 'xs:boolean']);

/**
 * Реквизиты формы примитивных типов — имена ВЕРХНЕГО уровня.
 *
 * Вложенность считается намеренно: колонки реквизита-таблицы лежат такими же тегами
 * `<Attribute>` внутри `<Columns>`, и без счётчика их имена попали бы в список. Колонка
 * реквизитом формы не является, локальная переменная с её именем безопасна, и находка на
 * ней была бы ложной.
 *
 * Составные типы отбрасываются: у реквизита «Строка или ТаблицаЗначений» объектное
 * присваивание законно.
 */
export function primitiveFormAttributes(xml) {
  const attrsSection = xml.match(/<Attributes>([\s\S]*)<\/Attributes>/);
  if (!attrsSection) return new Set();

  const out = new Set();
  const tagRe = /<(\/?)Attribute\b([^>]*?)(\/?)>/g;
  let depth = 0;
  let top = null;
  let m;
  while ((m = tagRe.exec(attrsSection[1])) !== null) {
    const closing = m[1] === '/';
    const selfClosing = m[3] === '/';
    if (closing) {
      depth--;
      if (depth === 0 && top) {
        const body = attrsSection[1].slice(top.bodyStart, m.index);
        const typeBlock = body.match(/<Type>([\s\S]*?)<\/Type>/);
        if (typeBlock) {
          const types = [...typeBlock[1].matchAll(/<v8:Type>([^<]+)<\/v8:Type>/g)].map((x) => x[1].trim());
          if (types.length > 0 && types.every((x) => PRIMITIVE_FORM_TYPES.has(x))) out.add(top.name);
        }
        top = null;
      }
      continue;
    }
    if (selfClosing) continue;
    if (depth === 0) {
      const name = m[2].match(/name="([^"]+)"/);
      top = name ? { name: name[1], bodyStart: m.index + m[0].length } : null;
    }
    depth++;
  }
  return out;
}

/** Директива компиляции перед объявлением метода — последняя строка на «&» выше него. */
function directiveBefore(source, routineStart) {
  const before = source.slice(0, routineStart).split('\n').reverse();
  for (const raw of before) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('&')) return line.toLowerCase();
    if (line.startsWith('//')) continue;
    return '';
  }
  return '';
}

/** Имена параметров метода: они объявлены и потому реквизит перекрывают законно. */
function routineParams(masked, bodyStart) {
  let depth = 1;
  let i = bodyStart;
  for (; i < masked.length && depth > 0; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') depth--;
  }
  const header = masked.slice(bodyStart, i - 1);
  return new Set(
    header
      .split(',')
      .map((p) => p.replace(/=.*$/s, '').replace(/\bЗнач\b/gi, '').trim())
      .filter(Boolean)
  );
}

/**
 * Локальная переменная под именем реквизита формы.
 *
 * В модуле формы имя реквизита — свойство самой формы. Присваивание `Журнал = Новый Структура`
 * НЕ создаёт локальную переменную: значение уходит в реквизит и приводится к его типу, а
 * следующее обращение через точку падает — «Значение не является значением объектного типа».
 * Локальное имя создают только объявление `Перем`, параметр метода и переменная цикла.
 *
 * Дефект проявляется выборочно и потому читается как случайный: в `&НаСервереБезКонтекста`
 * контекста формы нет, и там ровно тот же код работает.
 *
 * Сигнал: в методе С контекстом формы имя реквизита ПРИМИТИВНОГО типа получает объектное
 * значение (`Новый …` либо результат вызова), и ниже по тексту к тому же имени обращаются
 * через точку. Порог — одно такое сочетание.
 *
 * Контр-сигналы (все проверяются):
 *   - метод объявлен `…БезКонтекста` — имя честно локальное;
 *   - имя объявлено параметром или `Перем` — то же самое;
 *   - реквизит непримитивного типа (таблица, составной) — обращение через точку к нему
 *     законно, и переприсвоение тоже встречается;
 *   - присваивание примитива (`Журнал = ""`, конкатенация) — это намеренная запись в реквизит,
 *     а не путаница;
 *   - обращение вида `ЭтотОбъект.Журнал` — явное указание на реквизит, никогда не ошибка;
 *   - обращение через точку ВЫШЕ присваивания — чтение реквизита, а не работа с объектом.
 *
 * Ни анализатор, ни валидатор формы, ни сборка `.epf` этого не видят: XML валиден, синтаксис
 * верен, типы согласованы. Стандарта на такую коллизию нет — падение только в рантайме.
 */
export function lintFormAttrShadow(source, attributes) {
  if (attributes.size === 0) return [];

  const masked = maskModule(source);
  const findings = [];

  for (const routine of parseRoutines(masked)) {
    const directive = directiveBefore(source, routine.start);
    if (directive.includes('безконтекста')) continue;

    const body = masked.slice(routine.bodyStart, routine.end);
    const params = routineParams(masked, routine.bodyStart);
    const declared = new Set(
      [...body.matchAll(new RegExp(`(?<![${W}])Перем\\s+([^;]+);`, 'giu'))]
        .flatMap((d) => d[1].split(',').map((n) => n.trim()))
    );

    for (const attr of attributes) {
      if (params.has(attr) || declared.has(attr)) continue;

      // Объектное присваивание: `Новый …` либо вызов. Литерал и конкатенация — законная
      // запись в реквизит, они сюда не попадают.
      const assignRe = new RegExp(
        `(?<![${W}.])${attr}\\s*=\\s*(?:Новый(?![${W}])|${IDENT}\\s*\\(|${IDENT}\\s*\\.\\s*${IDENT}\\s*\\()`,
        'giu'
      );
      const assign = assignRe.exec(body);
      if (!assign) continue;

      // Обращение через точку ниже присваивания. `ЭтотОбъект.<Имя>` исключается: это явное
      // указание на реквизит.
      const dotRe = new RegExp(`(?<![${W}.])${attr}\\s*\\.\\s*(${IDENT})`, 'giu');
      dotRe.lastIndex = assign.index;
      const use = dotRe.exec(body);
      if (!use) continue;

      const pos = routine.bodyStart + use.index;
      findings.push({
        severity: 'error',
        rule: 'qg:BSL-FORM-ATTR-SHADOW',
        line: lineAt(source, pos),
        routine: routine.name,
        attribute: attr,
        message:
          `«${attr}» — реквизит формы примитивного типа, а не локальная переменная: в методе ` +
          `«${routine.name}» (директива с контекстом формы) присваивание уходит В РЕКВИЗИТ и ` +
          `приводится к его типу, поэтому «${attr}.${use[1]}» упадёт с «Значение не является ` +
          'значением объектного типа». Локальное имя создают только «Перем», параметр и переменная ' +
          'цикла. Лечится переименованием реквизита (например, «Результат» → «Журнал»), а не ' +
          'переименованием переменных: в «&НаСервереБезКонтекста» тот же код работает, и дефект ' +
          'выглядит случайным',
      });
    }
  }
  return findings;
}

/**
 * Разбор значения по веткам: `Если … ИначеЕсли …` без завершающего `Иначе`.
 *
 * Цепочка, которая перебирает значения перечисления или типы документа, — это диспетчер:
 * автор перечислил известные ему случаи. Значение, не попавшее ни в одну ветку (новое значение
 * перечисления, незаполненная ссылка, запись, поставленная вручную), проходит такую цепочку
 * молча, и метод продолжает работу так, будто разбор состоялся. В коде, который дальше
 * совершает необратимое действие — пробивает фискальный документ, проводит, отправляет
 * запрос во внешнюю систему, — это тихий пропуск проверки, а не отказ.
 *
 * Сигнал: одно и то же выражение сравнивается со значениями перечисления
 * (`Перечисления.<Тип>.<Значение>`) либо с типом (`ТипЗнч(<выражение>) = Тип("…")`) в трёх и
 * более ветках одной цепочки, а ветки `Иначе` у цепочки нет.
 *
 * Порог — три ветки: две ветки без `Иначе` это обычная двоичная развилка («если аванс — так,
 * если нет — иначе»), и требовать у неё закрытия значило бы ругаться на нормальный код.
 *
 * Контр-сигналы, на которых инструмент молчит:
 *   - у цепочки есть `Иначе` — неважно, что в нём;
 *   - охранная форма: КАЖДАЯ ветка заканчивается `Возврат`, а после `КонецЕсли` в том же методе
 *     стоит `Возврат` или `ВызватьИсключение` — значение по умолчанию там и живёт;
 *   - веток меньше трёх либо в них сравниваются разные выражения: это не перебор одного
 *     признака, а последовательность независимых условий.
 *
 * Приближения:
 *   - сравнение узнаётся только в прямом порядке (`Признак = Перечисления.…`); обратный
 *     (`Перечисления.… = Признак`) не разбирается — в прикладном коде он не встречается;
 *   - перебор строковых кодов и чисел не покрыт: у них нет признака, отличающего диспетчер от
 *     обычного условия, и правило дало бы находку на каждом сравнении с литералом;
 *   - что делает ветка, инструмент не смотрит: цепочка, после которой метод сразу возвращает
 *     готовое значение, и цепочка перед записью в базу для него одинаковы.
 */
export function lintDispatchFallback(source) {
  const masked = maskModule(source);
  const findings = [];
  const routines = parseRoutines(masked);

  const enumSubject = new RegExp(
    `(${IDENT}(?:\\s*\\.\\s*${IDENT})*)\\s*=\\s*Перечисления\\s*\\.\\s*(${IDENT})\\s*\\.\\s*${IDENT}`,
    'giu'
  );
  const typeSubject = new RegExp(`ТипЗнч\\s*\\(\\s*(${IDENT}(?:\\s*\\.\\s*${IDENT})*)\\s*\\)\\s*=\\s*Тип\\s*\\(`, 'giu');
  const hasReturn = word('Возврат', 'iu');
  const hasRaise = word('ВызватьИсключение', 'iu');

  for (const chain of parseIfChains(masked)) {
    if (chain.hasElse || chain.branches.length < 3) continue;

    // Ключ — текст выражения без пробелов: `Запись.ТипЧека` и `Запись . ТипЧека` это одно
    // и то же выражение, а `Запись.ТипЧека` и `Основание` — разные.
    const perSubject = new Map();
    for (const branch of chain.branches) {
      if (branch.condEnd === -1) continue;
      const condition = masked.slice(branch.condStart, branch.condEnd);
      const seen = new Map();
      for (const re of [enumSubject, typeSubject]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(condition)) !== null) {
          const text = m[1].replace(/\s+/g, '');
          const key = (re === typeSubject ? 'типзнч:' : '') + text.toLowerCase();
          if (!seen.has(key)) seen.set(key, { text, kind: re === typeSubject ? 'тип' : m[2] });
        }
      }
      for (const [key, info] of seen) {
        if (!perSubject.has(key)) perSubject.set(key, { text: info.text, kinds: new Set(), branches: 0 });
        const entry = perSubject.get(key);
        entry.kinds.add(info.kind);
        entry.branches++;
      }
    }

    let subject = null;
    for (const entry of perSubject.values()) if (!subject || entry.branches > subject.branches) subject = entry;
    if (!subject || subject.branches < 3) continue;

    // Охранная форма: разбор возвращает значение из каждой ветки, а умолчание стоит после
    // цепочки. Формально `Иначе` нет, по существу оно есть — и находка была бы ложной.
    const routine = routines.find((r) => chain.start >= r.bodyStart && chain.start < r.end);
    const everyBranchReturns = chain.branches.every(
      (b) => b.bodyStart !== -1 && hasReturn.test(masked.slice(b.bodyStart, b.bodyEnd))
    );
    const tail = routine ? masked.slice(chain.end, routine.end) : '';
    if (everyBranchReturns && (hasReturn.test(tail) || hasRaise.test(tail))) continue;

    const kinds = [...subject.kinds].filter((k) => k !== 'тип');
    findings.push({
      severity: 'warn',
      rule: 'qg:BSL-DISPATCH-NO-FALLBACK',
      line: lineAt(source, chain.start),
      message:
        `разбор «${subject.text}» по ${subject.branches} веткам` +
        (kinds.length ? ` (${kinds.map((k) => `Перечисления.${k}`).join(', ')})` : '') +
        ' закрыт без «Иначе»: значение, не попавшее ни в одну ветку — новое значение ' +
        'перечисления, незаполненная ссылка, запись, поставленная вручную, — проходит цепочку ' +
        'молча, и метод работает дальше так, будто разбор состоялся. Добавь «Иначе», который ' +
        'фиксирует причину и отказывает в действии; если умолчание допустимо, оно тоже пишется ' +
        'в «Иначе» явно',
    });
  }

  return findings;
}

/**
 * Цепочки `Если … КонецЕсли` с границами условий и тел веток.
 *
 * Вложенность держится стеком: `Если` внутри ветки — своя цепочка со своим `Иначе`, и путать
 * их нельзя. Порядок ключевых слов в шаблоне значим: `ИначеЕсли` проверяется раньше `Иначе`
 * и `Если`, иначе он разобрался бы на два разных слова.
 */
export function parseIfChains(masked) {
  const chains = [];
  const stack = [];
  const keywords = new RegExp(`(?<![${W}])(ИначеЕсли|КонецЕсли|Если|Иначе|Тогда)(?![${W}])`, 'giu');

  let m;
  while ((m = keywords.exec(masked)) !== null) {
    const keyword = m[1].toLowerCase();
    const after = m.index + m[0].length;

    if (keyword === 'если') {
      stack.push({
        start: m.index,
        end: masked.length,
        hasElse: false,
        branches: [{ condStart: after, condEnd: -1, bodyStart: -1, bodyEnd: -1 }],
      });
      continue;
    }

    const chain = stack[stack.length - 1];
    if (!chain) continue; // «КонецЕсли» без пары: разбирать нечего, файл всё равно не соберётся
    const current = chain.branches[chain.branches.length - 1];

    if (keyword === 'тогда') {
      if (current.condEnd === -1) {
        current.condEnd = m.index;
        current.bodyStart = after;
      }
      continue;
    }
    if (keyword === 'иначеесли') {
      if (current.bodyEnd === -1) current.bodyEnd = m.index;
      chain.branches.push({ condStart: after, condEnd: -1, bodyStart: -1, bodyEnd: -1 });
      continue;
    }
    if (keyword === 'иначе') {
      if (current.bodyEnd === -1) current.bodyEnd = m.index;
      chain.hasElse = true;
      continue;
    }
    if (keyword === 'конецесли') {
      if (current.bodyEnd === -1) current.bodyEnd = m.index;
      chain.end = after;
      chains.push(chain);
      stack.pop();
    }
  }

  return chains;
}

/**
 * Чтение базы данных, достижимое из тела цикла через вызов метода.
 *
 * Штатная диагностика `bslls:CreateQueryInCycle` ловит `Новый Запрос` прямо внутри `Для Каждого`
 * в одном методе. Как только цикл и чтение разъезжаются по методам — а это обычный вид
 * декомпозированного кода, — она молчит: цикл перебирает записи, вызывает обработчик, тот
 * вызывает проверку, и уже проверка читает базу помощником библиотеки. Число обращений то же
 * самое, вид другой. Правило закрывает именно этот разрыв и потому срабатывает ТОЛЬКО когда
 * чтение найдено в вызванном методе, а не в теле самого цикла: прямую форму уже покрывает
 * анализатор, и две находки на одну строку читались бы как дубль.
 *
 * Сигнал: из тела цикла достижим (через вызовы, глубина до 4) метод, в теле которого есть
 * обращение к базе — `Новый Запрос`, чтение реквизитов помощником библиотеки, поиск по коду
 * или наименованию, `ПолучитьОбъект`, чтение константы, среза регистра или менеджера записи.
 *
 * Контр-сигналы, на которых инструмент молчит:
 *   - цикл идёт по коллекции, собранной здесь же (`Новый Массив` плюс `Добавить`): это уже
 *     свёрнутый набор различных ключей, и обращений в нём столько, сколько различных значений,
 *     а не столько, сколько строк;
 *   - вызванный метод живёт в модуле с повторным использованием возвращаемых значений
 *     (`…ПовтИсп`): повторный вызов в цикле дёшев. Первый при этом платный, а результат живёт
 *     до конца сеанса — если значение должно быть строго на момент выполнения, кэш не подходит
 *     (#std724, тот же разбор в `references/catalog/AI-09.md`);
 *   - чтение лежит в теле самого цикла: это случай `bslls:CreateQueryInCycle`.
 *
 * Приближения:
 *   - граф вызовов строится ТОЛЬКО по файлам одного прогона. Метод из модуля, который в прогон
 *     не попал, инструменту не виден, и молчание правила о нём ничего не доказывает;
 *   - вызовы по вычисляемому имени (`Выполнить`, `ОбщийМодуль(Имя)`) не видны;
 *   - сколько раз выполнится цикл, инструмент не знает: перебор трёх строк и перебор
 *     документа на тысячу строк для него одинаковы. Отсюда важность 🟠, а не 🔴.
 */
const DB_READ_MARKERS = [
  { re: word('Новый\\s+Запрос', 'iu'), what: 'Новый Запрос' },
  {
    re: new RegExp(`ОбщегоНазначения\\s*\\.\\s*Значени[ея]Реквизит[аов]+Объект[аов]+\\s*\\(`, 'iu'),
    what: 'чтение реквизитов помощником библиотеки',
  },
  { re: /\.\s*НайтиПо(Коду|Наименованию|Реквизиту)\s*\(/iu, what: 'поиск элемента справочника' },
  { re: new RegExp(`Константы\\s*\\.\\s*${IDENT}\\s*\\.\\s*Получить\\s*\\(`, 'iu'), what: 'чтение константы' },
  {
    re: new RegExp(`РегистрыСведений\\s*\\.\\s*${IDENT}\\s*\\.\\s*(Получить|СрезПоследних|СрезПервых)\\s*\\(`, 'iu'),
    what: 'чтение регистра сведений',
  },
];

/**
 * Чего в списке нет намеренно: `ПолучитьОбъект` и `Прочитать()`. Обработка, которая меняет
 * каждый элемент набора, обязана прочитать каждый объект — это не повторное чтение одних и
 * тех же данных, а работа над разными. На корпусе в 114 модулей эти два маркера дали больше
 * половины находок, и все они были формой «прочитать документ, чтобы его записать».
 */

const MAX_CALL_DEPTH = 4;

/** Циклы модуля с границами тела: `Для`, `Для Каждого` и `Пока` закрываются одним `КонецЦикла`. */
function parseLoops(masked) {
  const loops = [];
  const stack = [];
  const keywords = new RegExp(`(?<![${W}])(КонецЦикла|Цикл)(?![${W}])`, 'giu');

  let m;
  while ((m = keywords.exec(masked)) !== null) {
    if (m[1].toLowerCase() === 'цикл') {
      stack.push({ headerEnd: m.index, bodyStart: m.index + m[0].length });
      continue;
    }
    const loop = stack.pop();
    if (loop) {
      loop.end = m.index;
      loops.push(loop);
    }
  }
  return loops;
}

/** Выражение, по которому идёт перебор: `Для Каждого <имя> Из <выражение> Цикл`. */
function loopCollection(masked, loop) {
  const header = masked.slice(Math.max(0, loop.headerEnd - 400), loop.headerEnd);
  const m = new RegExp(`(?<![${W}])Для\\s+Каждого\\s+${IDENT}\\s+Из\\s+([^\\n]+?)\\s*$`, 'iu').exec(header);
  return m ? m[1].trim() : null;
}

/**
 * Коллекция собрана в этом же методе: объявлена `Новый Массив` (или другой контейнер) и
 * наполнена `Добавить`/`Вставить`. Перебор такого набора — это перебор различных ключей,
 * ради которого его и собирали.
 */
function assembledLocally(masked, routine, expression) {
  if (!expression || !new RegExp(`^${IDENT}$`, 'u').test(expression)) return false;
  const body = masked.slice(routine.bodyStart, routine.end);
  const declared = new RegExp(
    `(?<![${W}])${expression}\\s*=\\s*Новый\\s+(Массив|Соответствие|СписокЗначений|ТаблицаЗначений|Структура)`,
    'iu'
  );
  const filled = new RegExp(`(?<![${W}])${expression}\\s*\\.\\s*(Добавить|Вставить)\\s*\\(`, 'iu');
  return declared.test(body) && filled.test(body);
}

function routineKey(moduleKey, name) {
  return `${moduleKey} ${name.toLowerCase()}`;
}

/** Имя общего модуля из пути выгрузки; для прочих модулей — сам путь, чтобы имена не смешались. */
function moduleKeyOf(path) {
  const parts = path.replace(/\\/g, '/').split('/');
  const index = parts.lastIndexOf('CommonModules');
  if (index >= 0 && parts[index + 1]) return parts[index + 1].toLowerCase();
  return path.toLowerCase();
}

export function lintDbReadsInLoops(units) {
  const index = new Map();
  for (const unit of units) {
    for (const routine of parseRoutines(unit.masked)) {
      index.set(routineKey(unit.moduleKey, routine.name), { ...routine, unit });
    }
  }

  const callRe = new RegExp(`(?<![${W}.])(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})\\s*\\(`, 'giu');
  const calleesOf = (text, ownModuleKey) => {
    const found = [];
    callRe.lastIndex = 0;
    let m;
    while ((m = callRe.exec(text)) !== null) {
      const moduleName = m[1];
      // Модуль с повторным использованием возвращаемых значений: повторный вызов в цикле дёшев.
      if (moduleName && /повтисп/iu.test(moduleName)) continue;
      const key = routineKey(moduleName ? moduleName.toLowerCase() : ownModuleKey, m[2]);
      const routine = index.get(key);
      if (routine) found.push({ name: m[2], routine });
    }
    return found;
  };

  const readIn = (text) => {
    for (const marker of DB_READ_MARKERS) {
      marker.re.lastIndex = 0;
      if (marker.re.test(text)) return marker.what;
    }
    return null;
  };

  const findings = [];
  for (const unit of units) {
    const routines = parseRoutines(unit.masked);
    for (const loop of parseLoops(unit.masked)) {
      const routine = routines.find((r) => loop.headerEnd >= r.bodyStart && loop.headerEnd < r.end);
      if (!routine) continue;
      if (assembledLocally(unit.masked, routine, loopCollection(unit.masked, loop))) continue;

      // Обход в ширину от тела цикла. Глубина 0 — сам цикл: чтение в нём покрывает анализатор,
      // поэтому в находку идут только вызванные методы.
      const visited = new Set([routineKey(unit.moduleKey, routine.name)]);
      let frontier = calleesOf(unit.masked.slice(loop.bodyStart, loop.end), unit.moduleKey).map((c) => ({
        ...c,
        chain: [c.name],
      }));
      let hit = null;
      for (let depth = 0; depth < MAX_CALL_DEPTH && frontier.length && !hit; depth++) {
        const next = [];
        for (const step of frontier) {
          const key = routineKey(step.routine.unit.moduleKey, step.routine.name);
          if (visited.has(key)) continue;
          visited.add(key);

          const body = step.routine.unit.masked.slice(step.routine.bodyStart, step.routine.end);
          const what = readIn(body);
          if (what) {
            hit = { chain: step.chain, what };
            break;
          }
          for (const callee of calleesOf(body, step.routine.unit.moduleKey)) {
            next.push({ ...callee, chain: [...step.chain, callee.name] });
          }
        }
        frontier = next;
      }
      if (!hit) continue;

      findings.push({
        file: unit.path,
        severity: 'warn',
        rule: 'qg:BSL-DB-READ-IN-LOOP',
        line: lineAt(unit.source, loop.headerEnd),
        message:
          `из тела цикла достижимо обращение к базе: ${hit.chain.join(' → ')} — ${hit.what}. ` +
          'Метод вызывается на каждом витке, поэтому обращений будет столько, сколько витков: на ' +
          'документе в тысячу строк это тысяча чтений вместо одного. Собери данные по всему набору ' +
          'до цикла — одним запросом либо пакетным методом библиотеки — и передавай внутрь готовыми ' +
          '(#std436). Инструмент показывает достижимость, а не место: чтение может стоять в любой ' +
          'части вызванного метода, в том числе до его собственного цикла — проверь по цепочке, ' +
          'выполняется ли оно на каждом витке внешнего. Прямую форму («Новый Запрос» в теле самого ' +
          'цикла) ловит анализатор',
      });
    }
  }

  return findings;
}

function checkFile(path) {
  if (!existsSync(path)) {
    return {
      findings: [{ severity: 'error', rule: 'file-missing', line: 0, message: 'файл не найден' }],
      metaResolved: false,
      formResolved: false,
    };
  }
  const source = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const findings = lintSource(source, basename(path));
  findings.push(...lintUnboundedColumns(source));
  findings.push(...lintRefDotAccess(source));
  findings.push(...lintDispatchFallback(source));
  const objectXml = findObjectXml(path);
  let metaResolved = false;
  if (objectXml) {
    metaResolved = true;
    const fields = refTypedFields(readFileSync(objectXml, 'utf8').replace(/^﻿/, ''));
    findings.push(...lintRefAssignments(source, fields));
  }
  const formXml = findFormXml(path);
  let formResolved = false;
  if (formXml) {
    formResolved = true;
    const attributes = primitiveFormAttributes(readFileSync(formXml, 'utf8').replace(/^﻿/, ''));
    findings.push(...lintFormAttrShadow(source, attributes));
  }
  return { findings, metaResolved, formResolved, source };
}

function evidenceBlock(findings, modulesSeen, metaResolved, files = [], formsSeen = false, formResolved = false) {
  const lines = [];

  const hitTxn = modulesSeen && findings.some((f) => f.rule === 'qg:BSL-TXN-IN-HANDLER');
  // Отмечается любой исход. Проверка применима лишь к модулям объекта и набора записей, но
  // «инструмент посмотрел файлы и не нашёл среди них таких» — это работа, а не её отсутствие;
  // без отметки такой `not_applicable` неотличим от строки, написанной вместо запуска.
  recordRun({
    scope: 'transaction-nesting',
    tool: 'tools/bsl-lint.mjs',
    verdict: !modulesSeen ? 'not_applicable' : hitTxn ? 'violation' : 'clean',
    files,
  });
  lines.push(
    !modulesSeen
      ? '[qg skipped: layer=code, scope=transaction-nesting, reason=not_applicable]'
      : '[qg applied: layer=code, scope=transaction-nesting, ids=[qg:BSL-TXN-IN-HANDLER], ' +
        `verdict=${hitTxn ? 'violation:qg:BSL-TXN-IN-HANDLER' : 'clean'}]`
  );

  // Своя запись на каждое правило: вердикт по транзакциям ничего не говорит о ссылочных
  // присваиваниях. Модуль вне выгрузки метаданных (XML объекта не найден) даёт пропуск с
  // причиной: «не смог проверить» и «проверил, чисто» — разные утверждения.
  const hitRef = metaResolved && findings.some((f) => f.rule === 'qg:BSL-ENUM-STRING-ASSIGN');
  recordRun({
    scope: 'enum-string-assign',
    tool: 'tools/bsl-lint.mjs',
    verdict: !metaResolved ? 'no_metadata_resolved' : hitRef ? 'violation' : 'clean',
    files,
  });
  lines.push(
    !metaResolved
      ? '[qg skipped: layer=code, scope=enum-string-assign, reason=no_metadata_resolved]'
      : '[qg applied: layer=code, scope=enum-string-assign, ids=[qg:BSL-ENUM-STRING-ASSIGN], ' +
        `verdict=${hitRef ? 'violation:qg:BSL-ENUM-STRING-ASSIGN' : 'clean'}]`
  );

  // Пропуска у этой проверки нет: она применима к ЛЮБОМУ модулю, метаданных ей не нужно, и
  // модуль без `Колонки.Добавить` — это проверенный модуль, а не непроверяемый. Заяви
  // инструмент здесь `not_applicable`, и покрытие изменённых .bsl осталось бы незакрытым.
  const hitCols = findings.some((f) => f.rule === 'qg:BSL-UNBOUNDED-STRING-COLUMN');
  recordRun({
    scope: 'unbounded-string-column',
    tool: 'tools/bsl-lint.mjs',
    verdict: hitCols ? 'violation' : 'clean',
    files,
  });
  lines.push(
    '[qg applied: layer=code, scope=unbounded-string-column, ids=[qg:BSL-UNBOUNDED-STRING-COLUMN], ' +
      `verdict=${hitCols ? 'violation:qg:BSL-UNBOUNDED-STRING-COLUMN' : 'clean'}]`
  );

  // Пропуска тоже нет: разбор по веткам возможен в любом модуле, метаданные правилу не нужны,
  // и модуль без цепочек — это проверенный модуль. Порог в три ветки и контр-сигналы живут
  // внутри правила, вердикт же говорит ровно об одном: незакрытых цепочек не найдено.
  const hitDispatch = findings.some((f) => f.rule === 'qg:BSL-DISPATCH-NO-FALLBACK');
  recordRun({
    scope: 'dispatch-fallback',
    tool: 'tools/bsl-lint.mjs',
    verdict: hitDispatch ? 'violation' : 'clean',
    files,
  });
  lines.push(
    '[qg applied: layer=code, scope=dispatch-fallback, ids=[qg:BSL-DISPATCH-NO-FALLBACK], ' +
      `verdict=${hitDispatch ? 'violation:qg:BSL-DISPATCH-NO-FALLBACK' : 'clean'}]`
  );

  // Вердикт по одному файлу здесь означает меньше, чем по нескольким: граф вызовов строится
  // по файлам прогона, и чем их меньше, тем короче видимые цепочки. «Чисто» читается как
  // «в переданном составе цепочки не нашлось», и это сказано в тексте правила.
  const hitLoopRead = findings.some((f) => f.rule === 'qg:BSL-DB-READ-IN-LOOP');
  recordRun({
    scope: 'db-read-in-loop',
    tool: 'tools/bsl-lint.mjs',
    verdict: hitLoopRead ? 'violation' : 'clean',
    files,
  });
  lines.push(
    '[qg applied: layer=code, scope=db-read-in-loop, ids=[qg:BSL-DB-READ-IN-LOOP,std436], ' +
      `verdict=${hitLoopRead ? 'violation:qg:BSL-DB-READ-IN-LOOP' : 'clean'}]`
  );

  // `attribute-access` до этого правила был проверкой без инструмента: строку следа писала
  // модель, и валидатору нечем было отличить прогон от чтения глазами. Теперь строку печатает
  // инструмент и отмечается в журнале — рукописный «clean» по этому имени больше не проходит.
  // Покрытие при этом частичное (ярус A, конвенция имён), и вердикт «clean» означает
  // «механическая часть чиста», а не «#std437 проверен целиком».
  const hitDot = findings.some((f) => f.rule === 'qg:BSL-REF-DOT-ACCESS');
  recordRun({
    scope: 'attribute-access',
    tool: 'tools/bsl-lint.mjs',
    verdict: hitDot ? 'violation' : 'clean',
    files,
  });
  lines.push(
    '[qg applied: layer=code, scope=attribute-access, ids=[qg:BSL-REF-DOT-ACCESS,std437], ' +
      `verdict=${hitDot ? 'violation:qg:BSL-REF-DOT-ACCESS' : 'clean'}]`
  );

  // Три исхода вместо двух. Модуля формы в списке не было — правило неприменимо; модуль был,
  // а Form.xml рядом нет (выгрузка неполная, файл вне дерева) — список реквизитов взять
  // неоткуда, и это «не смог проверить», а не «чисто». Слить их в один вердикт значит
  // объявить проверенным то, что проверке не подвергалось.
  const hitShadow = findings.some((f) => f.rule === 'qg:BSL-FORM-ATTR-SHADOW');
  recordRun({
    scope: 'form-attribute-shadowing',
    tool: 'tools/bsl-lint.mjs',
    verdict: !formsSeen ? 'not_applicable' : !formResolved ? 'no_metadata_resolved' : hitShadow ? 'violation' : 'clean',
    files,
  });
  lines.push(
    !formsSeen
      ? '[qg skipped: layer=code, scope=form-attribute-shadowing, reason=not_applicable]'
      : !formResolved
        ? '[qg skipped: layer=code, scope=form-attribute-shadowing, reason=no_metadata_resolved]'
        : '[qg applied: layer=code, scope=form-attribute-shadowing, ids=[qg:BSL-FORM-ATTR-SHADOW], ' +
          `verdict=${hitShadow ? 'violation:qg:BSL-FORM-ATTR-SHADOW' : 'clean'}]`
  );

  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));

  if (files.length === 0) {
    process.stderr.write('Использование: node bsl-lint.mjs <файл.bsl> [<файл.bsl> ...] [--json]\n');
    return 2;
  }

  const report = files.map((f) => ({ file: f, ...checkFile(f) }));

  // Правило про чтение базы из цикла — единственное, которому мало одного файла: цикл и
  // чтение обычно лежат в разных методах, а нередко и в разных модулях. Граф строится по
  // файлам ЭТОГО прогона, и то, что модуль в него не попал, ничего не доказывает.
  const units = report
    .filter((r) => typeof r.source === 'string')
    .map((r) => ({ path: r.file, source: r.source, masked: maskModule(r.source), moduleKey: moduleKeyOf(r.file) }));
  for (const finding of lintDbReadsInLoops(units)) {
    const target = report.find((r) => r.file === finding.file);
    if (target) target.findings.push(finding);
  }

  const findings = report.flatMap((r) => r.findings);
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;

  // Проверка применима не ко всякому файлу: модуль формы, общий модуль и модуль менеджера
  // неявной транзакции не имеют. Если таких файлов не было вовсе — это `not_applicable`,
  // а не «чисто»: молчание об области применения читается как проведённая проверка.
  const modulesSeen = files.some((f) => IMPLICIT_TRANSACTION_MODULES.has(basename(f)));
  const metaResolved = report.some((r) => r.metaResolved);
  // «Модуль формы» определяется по форме пути (`…/Ext/Form/Module.bsl`), а наличие описания
  // формы рядом — отдельным фактом: без него список реквизитов пуст и сверять не с чем.
  const formsSeen = files.some((f) => basename(f) === 'Module.bsl' && basename(dirname(f)) === 'Form');
  const formResolved = report.some((r) => r.formResolved);
  const evidence = evidenceBlock(findings, modulesSeen, metaResolved, files, formsSeen, formResolved);

  if (asJson) {
    process.stdout.write(JSON.stringify({ files: report, errors, warns, evidence }, null, 2) + '\n');
    return errors ? 2 : warns ? 1 : 0;
  }

  for (const r of report) {
    if (r.findings.length === 0) continue;
    process.stdout.write(`${r.file}\n`);
    for (const f of r.findings) {
      const where = f.line ? `:${f.line}` : '';
      process.stdout.write(`  ${f.severity === 'error' ? 'ОШИБКА' : 'ВНИМАНИЕ'}${where} [${f.rule}] ${f.message}\n`);
    }
    process.stdout.write('\n');
  }
  process.stdout.write(
    `Проверено файлов: ${files.length}, из них модулей с неявной транзакцией: ` +
      `${files.filter((f) => IMPLICIT_TRANSACTION_MODULES.has(basename(f))).length}. ` +
      `Ошибок: ${errors}, предупреждений: ${warns}.${versionSuffix()}\n`
  );
  process.stdout.write('\n## quality evidence\n\n' + evidence + '\n');

  return errors ? 2 : warns ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bsl-lint.mjs')) {
  process.exit(main(process.argv));
}
