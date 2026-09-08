#!/usr/bin/env node
/**
 * Лексические проверки текстов запросов, встроенных в BSL.
 *
 * Проверок четыре:
 *   - `qg:QRY-ALIAS-SHADOWS-FIELD` — псевдоним источника, совпадающий с именем колонки
 *     временной таблицы того же пакета;
 *   - `qg:QRY-ALIAS-SHADOWS-NESTED-TABLE` — псевдоним источника-табличной-части, совпадающий
 *     с именем самой табличной части, когда в ветке соединён её владелец;
 *   - `qg:QRY-TOP-WITHOUT-ORDER` — `ПЕРВЫЕ N` без `УПОРЯДОЧИТЬ ПО`;
 *   - `qg:QRY-ALIAS-RESERVED-WORD` — служебное слово языка запросов в псевдониме: такой
 *     запрос не выполняется вовсе, а собирается и проходит анализ как исправный.
 *
 * Зачем отдельный инструмент. Текст запроса — строковый литерал. Его не разбирает ни
 * статический анализатор, ни валидаторы XML, ни сборка бинарника: тела модулей
 * компилируются, литерал остаётся литералом. Класс дефекта доживает до продуктива и падает
 * в рантайме сообщением «Неоднозначное поле».
 *
 * Почему код, а не правило для модели. Правило про совпадение псевдонима с именем поля в
 * своде было и раньше — и не сработало: оно называет не ту пару (поле таблицы-источника
 * вместо колонки временной таблицы), а проверка «посмотри внимательно» неотличима от
 * непроведённой. Пересечение двух множеств имён считается механически и потому детерминировано.
 *
 * Носители запросов. Кроме литералов в `.bsl` разбираются XML-носители: `<query>` схемы
 * компоновки данных (Template.xml отчётов и общих макетов) и `<QueryText>` динамического
 * списка (Form.xml). Для них номер строки в находке считается ОТ НАЧАЛА ТЕКСТА ЗАПРОСА —
 * ровно так нумерует строки платформа в своих сообщениях (`{(51, 44)}: Неоднозначное
 * поле…`), поэтому цифры прямо сопоставимы с ошибкой рантайма.
 *
 * Приближения заявлены прямо, потому что от них зависит доверие к вердикту:
 *   - запрос, собранный конкатенацией или через `СтрШаблон`, виден лишь частями и потому
 *     пропускается — коллизия между частями не найдётся;
 *   - колонки известны только у временных таблиц пакета, а имена табличных частей — только
 *     те, что названы самим текстом запроса. Коллизия псевдонима с именем реквизита реальной
 *     таблицы требует выгрузки метаданных и здесь не ловится намеренно: замер показал, что
 *     такое обобщение даёт ложную находку на рабочем типовом коде;
 *   - в XML читаются только известные носители (`<query>`, `<QueryText>`); прочие XML
 *     считаются файлами без запросов;
 *   - ключевые слова только русские: английский вариант языка запросов платформа понимает,
 *     но в прикладном коде он не встречается.
 *
 * Использование:
 *   node query-lint.mjs <файл.bsl|файл.xml> [<файл> ...] [--json]
 */

import { readFileSync, existsSync } from 'node:fs';
import { recordRun } from './run-journal.mjs';
import { versionSuffix } from './config.mjs';

/** Символы, из которых состоит идентификатор 1С. Кириллица делает `\b` в JS бесполезной. */
const W = 'A-Za-zА-Яа-яЁё0-9_';
const IDENT = `[A-Za-zА-Яа-яЁё_][${W}]*`;

/** Слово целиком, с границами по правилам 1С, а не по `\w`. */
function word(w, flags = 'gi') {
  return new RegExp(`(?<![${W}])(?:${w})(?![${W}])`, flags);
}

/**
 * Проверка вхождения слова.
 *
 * Отдельной функцией, потому что `test()` глобальной регулярки продолжает поиск с прошлого
 * места: общий на модуль объект молча возвращал бы то `true`, то `false` на одном и том же
 * тексте — дефект, который проявляется только на втором вызове.
 */
function hasWord(text, re) {
  re.lastIndex = 0;
  return re.test(text);
}

const RE_SELECT = word('ВЫБРАТЬ');
const RE_FROM = word('ИЗ');
const RE_INTO = word('ПОМЕСТИТЬ');
const RE_AS = word('КАК');
const RE_UNION = word('ОБЪЕДИНИТЬ(?:\\s+ВСЕ)?');
/** Слова, за которыми секция источников заканчивается. */
const RE_AFTER_SOURCES = word('ГДЕ|СГРУППИРОВАТЬ|ИМЕЮЩИЕ|УПОРЯДОЧИТЬ|ИТОГИ|ИНДЕКСИРОВАТЬ|АВТОУПОРЯДОЧИВАНИЕ|ДЛЯ');
/** Модификаторы между `ВЫБРАТЬ` и списком полей. */
const RE_SELECT_MODIFIERS = new RegExp(`^\\s*(?:(?:${['РАЗРЕШЕННЫЕ', 'РАЗЛИЧНЫЕ'].join('|')})\\s+)*(?:ПЕРВЫЕ\\s+\\d+\\s+)?`, 'iu');
const RE_TOP = word('ПЕРВЫЕ');
const RE_ORDER = word('УПОРЯДОЧИТЬ');
const RE_AUTOORDER = word('АВТОУПОРЯДОЧИВАНИЕ');

/**
 * Глубина вложенности скобок для каждой позиции текста.
 *
 * Нужна, чтобы отличить псевдоним источника от подделок: `ВЫРАЗИТЬ(Поле КАК Документ.Х)`
 * содержит `КАК`, но это приведение типа, и живёт оно внутри скобок. Псевдоним источника
 * всегда на нулевой глубине секции `ИЗ`. Тот же приём отсекает вложенные запросы в
 * параметрах виртуальных таблиц.
 */
function depthMap(text) {
  const depth = new Int32Array(text.length);
  let d = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') {
      depth[i] = d;
      d++;
      continue;
    }
    if (c === ')') d = Math.max(0, d - 1);
    depth[i] = d;
  }
  return depth;
}

/** Совпадения регулярки, лежащие на нулевой глубине скобок. */
function matchesAtTopLevel(text, re, depth) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (depth[m.index] === 0) out.push({ index: m.index, text: m[0] });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

/**
 * Строка `pos` — комментарий BSL внутри многострочного литерала?
 *
 * Многострочный литерал продолжается строками, начинающимися с `|`; строка, начинающаяся
 * с `//`, комментарием и является — так её видит и платформа. Проверка нужна там, где
 * литерал уже начат: кавычка в таком комментарии не должна его закрывать.
 */
function commentLineEnd(source, pos) {
  let k = pos;
  while (k < source.length && (source[k] === ' ' || source[k] === '\t' || source[k] === '\r')) k++;
  if (source[k] !== '/' || source[k + 1] !== '/') return -1;
  const nl = source.indexOf('\n', k);
  return nl === -1 ? source.length : nl;
}

/**
 * Вырезает из BSL строковые литералы, похожие на текст запроса.
 *
 * Возвращает позицию начала литерала в файле — по ней потом считается номер строки находки.
 * Комментарии BSL пропускаются: закомментированный запрос проверять не за чем.
 *
 * Комментарий ВНУТРИ литерала пропускается тоже, и это не мелочь оформления. Строка вида
 * `// признак операции "Розница" — фиксируем отгрузку` между строками продолжения законна,
 * а её кавычка иначе закрывает литерал раньше времени: один запрос разъезжается на два
 * обрывка, коллизия между ними не находится, а в обрывке псевдонимами источников выглядят
 * псевдонимы колонок выборки — то есть дефект не только теряет находки, но и изготавливает
 * ложные. Замерено на боевой конфигурации: 251 такая строка в 42 файлах.
 */
export function extractQueryLiterals(source) {
  const found = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (c !== '"') {
      i++;
      continue;
    }
    const start = i + 1;
    let j = start;
    while (j < source.length) {
      if (source[j] === '\n') {
        const end = commentLineEnd(source, j + 1);
        if (end !== -1) {
          j = end;
          continue;
        }
      }
      if (source[j] === '"') {
        // Удвоенная кавычка — литерал внутри текста запроса, а не конец BSL-строки.
        if (source[j + 1] === '"') {
          j += 2;
          continue;
        }
        break;
      }
      j++;
    }
    const raw = source.slice(start, j);
    if (hasWord(raw, RE_SELECT) && (hasWord(raw, RE_FROM) || hasWord(raw, RE_INTO))) {
      found.push({ raw, start });
    }
    i = j + 1;
  }
  return found;
}

/**
 * Гасит всё, что не является кодом запроса: продолжения `|`, строковые литералы SDBL и
 * комментарии внутри текста запроса.
 *
 * Замена посимвольная — длина сохраняется, поэтому позиция находки в маске равна позиции в
 * исходном файле. Без этого пришлось бы вести карту смещений, а она разъезжается первой.
 */
export function maskLiteral(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    const chars = line.split('');
    // Вертикальная черта продолжения — часть синтаксиса BSL, для запроса её нет.
    const bar = line.search(/\S/);
    if (bar !== -1 && line[bar] === '|') chars[bar] = ' ';

    let inString = false;
    for (let k = 0; k < chars.length; k++) {
      if (!inString && chars[k] === '/' && chars[k + 1] === '/') {
        for (let m = k; m < chars.length; m++) chars[m] = ' ';
        break;
      }
      if (chars[k] === '"' && chars[k + 1] === '"') {
        chars[k] = ' ';
        chars[k + 1] = ' ';
        k++;
        inString = !inString;
        continue;
      }
      if (inString) chars[k] = ' ';
    }
    out.push(chars.join(''));
  }
  return out.join('\n');
}

/**
 * Гасит литералы и комментарии в «голом» тексте запроса — не BSL-литерале, а тексте из
 * XML-носителя. Отличие от `maskLiteral`: кавычки здесь настоящие (не удвоенные), а
 * вертикальной черты продолжения нет вовсе.
 */
export function maskBareQuery(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    const chars = line.split('');
    let inString = false;
    for (let k = 0; k < chars.length; k++) {
      if (!inString && chars[k] === '/' && chars[k + 1] === '/') {
        for (let m = k; m < chars.length; m++) chars[m] = ' ';
        break;
      }
      if (chars[k] === '"') {
        chars[k] = ' ';
        inString = !inString;
        continue;
      }
      if (inString) chars[k] = ' ';
    }
    out.push(chars.join(''));
  }
  return out.join('\n');
}

/** Пять сущностей, которыми экспорт платформы кодирует текст запроса в XML. `&amp;` — последней. */
function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Извлекает тексты запросов из XML-носителей.
 *
 * `fileLine` — строка файла, где начинается текст запроса: по ней находку можно найти в
 * файле, тогда как `line` самой находки считается внутри текста запроса — как у платформы.
 */
export function extractXmlQueries(xml) {
  const out = [];
  const re = /<(?:[\w.]+:)?(query|QueryText)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.]+:)?\1\s*>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const bodyOffset = m.index + m[0].indexOf('>') + 1;
    out.push({ text: decodeXmlEntities(m[2]), fileLine: lineAt(xml, bodyOffset) });
  }
  return out;
}

/** Разбивает пакет по `;`. Разделители внутри литералов SDBL уже погашены маской. */
function splitBatch(masked) {
  const parts = [];
  let from = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== ';') continue;
    parts.push({ text: masked.slice(from, i), offset: from });
    from = i + 1;
  }
  if (from < masked.length) parts.push({ text: masked.slice(from), offset: from });
  return parts.filter((p) => hasWord(p.text, RE_SELECT));
}

/** Ветви `ОБЪЕДИНИТЬ [ВСЕ]` внутри одного запроса пакета — у каждой своя секция источников. */
function splitUnionBranches(query) {
  const depth = depthMap(query.text);
  const cuts = matchesAtTopLevel(query.text, RE_UNION, depth);
  const branches = [];
  let from = 0;
  for (const cut of cuts) {
    branches.push({ text: query.text.slice(from, cut.index), offset: query.offset + from });
    from = cut.index + cut.text.length;
  }
  branches.push({ text: query.text.slice(from), offset: query.offset + from });
  return branches;
}

/** Имя временной таблицы, создаваемой веткой, и имена её колонок. */
function parseInto(branch) {
  const depth = depthMap(branch.text);
  const into = matchesAtTopLevel(branch.text, RE_INTO, depth)[0];
  if (!into) return null;

  const tail = branch.text.slice(into.index + into.text.length);
  const name = tail.match(new RegExp(`^\\s*(${IDENT})`, 'u'));
  if (!name) return null;

  const select = matchesAtTopLevel(branch.text, RE_SELECT, depth)[0];
  if (!select || select.index > into.index) return { name: name[1], columns: [] };

  const list = branch.text.slice(select.index + select.text.length, into.index).replace(RE_SELECT_MODIFIERS, '');
  return { name: name[1], columns: selectListColumns(list) };
}

/**
 * Имена колонок по списку полей выборки.
 *
 * Форм ровно две, и обе обязательны: `Перемещение.Ссылка КАК Перемещение` даёт колонку по
 * псевдониму, а `Связи.Перемещение` — по имени поля. Собрать только первую значит не увидеть
 * половину коллизий.
 */
export function selectListColumns(list) {
  const depth = depthMap(list);
  const items = [];
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === ',' && depth[i] === 0) {
      items.push(list.slice(from, i));
      from = i + 1;
    }
  }
  items.push(list.slice(from));

  const columns = [];
  for (const item of items) {
    const itemDepth = depthMap(item);
    const aliases = matchesAtTopLevel(item, RE_AS, itemDepth);
    const last = aliases[aliases.length - 1];
    if (last) {
      const named = item.slice(last.index + last.text.length).match(new RegExp(`^\\s*(${IDENT})`, 'u'));
      if (named) columns.push(named[1]);
      continue;
    }
    // Без псевдонима колонку именует последний сегмент поля: `Связи.Перемещение` → `Перемещение`.
    const bare = item.trim().match(new RegExp(`(?:^|\\.)(${IDENT})$`, 'u'));
    if (bare) columns.push(bare[1]);
  }
  return columns;
}

/** Псевдонимы источников ветки и текст её секции `ИЗ` — по нему видно, какие ВТ задействованы. */
function parseSources(branch) {
  const depth = depthMap(branch.text);
  const from = matchesAtTopLevel(branch.text, RE_FROM, depth)[0];
  if (!from) return { aliases: [], sourcesText: '', sourcesStart: 0 };

  const start = from.index + from.text.length;
  const stop = matchesAtTopLevel(branch.text, RE_AFTER_SOURCES, depth).find((m) => m.index > start);
  const end = stop ? stop.index : branch.text.length;
  const sourcesText = branch.text.slice(start, end);

  const sourcesDepth = depthMap(sourcesText);
  const aliases = [];
  for (const as of matchesAtTopLevel(sourcesText, RE_AS, sourcesDepth)) {
    const named = sourcesText.slice(as.index + as.text.length).match(new RegExp(`^\\s*(${IDENT})`, 'u'));
    if (named) aliases.push({ name: named[1], index: start + as.index, ...sourcePathBefore(sourcesText, as.index) });
  }
  return { aliases, sourcesText, sourcesStart: start };
}

/**
 * Путь источника, стоящий перед `КАК`: `Документ.Реализация.Товары`, `ВТ_Заказы`, `&Таблица`.
 *
 * Разбор идёт назад от ключевого слова, потому что вперёд от начала источника мешают
 * ключевые слова соединений: у `ЛЕВОЕ СОЕДИНЕНИЕ Документ.Х КАК Д` и у первого источника
 * секции разные левые границы, а правая — одна и та же.
 *
 * Скобки виртуальной таблицы (`РегистрНакопления.Х.Остатки(&Дата) КАК Т`) перескакиваются
 * как единая группа, и такой источник помечается `virtual`: у виртуальной таблицы состав
 * полей задаёт платформа, и рассуждать о нём по имени нельзя.
 */
function sourcePathBefore(text, asIndex) {
  let i = asIndex - 1;
  while (i >= 0 && /\s/u.test(text[i])) i--;

  let virtual = false;
  if (text[i] === ')') {
    virtual = true;
    let depth = 1;
    i--;
    while (i >= 0 && depth > 0) {
      if (text[i] === ')') depth++;
      else if (text[i] === '(') depth--;
      i--;
    }
    while (i >= 0 && /\s/u.test(text[i])) i--;
  }

  const pathChar = new RegExp(`[${W}.]`, 'u');
  let j = i;
  while (j >= 0 && pathChar.test(text[j])) j--;
  const path = text.slice(j + 1, i + 1);
  return { path: path || null, virtual };
}

/**
 * `ПЕРВЫЕ N` без `УПОРЯДОЧИТЬ ПО`.
 *
 * Какие именно N строк вернёт платформа, не определено: порядок задаёт СУБД, и он меняется
 * между прогонами, между версиями и между движками. Код, отобравший «первые 10 договоров»,
 * на тестовой базе работает, а в продуктиве начинает выдавать другие десять.
 *
 * Проверка на уровне запроса пакета, а не ветки: в объединении `УПОРЯДОЧИТЬ ПО` относится ко
 * всему результату и стоит в конце последней ветки.
 *
 * Законные формы, на которых правило молчит:
 *   - `ПЕРВЫЕ 1` — проверка существования: результат используется как «пусто или нет», и
 *     какая именно строка пришла, значения не имеет;
 *   - `АВТОУПОРЯДОЧИВАНИЕ` — порядок задан, пусть и неявно.
 *
 * `ПОМЕСТИТЬ` законной формой НЕ является, хотя выглядит похоже: порядок строк внутри
 * временной таблицы потребителю действительно не виден, но отбор N строк произошёл раньше
 * помещения — недетерминирован уже он. Это самый частый реальный случай: предварительный
 * отбор в `ВТ_*` перед соединением.
 */
function checkTopWithoutOrder(source, literal, query) {
  const depth = depthMap(query.text);
  if (matchesAtTopLevel(query.text, RE_ORDER, depth).length > 0) return [];
  if (matchesAtTopLevel(query.text, RE_AUTOORDER, depth).length > 0) return [];

  const findings = [];
  for (const top of matchesAtTopLevel(query.text, RE_TOP, depth)) {
    const limit = query.text.slice(top.index + top.text.length).match(/^\s*(\d+)/u);
    if (!limit) continue;
    if (Number(limit[1]) <= 1) continue;

    const pos = literal.start + query.offset + top.index;
    findings.push({
      severity: 'warn',
      rule: 'qg:QRY-TOP-WITHOUT-ORDER',
      line: lineAt(source, pos),
      limit: Number(limit[1]),
      message:
        `«ПЕРВЫЕ ${limit[1]}» без «УПОРЯДОЧИТЬ ПО»: какие именно ${limit[1]} строк вернутся, ` +
        'не определено — набор меняется между прогонами и между СУБД',
    });
  }
  return findings;
}

/**
 * Служебные слова языка запросов, которые платформа не принимает как псевдоним.
 *
 * Списки измерены на платформе 8.3.27, а не выведены из синтаксиса: каждое слово
 * подставлялось псевдонимом в `ВЫБРАТЬ ПЕРВЫЕ 1 <Т>.Ссылка КАК <поле> ИЗ Справочник.Валюты
 * КАК <Т>`, и запрос выполнялся. Из 66 кандидатов ломают 31 в обеих позициях и ещё два —
 * только в позиции источника.
 *
 * Вывод из синтаксиса дал бы шум: `ИТОГИ`, `ОБЪЕДИНИТЬ`, `СОЕДИНЕНИЕ`, `УПОРЯДОЧИТЬ`,
 * `ИНДЕКСИРОВАТЬ`, `СУММА`, `КОЛИЧЕСТВО`, `ЗНАЧЕНИЕ`, `ДАТА`, `ТИП` — ключевые слова и функции,
 * но псевдонимом работают. `ВНУТРЕННЕЕ СОЕДИНЕНИЕ ВТ КАК Итоги` стоит в типовом менеджере
 * обмена через универсальный формат и выполняется.
 */
const RESERVED_ALIAS = new Set([
  'ПЕРВЫЕ', 'РАЗЛИЧНЫЕ', 'РАЗРЕШЕННЫЕ', 'ПОМЕСТИТЬ', 'ИЗ', 'ГДЕ', 'ПО', 'ОБЩИЕ', 'ВНУТРЕННЕЕ',
  'ВОЗР', 'УБЫВ', 'АВТОУПОРЯДОЧИВАНИЕ', 'ПЕРИОДАМИ', 'ДЛЯ', 'И', 'ИЛИ', 'НЕ', 'В', 'МЕЖДУ',
  'ПОДОБНО', 'СПЕЦСИМВОЛ', 'ЕСТЬ', 'ВЫБОР', 'КОГДА', 'ТОГДА', 'ИНАЧЕ', 'ВЫРАЗИТЬ', 'ИСТИНА',
  'ЛОЖЬ', 'ТОЛЬКО', 'КАК',
]);

/** Ломают только псевдоним источника: в списке выборки эти имена законны и повсеместны. */
const RESERVED_SOURCE_ALIAS = new Set([...RESERVED_ALIAS, 'ССЫЛКА', 'ПРЕДСТАВЛЕНИЕ']);

/** Явные псевдонимы списка выборки вместе с позициями: `Т.Поле КАК Имя`. */
function selectListAliases(list) {
  const depth = depthMap(list);
  const found = [];
  for (const as of matchesAtTopLevel(list, RE_AS, depth)) {
    const tail = list.slice(as.index + as.text.length);
    const named = tail.match(new RegExp(`^\\s*(${IDENT})`, 'u'));
    if (named) found.push({ name: named[1], index: as.index });
  }
  return found;
}

/**
 * Служебное слово языка запросов в псевдониме.
 *
 * Дефект переживает всё, кроме выполнения: текст собирается, статический анализ молчит, сборка
 * проходит. Падает платформа — и падает целиком, то есть ветка кода не работает ни разу. Именно
 * так в контуре чеков АТОЛ прожил запрос с псевдонимом `Первые`: его нашли не инструменты, а
 * человек, выполнивший запрос руками.
 *
 * Позиция псевдонима различается: у источника запрещённых слов на два больше, потому что
 * `Ссылка` и `Представление` в позиции таблицы разбираются как обращение и как функция.
 */
function checkReservedAliases(source, literal, branch, aliases) {
  const findings = [];

  const report = (name, pos, where) => {
    findings.push({
      severity: 'error',
      rule: 'qg:QRY-ALIAS-RESERVED-WORD',
      line: lineAt(source, pos),
      alias: name,
      position: where,
      message:
        `псевдоним ${where === 'source' ? 'источника' : 'поля'} «${name}» — служебное слово языка ` +
        'запросов: платформа откажется выполнять запрос, хотя текст собирается и анализ молчит',
    });
  };

  for (const alias of aliases) {
    if (!RESERVED_SOURCE_ALIAS.has(alias.name.toUpperCase())) continue;
    report(alias.name, literal.start + branch.offset + alias.index, 'source');
  }

  const depth = depthMap(branch.text);
  const select = matchesAtTopLevel(branch.text, RE_SELECT, depth)[0];
  if (select) {
    const stopper = matchesAtTopLevel(branch.text, RE_INTO, depth)[0]
      || matchesAtTopLevel(branch.text, RE_FROM, depth)[0];
    const listStart = select.index + select.text.length;
    const listEnd = stopper && stopper.index > listStart ? stopper.index : branch.text.length;
    const list = branch.text.slice(listStart, listEnd);
    for (const alias of selectListAliases(list)) {
      if (!RESERVED_ALIAS.has(alias.name.toUpperCase())) continue;
      report(alias.name, literal.start + branch.offset + listStart + alias.index, 'field');
    }
  }

  return findings;
}

/** Номер строки в файле по абсолютному смещению. */
function lineAt(source, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

/** Классы метаданных, у которых бывают табличные части. Регистры и перечисления — нет. */
const NESTED_TABLE_OWNERS = new Set(
  ['Документ', 'Справочник', 'ПланВидовХарактеристик', 'ПланСчетов', 'ПланОбмена', 'ПланВидовРасчета', 'БизнесПроцесс', 'Задача'].map((s) =>
    s.toLowerCase()
  )
);

/**
 * Псевдоним источника-табличной-части, совпадающий с именем самой табличной части, когда в
 * той же ветке соединён её владелец.
 *
 * Почему это неоднозначность. Табличная часть — полноценное поле объектной таблицы: язык
 * запросов умеет выбирать вложенные таблицы (`Заказ.Товары.(Номенклатура, Количество)`).
 * Поэтому при соединённом владельце имя `Товары` без квалификатора разрешается в его поле —
 * и совпадает с псевдонимом источника. Платформа отказывается выбирать: «Неоднозначное поле».
 *
 * Почему без метаданных. Оба источника названы текстом запроса: `Документ.Заказ.Товары` и
 * `Документ.Заказ`. Имя табличной части — третий сегмент первого пути, владелец — первые два.
 * Выгрузка конфигурации не нужна, а значит правило работает и на чужом проекте.
 *
 * Контр-сигнал. Законной формы у совпадения нет: пока владелец в ветке, имя занято. Замер на
 * боевой конфигурации (48 828 файлов, 43 049 веток) даёт ноль срабатываний — и при этом
 * 1 337 источников табличных частей названы именем своей ТЧ там, где владельца в ветке нет,
 * то есть стиль именования, фатальный внутри предиката, снаружи него доминирует.
 *
 * Границу правила держит именно «владелец В ЭТОЙ ЖЕ ветке». Обобщение «псевдоним ЛЮБОГО
 * источника против имени ТЧ любой соединённой таблицы» опровергнуто замером: в типовой
 * конфигурации нашёлся рабочий запрос, где псевдоним временной таблицы совпадает с именем
 * табличной части соседнего документа и разыменование присутствует. Одна ложная находка на
 * одну находку уровня «ошибка» — обобщение не выпускается.
 */
function checkNestedTableShadowing(source, literal, branch, aliases) {
  const findings = [];
  const paths = new Set(aliases.filter((a) => a.path && !a.virtual).map((a) => a.path.toLowerCase()));

  for (const alias of aliases) {
    if (!alias.path || alias.virtual) continue;
    const segments = alias.path.split('.');
    if (segments.length !== 3) continue;
    if (!NESTED_TABLE_OWNERS.has(segments[0].toLowerCase())) continue;
    if (alias.name.toLowerCase() !== segments[2].toLowerCase()) continue;
    if (!paths.has(`${segments[0]}.${segments[1]}`.toLowerCase())) continue;

    // Градация та же, что у затенения колонки ВТ: падает платформа на обращении через точку,
    // без обращения имя лишь заминировано. Отрицательный просмотр назад по точке оставляет
    // законную форму `Владелец.ТабличнаяЧасть` в стороне — это и есть правильное написание.
    const deref = new RegExp(`(?<![${W}.])${alias.name}\\s*\\.`, 'iu').exec(branch.text);
    const pos = literal.start + branch.offset + (deref ? deref.index : alias.index);
    const owner = `${segments[0]}.${segments[1]}`;

    findings.push({
      severity: deref ? 'error' : 'warn',
      rule: 'qg:QRY-ALIAS-SHADOWS-NESTED-TABLE',
      line: lineAt(source, pos),
      alias: alias.name,
      owner,
      dereferenced: Boolean(deref),
      message: deref
        ? `псевдоним «${alias.name}» совпадает с именем табличной части, а её владелец ${owner} соединён в той же ветке; ` +
          `обращение «${alias.name}.…» неоднозначно — платформа откажется выполнять запрос`
        : `псевдоним «${alias.name}» совпадает с именем табличной части, а её владелец ${owner} соединён в той же ветке; ` +
          'обращения через точку сейчас нет, но любое добавленное поле сделает запрос неоднозначным',
    });
  }
  return findings;
}

/**
 * Ищет коллизии «псевдоним источника = колонка временной таблицы» во всех запросах файла.
 *
 * Экспортируется отдельно от чтения файла, чтобы проверку можно было прогнать на строке.
 */
export function lintSource(source) {
  const findings = [];
  for (const literal of extractQueryLiterals(source)) {
    lintOneLiteral(source, literal, maskLiteral(literal.raw), findings);
  }
  return findings;
}

/**
 * Проверка «голого» текста запроса из XML-носителя.
 *
 * Номера строк в находках — от начала текста запроса: платформа в сообщениях о таких
 * запросах (`{(N, M)}`) нумерует строки так же, и цифры сопоставимы напрямую.
 */
export function lintQueryText(text) {
  const findings = [];
  lintOneLiteral(text, { raw: text, start: 0 }, maskBareQuery(text), findings);
  return findings;
}

function lintOneLiteral(source, literal, masked, findings) {
  const temps = new Map(); // имя ВТ в нижнем регистре → { name, columns }

  for (const query of splitBatch(masked)) {
    findings.push(...checkTopWithoutOrder(source, literal, query));

    const branches = splitUnionBranches(query);

    for (const branch of branches) {
      const { aliases, sourcesText } = parseSources(branch);

      // До отсечки по источникам: псевдоним поля запрещён и в запросе без единого источника.
      findings.push(...checkReservedAliases(source, literal, branch, aliases));

      if (aliases.length === 0) continue;

      // До отсечки по временным таблицам намеренно: затенение табличной части ни одной ВТ
      // не требует, и мотивирующий случай правила — запрос вообще без временных таблиц.
      findings.push(...checkNestedTableShadowing(source, literal, branch, aliases));

      // Какие временные таблицы пакета участвуют в этой ветке.
      const used = [];
      for (const temp of temps.values()) {
        if (word(temp.name, 'iu').test(sourcesText)) used.push(temp);
      }
      if (used.length === 0) continue;

      for (const alias of aliases) {
        const key = alias.name.toLowerCase();
        for (const temp of used) {
          const column = temp.columns.find((c) => c.toLowerCase() === key);
          if (!column) continue;

          // Падает платформа не на самой коллизии, а на обращении к имени через точку:
          // именно там `Перемещение.Ссылка` читается и как поле источника, и как
          // разыменование колонки. Без такого обращения запрос выполнится — но имя уже
          // заминировано, и первое же добавленное поле его подорвёт.
          const deref = new RegExp(`(?<![${W}.])${alias.name}\\s*\\.`, 'iu').exec(branch.text);
          const pos = literal.start + branch.offset + (deref ? deref.index : alias.index);

          findings.push({
            severity: deref ? 'error' : 'warn',
            rule: 'qg:QRY-ALIAS-SHADOWS-FIELD',
            line: lineAt(source, pos),
            alias: alias.name,
            temp: temp.name,
            column,
            dereferenced: Boolean(deref),
            message: deref
              ? `псевдоним источника «${alias.name}» совпадает с колонкой «${column}» временной таблицы ${temp.name}; ` +
                `обращение «${alias.name}.…» неоднозначно — платформа откажется выполнять запрос`
              : `псевдоним источника «${alias.name}» совпадает с колонкой «${column}» временной таблицы ${temp.name}; ` +
                'обращения через точку сейчас нет, но любое добавленное поле сделает запрос неоднозначным',
          });
        }
      }
    }

    // Временная таблица объявляется головной веткой и видна дальше по пакету.
    const into = parseInto(branches[0]);
    if (into) temps.set(into.name.toLowerCase(), into);
  }
}

/**
 * Проверяет один файл. `queries` — сколько текстов запросов инструмент в нём УВИДЕЛ:
 * по этому числу след отличает «запросов нет» от «файл не читался».
 */
function checkFile(path) {
  if (!existsSync(path)) {
    return { findings: [{ severity: 'error', rule: 'file-missing', line: 0, message: 'файл не найден' }], queries: 0 };
  }
  const source = readFileSync(path, 'utf8').replace(/^﻿/, '');
  if (/\.xml$/i.test(path)) {
    const queries = extractXmlQueries(source);
    const findings = [];
    for (const q of queries) {
      for (const f of lintQueryText(q.text)) {
        findings.push({ ...f, queryStartLine: q.fileLine });
      }
    }
    return { findings, queries: queries.length };
  }
  return { findings: lintSource(source), queries: extractQueryLiterals(source).length };
}

/**
 * По записи следа на каждое правило.
 *
 * Одной строкой на весь инструмент обойтись нельзя: `scope` в следе — это «что именно
 * проверялось», и вердикт по одному правилу ничего не говорит о другом. Общая строка про
 * затенение псевдонима, выставленная по находке о `ПЕРВЫЕ N`, — ровно тот отчёт о
 * непроведённой проверке, против которого написан весь формат следа.
 */
const EVIDENCE_SCOPES = [
  { scope: 'query-alias-shadowing', id: 'qg:QRY-ALIAS-SHADOWS-FIELD' },
  { scope: 'query-alias-vs-nested-table', id: 'qg:QRY-ALIAS-SHADOWS-NESTED-TABLE' },
  { scope: 'query-top-order', id: 'qg:QRY-TOP-WITHOUT-ORDER' },
  { scope: 'query-alias-reserved-word', id: 'qg:QRY-ALIAS-RESERVED-WORD' },
];

function evidenceBlock(findings, queriesSeen, files = []) {
  return EVIDENCE_SCOPES.map(({ scope, id }) => {
    // Отмечается ЛЮБОЙ исход. Причина пропуска — `no_queries_found`, а не `not_applicable`:
    // инструмент читает и .bsl, и XML-носители, поэтому «не применимо» больше не бывает —
    // бывает «смотрел и запросов не нашёл». Это разные утверждения: первое снимало бы с
    // инструмента файлы, которые он обязан был прочитать.
    const hit = queriesSeen && findings.some((f) => f.rule === id);
    recordRun({
      scope,
      tool: 'tools/query-lint.mjs',
      verdict: !queriesSeen ? 'no_queries_found' : hit ? 'violation' : 'clean',
      files,
    });
    if (!queriesSeen) return `[qg skipped: layer=code, scope=${scope}, reason=no_queries_found]`;
    return `[qg applied: layer=code, scope=${scope}, ids=[${id}], verdict=${hit ? `violation:${id}` : 'clean'}]`;
  }).join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));

  if (files.length === 0) {
    process.stderr.write('Использование: node query-lint.mjs <файл.bsl|файл.xml> [<файл> ...] [--json]\n');
    return 2;
  }

  const report = files.map((f) => ({ file: f, ...checkFile(f) }));
  const errors = report.reduce((n, r) => n + r.findings.filter((x) => x.severity === 'error').length, 0);
  const warns = report.reduce((n, r) => n + r.findings.filter((x) => x.severity === 'warn').length, 0);
  const queriesSeen = report.some((r) => r.queries > 0);
  const evidence = evidenceBlock(report.flatMap((r) => r.findings), queriesSeen, files);

  if (asJson) {
    process.stdout.write(JSON.stringify({ files: report, errors, warns, evidence }, null, 2) + '\n');
    return errors ? 2 : warns ? 1 : 0;
  }

  for (const r of report) {
    if (r.findings.length === 0) continue;
    process.stdout.write(`${r.file}\n`);
    for (const f of r.findings) {
      // У находки в XML-носителе номер строки — внутри текста запроса (как в сообщениях
      // платформы); строка файла, с которой запрос начинается, печатается рядом.
      const where = f.line
        ? f.queryStartLine
          ? `:${f.line} (строка в тексте запроса; запрос начинается со строки ${f.queryStartLine} файла)`
          : `:${f.line}`
        : '';
      process.stdout.write(`  ${f.severity === 'error' ? 'ОШИБКА' : 'ВНИМАНИЕ'}${where} [${f.rule}] ${f.message}\n`);
    }
    process.stdout.write('\n');
  }
  process.stdout.write(`Проверено файлов: ${files.length}. Ошибок: ${errors}, предупреждений: ${warns}.${versionSuffix()}\n`);
  process.stdout.write('\n## quality evidence\n\n' + evidence + '\n');

  // Проверка лексическая и заведомо неполная: запросы, собранные конкатенацией, и XML-носители
  // за пределами известных (<query>, <QueryText>) она не видит. Молчание не означает, что
  // запрос исполним.
  if (!errors && !warns && queriesSeen) {
    process.stdout.write(
      '\nПроверены литералы в .bsl и тексты запросов в XML-носителях (СКД, динамические списки). ' +
        'Выполнимость запроса не проверяется — это делает платформа.\n'
    );
  }

  return errors ? 2 : warns ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('query-lint.mjs')) {
  process.exit(main(process.argv));
}
