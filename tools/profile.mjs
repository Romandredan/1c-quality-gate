#!/usr/bin/env node
/**
 * Профиль изменения — три оси (объём, архетипы, сложность) и их разрешение в глубину
 * контуров, одним детерминированным вызовом.
 *
 * Зачем отдельный инструмент. Раньше три оси вычислялись моделью в голове по таблицам
 * `quality-gate/SKILL.md`: копия правил в промпте расходится с копией в документации при
 * первой же правке одной из них, а «C1, потому что показалось» неотличимо от «C1, потому
 * что посчитано». Здесь правила ровно одни — эта таблица и функция разрешения, — и их
 * читает и `gate.mjs plan` (печатает план прогона), и `evidence-validator.mjs` (сверяет
 * заявленный в отчёте профиль со посчитанным).
 *
 * Источник данных о правке — не рабочее дерево «как получится», а git: `git diff --numstat
 * HEAD` даёт число изменённых строк, `git diff -U0 HEAD` — сами добавленные строки (по ним, и
 * ещё по телам задетых методов — см. ниже, ищутся маркеры архетипов) и заголовки hunk'ов
 * (`@@ -a,b +c,d @@`), из которых читаются НОМЕРА строк рабочего дерева, которых правка
 * коснулась (`changedLines`). Их сравнение с границами `Процедура|Функция…КонецПроцедуры|
 * КонецФункции` текущей версии и версии в HEAD (`methodRanges`, `analyzeChangedMethods`) даёт
 * ось 1 не только по числу строк, но и по методам: сколько их задето, появился ли новый,
 * не поменялась ли сигнатура существующего. Файл без истории в HEAD (только что созданный,
 * ещё не закоммиченный) — все его строки добавленные, метод-ориентированные правила на него
 * не распространяются (сравнивать не с чем); то же самое приближение действует, если git
 * недоступен вовсе или файл лежит вне корня проекта — тогда взять для сравнения нечего, и это
 * явно помечается (`note: 'no_git'`), а не выдаётся за точный подсчёт.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import { DEFAULTS, resolve as resolveConfigState, evidenceValue } from './config.mjs';
import { maskModule } from './bsl-lint.mjs';
import { headVersion } from './rename-check.mjs';

/**
 * Таблица архетипов кода — перенесена из таблицы «Ось 2» `quality-gate/SKILL.md` (столбцы
 * «Маркер в изменениях», «Мин. code», «Мин. arch») и колонки `refs` из `bsl-code-review/SKILL.md`
 * («Стандарты под архетип»). Единственный источник истины: `evidence-validator.mjs` проверяет
 * метки поля `archetypes` записи `scope` по своему списку `ARCHETYPES`, и тест в
 * `tests/run-tests.mjs` держит два списка равными — расхождение молча отключало бы
 * требование, привязанное к архетипу.
 *
 * `checklist` — разделы `checklist-code.md`, которые обязаны быть в чеклисте контура code
 * при сработавшем архетипе (нужно `gate.mjs plan`, Task 12); есть не у всех архетипов.
 * Общие для любого кода разделы здесь не повторяются — они в `BASE_CHECKLIST`.
 *
 * `minArch` архетипа `form-module` — единственный условный: уровень 1 требуется только при
 * `loc > 400` изменённых строк (см. `resolveMinArch`), а не всегда, как у прочих архетипов.
 * Представлено структурой `{ metric: 'loc', threshold: 400, level: 1 }`, а не текстом-«магией»
 * и не встроенным в `resolveMinArch` числом: порог читается из данных архетипа, а не
 * сравнивается со строкой-меткой условия — второе значило бы держать «400» в двух местах
 * (здесь и в самой функции), и они бы разъехались на первой же правке одного без другого.
 *
 * `\b` в JS-регулярных выражениях считает словом только `[A-Za-z0-9_]` — кириллица в это
 * определение не входит, и переход «кириллическая буква → небуквенный символ» границей НЕ
 * является: `/\bАсинх\b/i` не находит «Асинх» вообще нигде (проверено прогоном: маркеры
 * `object-event`, `client-server`, `async-client` из брифа с `\b` не срабатывали ни на одном
 * реальном BSL-фрагменте теста). Граница здесь — `(?<![WORD])`/`(?![WORD])` с явным классом
 * `WORD`, который включает кириллицу, — тот же приём, что уже используется в
 * `rename-check.mjs` (`bareCalls`, константа `W`).
 *
 * Маркеры ищутся не только в добавленных строках диффа, но и в ПОЛНЫХ ТЕЛАХ изменённых
 * методов (working tree, см. `analyzeChangedMethods`). «Изменённый код» — это тело метода,
 * который правка задела, а не только те его строки, что попали в `+` диффа: живой пример из
 * задачи — правка модуля HTTP-транспорта тронула не ту строку, где стоит `Новый
 * HTTPСоединение`, и по одним добавленным строкам архетип `integration` не находился, хотя
 * весь метод — работа с HTTP-соединением. Без этого расширения ось 2 систематически
 * недооценивала бы правки внутри уже архетипичных методов.
 */
const WORD = 'A-Za-zА-Яа-яЁё0-9_';
export const ARCHETYPES = [
  { label: 'query', markers: [/Новый\s+Запрос/i, /ВЫБРАТЬ\s/i], minCode: 'L2', minArch: null, refs: ['bsl-query-optimization.md', 'bsl-query-reference.md'], checklist: [6, 7] },
  { label: 'transaction', markers: [/НачатьТранзакцию/i, /Заблокировать\s*\(/i, /БлокировкаДанных/i], minCode: 'L2', minArch: null, refs: ['bsl-coding-standards.md'], checklist: [8] },
  { label: 'record-set', markers: [/Записать\s*\(\s*Истина\s*\)/i, /СоздатьНаборЗаписей/i], minCode: 'L2', minArch: null, refs: [] },
  { label: 'object-event', markers: [new RegExp(`Процедура\\s+(ПередЗаписью|ПриЗаписи|ОбработкаПроведения|ОбработкаУдаленияПроведения|ПередУдалением)(?![${WORD}])`, 'i')], minCode: 'L2', minArch: 1, refs: [], checklist: [9] },
  { label: 'integration', markers: [/HTTPСоединение/i, /WSПрокси/i, /Новый\s+COMОбъект/i], minCode: 'L2', minArch: 1, refs: [], checklist: [15] },
  { label: 'rights', markers: [/УстановитьПривилегированныйРежим/i], pathMarker: /\/Roles\/[^/]+\/Ext\/Rights\.xml$/i, minCode: 'L2', minArch: 2, refs: [], checklist: [13, 14] },
  { label: 'cfe-patch', markers: [/&(Перед|После|Вместо|ИзменениеИКонтроль)\s*\(/i], minCode: 'L2', minArch: 1, refs: [] },
  { label: 'scheduled-job', markers: [/ФоновыеЗадания\./i, /РегламентныеЗадания\./i], pathMarker: /\/ScheduledJobs\//i, minCode: 'L2', minArch: null, refs: [], checklist: [12] },
  { label: 'client-server', markers: [new RegExp(`&НаСервере(БезКонтекста)?(?![${WORD}])`, 'i'), new RegExp(`&НаКлиенте(НаСервере)?(?![${WORD}])`, 'i')], minCode: 'L1', minArch: 1, refs: [], checklist: [10] },
  { label: 'user-dialog', markers: [/ПоказатьВопрос/i, /ВопросАсинх/i, /ОповещениеОЗавершении/i], minCode: 'L1', minArch: 1, refs: [] },
  { label: 'form-module', markers: [], pathMarker: /\/Forms?\/[^/]+\/(Ext\/Form\/)?Module\.bsl$/i, minCode: 'L1', minArch: { metric: 'loc', threshold: 400, level: 1 }, refs: ['bsl-form-module-rules.md'], checklist: [10] },
  { label: 'async-client', markers: [new RegExp(`(?<![${WORD}])Асинх(?![${WORD}])`, 'i'), new RegExp(`(?<![${WORD}])Ждать(?![${WORD}])`, 'i'), /Обещание/i], minCode: 'L1', minArch: null, refs: ['bsl-async.md'] },
  {
    label: 'new-common-module',
    markers: [],
    newFile: /\/CommonModules\/[^/]+\/Ext\/Module\.bsl$/i,
    // Голого нового Module.bsl недостаточно: тот же путь получает и правка расширения,
    // перехватывающего существующий базовый общий модуль впервые (Module.bsl расширения
    // тоже «без истории» в HEAD). Настоящий НОВЫЙ модуль приносит с собой декларацию объекта
    // — CommonModules/<Имя>.xml (или .mdo) — в том же составе правки; без неё это не
    // регистрация нового объекта метаданных, а такое же локальное изменение, как любое
    // другое, и не обязано тащить за собой C3/уровень arch 2.
    declarationFrom: (rel) => rel.replace(/\/Ext\/Module\.bsl$/i, ''),
    minCode: 'L1',
    minArch: 2,
    refs: ['bsl-coding-standards.md', 'bsp-common-modules.md'],
  },
  {
    label: 'new-metadata-object',
    markers: [],
    // `(^|\/)src\/` — не `\/src\/`: пути от корня проекта («src/cf/...», «src/cfe/...») не
    // получают ведущего слэша перед `src`, а буквальный `\/src\/` требовал бы, чтобы `src` был
    // вложен глубже (`.../src/...`), и на раскладке этого же плагина не срабатывал бы никогда.
    newFile: /(^|\/)src\/.*\.(xml|mdo)$/i,
    // Декларация общего модуля (`CommonModules/<Имя>.xml`) — та же корневая ксмл-декларация
    // объекта под `src/`, но у неё уже есть собственный, более лёгкий архетип
    // (`new-common-module`, `minArch: 2`) — без исключения оба сработали бы одновременно, и
    // более строгий минимум `new-metadata-object` (3) всегда перебивал бы более точный (2).
    newFileExclude: /\/CommonModules\/[^/]+\.xml$/i,
    minCode: 'L1',
    minArch: 3,
    refs: [],
  },
];

/**
 * Разделы `checklist-code.md`, которые читаются при любой правке кода — независимо от архетипа.
 *
 * Зачем. Пока разделы называл только архетип, у восьми из семнадцати хозяина не было: структура
 * модуля, именование, параметры, конструкции языка, исключения, коллекции, локализация, БСП.
 * План их не печатал, а навык велит читать только напечатанное — разделы стали недостижимы.
 * A/B-прогон на новом внешнем отчёте это показал: версия 3.5.0, выбиравшая разделы сама, дошла
 * до раздела 16 и нашла пользовательские тексты литералами в тексте запроса; ветка, читавшая
 * по плану, — нет, хотя пункт в чеклисте тот же побайтно.
 *
 * Эти разделы общие для любого кода, привязать их к архетипу нечем. Тест держит инвариант:
 * каждый раздел чеклиста либо здесь, либо в `checklist` какого-то архетипа.
 */
export const BASE_CHECKLIST = [1, 2, 3, 4, 5, 11, 16, 17];

const CODE_RANK = { skip: 0, L1: 1, L2: 2 };

function codeMax(...values) {
  let best = 'skip';
  for (const v of values) {
    if (v && CODE_RANK[v] > CODE_RANK[best]) best = v;
  }
  return best;
}

/**
 * Уровень `arch` архетипа. Большинство хранят готовое число (или `null`, если архетип на
 * `arch` не влияет); `form-module` хранит условие — `{ metric, threshold, level }` — и порог
 * читается из этих полей, а не сравнивается со строкой-меткой: значение «400» живёт ровно в
 * одном месте (в самих данных архетипа), а не дублируется здесь текстом.
 */
function resolveMinArch(archetype, loc) {
  const m = archetype.minArch;
  if (m === null || m === undefined) return null;
  if (typeof m === 'object') {
    if (m.metric === 'loc') return loc > m.threshold ? m.level : null;
    return null; // неизвестная форма условия — консервативно не поднимаем arch
  }
  return Number(m);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Максимум непустых значений, `null` вместо `-Infinity` при пустом входе. */
function maxOrNull(values) {
  const present = values.filter((v) => v !== null && v !== undefined);
  return present.length ? Math.max(...present) : null;
}

/** Номер строки (1-based) символа с позицией `pos` в `source`. */
function lineAt(source, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

/**
 * Заголовок метода — `Процедура|Функция <Имя>(` — и его конец `КонецПроцедуры|КонецФункции`.
 *
 * Отдельная от `parseRoutines` (`bsl-lint.mjs`) регулярка: там модуль пишется только
 * по-русски (правило проекта — идентификаторы и код в оригинале, а прикладной код 1С в этом
 * плагине всегда русскоязычный), а здесь нужна ЕЩЁ и английская форма ключевых слов
 * (`Procedure`/`Function`/`EndProcedure`/`EndFunction`) — платформа принимает оба варианта
 * синтаксиса модуля, и сравниваемая правка живого кода может быть написана на любом.
 */
const METHOD_HEADER = new RegExp(
  `(?<![${WORD}])(Процедура|Функция|Procedure|Function)\\s+([A-Za-zА-Яа-яЁё_][${WORD}]*)\\s*\\(`,
  'giu'
);
const METHOD_END = {
  procedure: new RegExp(`(?<![${WORD}])(КонецПроцедуры|EndProcedure)(?![${WORD}])`, 'gi'),
  function: new RegExp(`(?<![${WORD}])(КонецФункции|EndFunction)(?![${WORD}])`, 'gi'),
};
const EXPORT_RE = new RegExp(`(?<![${WORD}])Экспорт(?![${WORD}])`, 'i');

/**
 * Границы методов модуля: имя, диапазон строк (1-based, включительно), сигнатура (исходный,
 * немаскированный текст заголовка — от ключевого слова до конца строки с закрывающей скобкой
 * параметров) и экспортность.
 *
 * Источник для оси 1 (`analyzeChangedMethods`, ниже): сравнение границ и сигнатур ЭТОЙ же
 * функции для рабочего дерева и для версии в HEAD решает, появился ли новый метод и
 * поменялась ли сигнатура существующего — без этого правка «один новый метод плюс правки в
 * двух существующих» неотличима от точечной подгонки текста внутри одного метода (Task,
 * дефект A/B-прогона).
 *
 * Разбалансированный `КонецПроцедуры`/`КонецФункции` (меньше закрытий, чем открытий, —
 * например, синтаксическая ошибка в правке или временно закомментированный конец метода вне
 * `maskModule`) растягивает границу метода до конца файла: `endMatch` не находится, `end =
 * masked.length`. Метод в этом случае выглядит крупнее и «задетее», чем есть на самом деле, —
 * направление ошибки безопасное (переоценка глубины разбора, не пропуск), но объём и маркеры
 * архетипов могут завыситься сильнее, чем того требует реальная правка.
 */
export function methodRanges(source) {
  const masked = maskModule(source);
  const routines = [];
  METHOD_HEADER.lastIndex = 0;
  let m;
  while ((m = METHOD_HEADER.exec(masked)) !== null) {
    const kind = m[1].toLowerCase();
    const isFunction = kind === 'функция' || kind === 'function';
    const endRe = isFunction ? METHOD_END.function : METHOD_END.procedure;

    // Граница списка параметров — согласованная скобка, а не первая попавшаяся: значение
    // параметра по умолчанию само может содержать скобки (`Знач П = Новый Массив(3)`).
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < masked.length && depth > 0) {
      if (masked[i] === '(') depth++;
      else if (masked[i] === ')') depth--;
      i++;
    }
    let lineEnd = masked.indexOf('\n', i);
    if (lineEnd === -1) lineEnd = masked.length;

    endRe.lastIndex = i;
    const endMatch = endRe.exec(masked);
    const end = endMatch ? endMatch.index : masked.length;

    routines.push({
      name: m[2],
      start: lineAt(source, m.index),
      end: lineAt(source, end),
      signature: source.slice(m.index, lineEnd).replace(/\s+/g, ' ').trim(),
      isExport: EXPORT_RE.test(masked.slice(m.index, lineEnd)),
    });
  }
  return routines;
}

/**
 * Минимум `minCode` записи `extends`, поднятый над встроенным. Понижение — ошибка настройки:
 * молча применённое пониженное требование неотличимо от верного, а платформенные обёртки
 * («выполнить HTTP-запрос через свой общий модуль») — тот самый случай, где минимум встроенного
 * архетипа сознательно поднимают, а не снижают (см. брифинг задачи).
 */
function raiseMinCode(base, given, label) {
  if (given === undefined || given === null || given === '') return base;
  if (given !== 'L1' && given !== 'L2') {
    throw new Error(`archetypes.custom: extends="${label}" — minCode="${given}" не L1 и не L2`);
  }
  if (CODE_RANK[given] < CODE_RANK[base]) {
    throw new Error(
      `archetypes.custom: extends="${label}" задаёт minCode="${given}", а встроенный минимум архетипа — "${base}"; ` +
        'extends повышает минимум, но не понижает'
    );
  }
  return given;
}

/** То же для `minArch` — с той оговоркой, что у части архетипов (`form-module`) минимум условный. */
function raiseMinArch(base, given, label) {
  if (given === undefined || given === null || given === '') return base;
  if (base !== null && typeof base === 'object') {
    throw new Error(
      `archetypes.custom: extends="${label}" задаёт minArch, но встроенный минимум этого архетипа условный ` +
        '(зависит от объёма правки) — extends не может его поднять'
    );
  }
  const g = Number(given);
  if (!Number.isInteger(g) || g < 1 || g > 3) {
    throw new Error(`archetypes.custom: extends="${label}" — minArch="${given}" не целое число 1..3`);
  }
  if (base !== null && g < base) {
    throw new Error(
      `archetypes.custom: extends="${label}" задаёт minArch=${g}, а встроенный минимум архетипа — ${base}; ` +
        'extends повышает минимум, но не понижает'
    );
  }
  return g;
}

/**
 * Каталог архетипов проекта: встроенная таблица `ARCHETYPES`, с записями `archetypes.custom`
 * применёнными поверх.
 *
 * Запись бывает двух видов, и ровно одного поля из двух — `name` ЛИБО `extends`:
 *   - `name` — прежнее поведение: самостоятельный проектный архетип со своей меткой, метка
 *     идёт в `archetypes` записи следа как есть;
 *   - `extends` — расширение встроенного архетипа (мотивация — обёртки платформенных вызовов
 *     вроде общего модуля HTTP-клиента, за именем которого спрятан `HTTPСоединение`: сама
 *     обёртка проектная и в публичный пакет не попадает, а архетип `integration`, который она
 *     должна поднимать, — общий, см. брифинг задачи). Метка НЕ заводится новая: находка идёт
 *     под встроенной меткой, и всё, что к ней привязано (справочники, разделы чеклиста,
 *     минимумы), действует без изменений. `markers` записи ДОБАВЛЯЮТСЯ к маркерам встроенного
 *     архетипа; `minCode`/`minArch` могут ТОЛЬКО поднять минимум.
 *
 * Запись, нарушающая форму (оба поля, ни одного поля, extends на неизвестную метку, попытка
 * понизить минимум), отклоняется целиком — `throw`, а не молчаливый пропуск: неверная запись,
 * применённая частично, выглядит как рабочее расширение и в этом хуже отсутствующей.
 */
function buildArchetypeCatalog(config) {
  const list = config?.archetypes?.custom;
  if (!Array.isArray(list) || list.length === 0) return ARCHETYPES;

  const byLabel = new Map(ARCHETYPES.map((a) => [a.label, { ...a }]));
  const extra = [];

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const hasName = typeof entry.name === 'string' && entry.name.trim() !== '';
    const hasExtends = typeof entry.extends === 'string' && entry.extends.trim() !== '';

    if (hasName && hasExtends) {
      throw new Error(
        `archetypes.custom: запись задаёт одновременно "name" ("${entry.name}") и "extends" ` +
          `("${entry.extends}") — нужно одно из двух: новая метка (name) либо расширение встроенной (extends)`
      );
    }
    if (!hasName && !hasExtends) {
      throw new Error(
        'archetypes.custom: запись без "name" и без "extends" — непонятно, заводит она новую метку ' +
          'или расширяет встроенную'
      );
    }

    if (hasExtends) {
      const label = entry.extends.trim();
      const base = byLabel.get(label);
      if (!base) {
        throw new Error(
          `archetypes.custom: extends="${label}" — нет такого встроенного архетипа. Известные метки: ` +
            `${ARCHETYPES.map((a) => a.label).join(', ')}`
        );
      }
      const addedMarkers = Array.isArray(entry.markers)
        ? entry.markers.map((m) => new RegExp(escapeRegExp(m), 'i'))
        : [];
      base.markers = [...base.markers, ...addedMarkers];
      base.minCode = raiseMinCode(base.minCode, entry.minCode, label);
      base.minArch = raiseMinArch(base.minArch, entry.minArch, label);
      continue;
    }

    extra.push({
      label: String(entry.name),
      markers: Array.isArray(entry.markers) ? entry.markers.map((m) => new RegExp(escapeRegExp(m), 'i')) : [],
      minCode: entry.minCode === 'L2' ? 'L2' : 'L1',
      minArch: entry.minArch === undefined || entry.minArch === null || entry.minArch === '' ? null : Number(entry.minArch),
      refs: [],
    });
  }

  return [...byLabel.values(), ...extra];
}

function normalize(p) {
  return String(p).split(sep).join('/');
}

/** Есть ли рабочее дерево git, из которого стоит вообще пробовать читать историю. */
function gitAvailable(root) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  return !r.error && r.status === 0;
}

/** Текущее содержимое файла построчно, без BOM и без одного завершающего перевода строки. */
function currentLines(absPath) {
  if (!existsSync(absPath)) return [];
  let text = readFileSync(absPath, 'utf8').replace(/^﻿/, '');
  text = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return text === '' ? [] : text.split('\n');
}

/** Все номера строк 1..n — файл без истории в HEAD «весь добавлен», от первой до последней. */
function allLineNumbers(count) {
  const set = new Set();
  for (let n = 1; n <= count; n++) set.add(n);
  return set;
}

/**
 * Изменения одного файла: добавленные/удалённые строки, сами добавленные и удалённые строки
 * (для поиска маркеров и для честного `cosmeticOnly`, см. ниже) и `changedLines` — номера
 * строк РАБОЧЕГО ДЕРЕВА (не диффа), которые правка затронула; читаются из заголовков hunk'ов
 * `git diff -U0` (`@@ -a,b +c,d @@`, сторона `+c,d`). Нужны `analyzeChangedMethods`, чтобы
 * понять, какие МЕТОДЫ правка задела, а не только сколько строк добавлено суммарно.
 *
 * Hunk чистого удаления (`+c,0` — 0 строк на стороне рабочего дерева) не даёт диапазона:
 * `c` в этом случае — номер строки рабочего дерева ПЕРЕД точкой, откуда убрали текст, а не
 * начало какого-то диапазона. Правка реально касается стыка: строк `c` (последняя перед
 * удалением) и `c+1` (первая после) рабочего дерева — засчитываются обе, а метод(ы), в
 * границы которого(ых) они попадают, считаются задетыми (`analyzeChangedMethods`). Если `c` и
 * `c+1` попадают в разные методы (удаление ровно на стыке двух методов), задетыми считаются
 * оба — удаление там реально касается обоих.
 *
 * `isNew` — файла не было в HEAD (значит все его строки добавленные, `changedLines` —
 * 1..N целиком); `note: 'no_git'` — сравнивать было не с чем: git недоступен либо файл вне
 * корня проекта.
 */
function diffFile(file, root, gitOk) {
  const abs = resolvePath(root, file);
  const rel = normalize(relative(resolvePath(root), abs));

  if (!gitOk || !rel || rel.startsWith('..')) {
    const lines = currentLines(abs);
    return {
      rel: rel || normalize(file),
      added: lines.length,
      removed: 0,
      addedLines: lines,
      removedLines: [],
      isNew: true,
      note: 'no_git',
      changedLines: allLineNumbers(lines.length),
    };
  }

  const head = spawnSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const hasHistory = !head.error && head.status === 0;
  if (!hasHistory) {
    const lines = currentLines(abs);
    return { rel, added: lines.length, removed: 0, addedLines: lines, removedLines: [], isNew: true, changedLines: allLineNumbers(lines.length) };
  }

  let added = 0;
  let removed = 0;
  const num = spawnSync('git', ['diff', '--numstat', 'HEAD', '--', rel], { cwd: root, encoding: 'utf8' });
  if (!num.error && num.status === 0) {
    const firstLine = String(num.stdout || '').trim().split('\n')[0] || '';
    const m = firstLine.match(/^(\d+|-)\s+(\d+|-)\s+/);
    if (m) {
      added = m[1] === '-' ? 0 : Number(m[1]);
      removed = m[2] === '-' ? 0 : Number(m[2]);
    }
  }

  const addedLines = [];
  const removedLines = [];
  const changedLines = new Set();
  const u = spawnSync('git', ['diff', '-U0', 'HEAD', '--', rel], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (!u.error && u.status === 0) {
    for (const line of String(u.stdout || '').split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) addedLines.push(line.slice(1));
      else if (line.startsWith('-')) removedLines.push(line.slice(1));
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (hunk) {
        const startLine = Number(hunk[1]);
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        if (count === 0) {
          // Чистое удаление: `startLine` — строка рабочего дерева ПЕРЕД точкой удаления, не
          // начало диапазона. Засчитываем стык — саму эту строку и следующую за ней (см.
          // комментарий над `diffFile`).
          if (startLine >= 1) changedLines.add(startLine);
          changedLines.add(startLine + 1);
        } else {
          for (let n = startLine; n < startLine + count; n++) changedLines.add(n);
        }
      }
    }
  }
  return { rel, added, removed, addedLines, removedLines, isNew: false, changedLines };
}

/**
 * Методы, которых КОНКРЕТНО коснулась правка существующего файла, — сравнение текущих границ
 * методов с версией в HEAD (`headVersion` из `rename-check.mjs`, та же функция, что уже
 * использует проверка голых вызовов). Файл без истории в HEAD (`d.isNew`) сюда не попадает —
 * сравнивать методы не с чем, а «новый модуль/объект целиком» уже отдельно решают архетипы
 * `new-common-module`/`new-metadata-object` и порог по размеру: без этого исключения
 * однострочный новый общий модуль без декларации объекта не остался бы в C1, хотя он им
 * является (см. тест «новый Module.bsl без декларации объекта: … объём по размеру»).
 *
 * Возвращает:
 *   - `touchedCount` — сколько методов (суммарно по всем файлам) правка задела хотя бы одной
 *     строкой;
 *   - `touchedBodies` — тексты этих методов целиком (для маркеров архетипов, ось 2);
 *   - `newMethods` — имена методов, которых не было в HEAD под тем же именем (новый метод,
 *     экспортный или нет — переименование сюда тоже попадает: старое имя пропало, значит для
 *     инструмента это новый метод, и это осознанно, см. брифинг задачи);
 *   - `signatureChanges` — имена существующих методов, у которых изменилась строка сигнатуры
 *     (список параметров, `Знач`, `Экспорт`).
 *
 * Метод, который правка ТОЛЬКО укоротила (ни одной строки не добавлено внутри него, только
 * удаления), больше не выпадает из подсчёта: `diffFile` засчитывает строки стыка на месте
 * hunk'а чистого удаления (см. комментарий над `diffFile`), и `isTouched` ниже видит их так
 * же, как обычный диапазон. Заявленное приближение осталось только одно, симметричное:
 * метод, которого не стало в рабочем дереве (был в HEAD, в текущей версии отсутствует
 * полностью), правило (b) не ловит — оно однонаправленное, по методам ТЕКУЩЕГО дерева,
 * отсутствующим в HEAD, а не наоборот.
 *
 * Разбираются файлы `.bsl` и `.os` — тот же набор расширений, что `gate.mjs` считает кодовыми
 * (`/\.(bsl|os)$/i`, см. `cmdPlan`/`bslFiles`); ограничение только `.bsl` пропускало внешние
 * обработки и отчёты (`.os` — тот же синтаксис модуля) мимо метод-ориентированных правил оси 1
 * целиком, и правка двух методов внешней обработки молча оставалась в C1.
 */
function analyzeChangedMethods(diffs, root) {
  const touchedBodies = [];
  const newMethods = [];
  const signatureChanges = [];
  let touchedCount = 0;

  for (const d of diffs) {
    if (d.isNew || !/\.(bsl|os)$/i.test(d.rel)) continue;
    const abs = resolvePath(root, d.rel);
    if (!existsSync(abs)) continue; // рабочее дерево файл удалило — сравнивать методы негде

    let currentText;
    try {
      currentText = readFileSync(abs, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    } catch {
      continue;
    }
    const headRaw = headVersion(abs, root);
    if (headRaw === null) continue; // защитный дубль условия d.isNew выше

    const currentMethods = methodRanges(currentText);
    const headMethods = methodRanges(headRaw.replace(/\r\n/g, '\n'));
    const headByName = new Map(headMethods.map((mth) => [mth.name.toLowerCase(), mth]));
    const lines = currentText.split('\n');

    for (const method of currentMethods) {
      const isTouched = [...d.changedLines].some((n) => n >= method.start && n <= method.end);
      if (!isTouched) continue;
      touchedCount++;
      touchedBodies.push(lines.slice(method.start - 1, method.end).join('\n'));

      const head = headByName.get(method.name.toLowerCase());
      if (!head) {
        newMethods.push(method.name);
      } else if (head.signature !== method.signature) {
        signatureChanges.push(method.name);
      }
    }
  }

  return { touchedCount, touchedBodies, newMethods, signatureChanges };
}

/**
 * Сложность изменённых методов — из метрик `analyzer-run.mjs --json` (`metrics[file].functions`).
 * Инструмент их не запускает сам: подсчёт метрик — работа анализатора, а не этого модуля.
 * Форма `functions[i]` у самого анализатора не задокументирована жёстко, поэтому поля
 * читаются по нескольким правдоподобным именам и молча пропускаются, если ни одно не нашлось —
 * приближение объявлено, а не выдаётся за точный разбор (см. отчёт по задаче).
 */
function complexityFindings(files, metrics, cfg) {
  const labels = [];
  const seen = new Set();
  const add = (label) => {
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  };
  if (!metrics || typeof metrics !== 'object') return labels;

  for (const file of files) {
    const rec = metrics[file] || metrics[normalize(file)];
    const fns = rec && Array.isArray(rec.functions) ? rec.functions : [];
    for (const fn of fns) {
      const nesting = fn.nesting ?? fn.nestingDepth ?? fn.max_nesting ?? fn.maxNesting;
      const lines = fn.lines ?? fn.lineCount ?? fn.line_count;
      const params = Array.isArray(fn.parameters)
        ? fn.parameters.length
        : (fn.params ?? fn.paramCount ?? fn.param_count);
      if (Number.isFinite(nesting) && nesting >= cfg.maxNesting) add(`nesting:${nesting}`);
      if (Number.isFinite(lines) && lines > cfg.maxMethodLines) add(`method-lines:${lines}`);
      if (Number.isFinite(params) && params >= cfg.maxParams) add(`params:${params}`);
    }
  }
  return labels;
}

/**
 * Приближение на случай, когда штамп неоткуда взять по-настоящему: ни `configState`, ни
 * читаемый `root` не даны. Сравнивает переданные значения `config` с `DEFAULTS` ПО ЗНАЧЕНИЮ.
 *
 * Это НЕ то же самое, что `evidenceValue()` из `config.mjs` — та смотрит на ИСТОЧНИК каждого
 * значения (файл/окружение/умолчание), и файл, явно повторивший значение умолчания, всё
 * равно даёт `custom:<секция>` (переопределение — это факт «значение пришло из файла», а не
 * «значение отличается»). Значит на таком проекте это приближение соврёт: назовёт `default`
 * там, где `evidenceValue()` — и валидатор в `--gate` — назовут `custom:...`. Поэтому это
 * только последний резерв (см. `computeConfigStamp`), а не основной путь.
 */
function configStampByValue(config) {
  const changed = [];
  for (const section of Object.keys(DEFAULTS)) {
    const provided = config?.[section];
    if (provided === undefined) continue;
    if (JSON.stringify(provided) !== JSON.stringify(DEFAULTS[section])) changed.push(section);
  }
  return changed.length ? `custom:${changed.join('+')}` : 'default';
}

/**
 * `config=` записи `scope` — источник истины один: `evidenceValue()` из `config.mjs`, та же
 * функция, что печатает `node config.mjs show` и что сверяет `evidence-validator.mjs` в
 * `--gate`. Порядок:
 *
 * 1. `configState` — если вызывающий уже прочитал настройку через `resolve()`/`config.mjs`
 *    (у него есть `.sources`), используем её значение напрямую — это ТОЧНЫЙ путь.
 * 2. иначе — сами читаем настройку с диска по `root` (`resolveConfigState(root)`): это тот
 *    же файл, из которого вызывающий обычно и собирал переданный `config` (`readConfig(root)`),
 *    поэтому результат согласован без явной передачи состояния.
 * 3. `root` нечитаем (упало исключение) — последний резерв: сравнение по значению
 *    (`configStampByValue`), с объявленной неточностью в её же комментарии.
 *
 * Без этого расхождения `computeProfile` мог посчитать `config=default` там, где проект явно
 * (пусть и значением, равным умолчанию) переопределил секцию в `.1c-quality-gate.json` —
 * `evidence-validator.mjs` в `--gate` эту же сборку отклонил бы как «config расходится с
 * настройкой проекта», хотя её печатает тот же самый плагин.
 */
function computeConfigStamp({ config, root, configState }) {
  if (configState) return evidenceValue(configState);
  if (root) {
    try {
      return evidenceValue(resolveConfigState(root));
    } catch {
      /* root есть, но настройка не читается — падаем на приближение ниже */
    }
  }
  return configStampByValue(config);
}

/**
 * Считает профиль изменения по трём осям и разрешает его в глубину контуров `code`/`arch`
 * (плюс `xml`/`hygiene` — по матрице объёма из «Шага 2» `quality-gate/SKILL.md`).
 *
 * `files` — пути от корня проекта (`root`), как их печатает `gate.mjs status`. `config` —
 * разрешённые значения настройки (форма `readConfig()`: секции `volume`, `complexity`,
 * `archetypes.custom` используются для порогов и проектных архетипов; на штамп `config=` НЕ
 * влияет — см. `computeConfigStamp`). `configState` — необязательно; результат
 * `resolve()`/`config.mjs` (с `.sources`), если он уже есть у вызывающего — тогда штамп
 * берётся из него напрямую, без повторного чтения диска. `metrics` — `metrics` из
 * `analyzer-run.mjs --json` (`{}`, если анализатор не запускался — тогда сложность считается
 * пустой, а не приближается вручную).
 */
export function computeProfile({ files, root, config, metrics, configState }) {
  const cfg = {
    c1MaxFiles: config?.volume?.c1MaxFiles ?? DEFAULTS.volume.c1MaxFiles,
    c1MaxLines: config?.volume?.c1MaxLines ?? DEFAULTS.volume.c1MaxLines,
    maxNesting: config?.complexity?.maxNesting ?? DEFAULTS.complexity.maxNesting,
    maxMethodLines: config?.complexity?.maxMethodLines ?? DEFAULTS.complexity.maxMethodLines,
    maxParams: config?.complexity?.maxParams ?? DEFAULTS.complexity.maxParams,
  };

  const gitOk = gitAvailable(root);
  const diffs = files.map((f) => ({ file: f, ...diffFile(f, root, gitOk) }));

  const added = diffs.reduce((s, d) => s + d.added, 0);
  const removed = diffs.reduce((s, d) => s + d.removed, 0);
  const allAddedLines = diffs.flatMap((d) => d.addedLines);
  const allRemovedLines = diffs.flatMap((d) => d.removedLines || []);
  const addedText = allAddedLines.join('\n');
  const noGit = diffs.some((d) => d.note === 'no_git');

  // Методы, которых коснулась правка, — общий вход для оси 1 (новый метод / изменённая
  // сигнатура / >1 метода) и для оси 2 (маркеры архетипов ищутся и в телах этих методов, не
  // только в добавленных строках диффа).
  const methodAnalysis = analyzeChangedMethods(diffs, root);
  const changedBodiesText = methodAnalysis.touchedBodies.join('\n');

  // --- ось 2: архетипы --------------------------------------------------------
  const dirsPresent = new Set(diffs.map((d) => normalize(d.rel).toLowerCase()));
  const catalog = buildArchetypeCatalog(config);
  const fired = [];
  for (const a of catalog) {
    const byMarker =
      a.markers && a.markers.length > 0 && a.markers.some((re) => re.test(addedText) || re.test(changedBodiesText));
    const byPath = a.pathMarker ? diffs.some((d) => a.pathMarker.test(d.rel)) : false;
    const byNewFile = a.newFile
      ? diffs.some((d) => {
          if (!d.isNew || !a.newFile.test(d.rel)) return false;
          if (a.newFileExclude && a.newFileExclude.test(d.rel)) return false;
          if (!a.declarationFrom) return true;
          const base = a.declarationFrom(d.rel).toLowerCase();
          return dirsPresent.has(`${base}.xml`) || dirsPresent.has(`${base}.mdo`);
        })
      : false;
    if (byMarker || byPath || byNewFile) fired.push(a);
  }
  const archetypeLabels = fired.map((a) => a.label);

  // --- ось 3: сложность --------------------------------------------------------
  const complexity = complexityFindings(files, metrics, cfg);
  const complexityFired = complexity.length > 0;

  // --- ось 1: объём -------------------------------------------------------------
  // Косметика проверяется по ОБЕИМ сторонам диффа, не только по добавленным строкам: диф
  // чистого удаления (только `-` строки, ни одной `+`) на пустом `allAddedLines` раньше давал
  // `every() === true` вакуумно — правка, реально убравшая код из метода, засчитывалась как
  // «тела методов не менялись» и уходила в C0. Хотя бы одна сторона обязана быть непустой:
  // диффа без единой строки не бывает у файла из списка изменённых.
  const cosmeticLines = [...allAddedLines, ...allRemovedLines];
  const cosmeticOnly = cosmeticLines.length > 0 && cosmeticLines.every((l) => l.trim() === '' || l.trim().startsWith('//'));
  // Новый модуль или объект метаданных выводит правку из C1 БЕЗУСЛОВНО — так прямо
  // сказано в определении C1 (`quality-gate/references/profile-axes.md`, «Ось 1»): «нет
  // новых экспортов, изменённых сигнатур, новых модулей и объектов метаданных». Поэтому
  // проверка идёт раньше размера:
  // однострочный новый общий модуль — всё равно C3, а не C1 по числу строк.
  const newModuleOrMetadata = archetypeLabels.includes('new-metadata-object') || archetypeLabels.includes('new-common-module');

  // Порядок проверок ниже — приоритет ПРИЧИНЫ, которую называет `volumeReason`, когда
  // сработало сразу несколько условий: >1 метода важнее конкретного нового метода (он и есть
  // один из этих «>1»), новый метод важнее правки сигнатуры соседнего, а размер — последний
  // резерв, если ни один структурный признак не сработал. Сама принадлежность к C2 при этом
  // не зависит от порядка — это ИЛИ по всем условиям, определение C2 в `profile-axes.md`
  // («Ось 1») перечисляет их через «ИЛИ».
  let volume;
  let volumeReason = null;
  if (cosmeticOnly) {
    volume = 'C0';
  } else if (newModuleOrMetadata) {
    volume = 'C3';
  } else if (methodAnalysis.touchedCount > 1) {
    volume = 'C2';
    volumeReason = `methods:${methodAnalysis.touchedCount}`;
  } else if (methodAnalysis.newMethods.length > 0) {
    volume = 'C2';
    volumeReason = `new-method:${methodAnalysis.newMethods[0]}`;
  } else if (methodAnalysis.signatureChanges.length > 0) {
    volume = 'C2';
    volumeReason = `signature:${methodAnalysis.signatureChanges[0]}`;
  } else if (files.length > cfg.c1MaxFiles) {
    volume = 'C2';
    volumeReason = 'files';
  } else if (added + removed > cfg.c1MaxLines) {
    volume = 'C2';
    volumeReason = 'lines';
  } else {
    volume = 'C1';
  }

  const totalLoc = added + removed;

  // --- разрешение code/arch: max(объём, максимум минимумов архетипов, сложность) ----------
  const codeBase = volume === 'C0' ? 'skip' : volume === 'C1' ? 'L1' : 'L2';

  const codeFromArchetypes = codeMax(...fired.map((a) => a.minCode));
  const archFromArchetypes = fired
    .map((a) => resolveMinArch(a, totalLoc))
    .filter((v) => v !== null);

  const codeFromComplexity = complexityFired ? 'L2' : 'skip';
  const archFromComplexity = complexityFired ? 1 : null;

  const resolvedCode = codeMax(codeBase, codeFromArchetypes, codeFromComplexity);
  // У `arch`, как и у `code`, объём САМ ПО СЕБЕ даёт пол — так же прямо, как задокументировано
  // в «Шаг 2» (исходно `quality-gate/SKILL.md`, теперь `profile-axes.md`, матрица глубин по
  // объёму): C2 — «ур. 1–2», C3 — «ур. 3». Живой прогон, где `arch:skip` встречался при
  // `volume=C2` без сработавших архетипов (task-9-report.md, `evidence-format.md`), — это
  // модель, отступившая от документированной таблицы при заполнении evidence, а не образец
  // для инструмента: раунд 2 задачи `context-routing` вернул пол намеренно. Конфликта с
  // `minArch: 2` архетипа `new-common-module` (C3) нет — итог берёт максимум (`max(3, 2) = 3`),
  // а не заменяет: архетип со своим минимумом никогда не может ПОНИЗИТЬ то, что даёт объём.
  const archFloor = volume === 'C3' ? 3 : volume === 'C2' ? 1 : null;
  const archCandidates = [...archFromArchetypes, archFromComplexity, archFloor].filter((v) => v !== null);
  const resolvedArch = archCandidates.length ? Math.max(...archCandidates) : null;

  const hasXmlChange = files.some((f) => /\.xml$/i.test(f));
  const resolvedXml =
    volume === 'C0' ? 'skip' : !hasXmlChange ? 'n/a' : volume === 'C1' ? 'changed' : volume === 'C2' ? 'changed+registration' : 'full';
  const resolvedHygiene = 'full';

  // --- driver: что именно подняло ХОТЯ БЫ ОДНУ ось (code или arch) -----------
  //
  // Раньше проверялся только code: при volume>=C2 его пол уже L2, архетип с minCode:'L2'
  // (например, object-event) его не поднимает — и driver выходил 'volume', хотя контур
  // arch пошёл ИСКЛЮЧИТЕЛЬНО из-за архетипа (без него arch был бы skip). Теперь «поднял»
  // проверяется отдельно по каждой оси через контрфактическое сравнение — во что превратился
  // бы итог БЕЗ вклада сложности / БЕЗ вклада архетипов, — и совпадение по code или по arch
  // одинаково считается «подняло». Приоритет источника прежний: сложность, затем архетип,
  // затем объём; имя архетипа для driver выбирается по той оси, которую он реально поднял.
  // Контрфактика по `arch` обязана нести и `archFloor` — иначе пол по объёму (Task 17,
  // раунд 2) выглядел бы вкладом сложности или архетипа: без этого правка, где `arch` целиком
  // объясняется полом C2/C3, ошибочно называла бы driver архетипом или сложностью, которые
  // ничего не подняли сверх того, что уже дал объём.
  const codeWithoutComplexity = codeMax(codeBase, codeFromArchetypes);
  const archWithoutComplexity = maxOrNull([...archFromArchetypes, archFloor]);
  const complexityRaisedCode = CODE_RANK[resolvedCode] > CODE_RANK[codeWithoutComplexity];
  const complexityRaisedArch = (resolvedArch ?? -1) > (archWithoutComplexity ?? -1);

  const codeWithoutArchetypes = codeMax(codeBase, codeFromComplexity);
  const archWithoutArchetypes = maxOrNull([archFromComplexity, archFloor]);
  const archetypeRaisedCode = CODE_RANK[resolvedCode] > CODE_RANK[codeWithoutArchetypes];
  const archetypeRaisedArch = (resolvedArch ?? -1) > (archWithoutArchetypes ?? -1);

  let driver;
  if (complexityFired && (complexityRaisedCode || complexityRaisedArch)) {
    driver = `complexity:${complexity[0].split(':')[0]}`;
  } else if (fired.length > 0 && (archetypeRaisedCode || archetypeRaisedArch)) {
    // Сперва ищем архетип, объясняющий поднятую code (совпадает по minCode с итогом); не
    // нашли (значит подняли arch) — ищем по совпадению фактического minArch с итогом arch.
    const top =
      (archetypeRaisedCode && fired.find((a) => a.minCode === resolvedCode)) ||
      (archetypeRaisedArch && fired.find((a) => resolveMinArch(a, totalLoc) === resolvedArch)) ||
      fired[0];
    driver = `archetype:${top.label}`;
  } else {
    driver = 'volume';
  }

  const resolved = { code: resolvedCode, arch: resolvedArch, xml: resolvedXml, hygiene: resolvedHygiene };

  const archetypesText = archetypeLabels.length ? archetypeLabels.join(',') : 'none';
  const complexityText = complexity.length ? complexity.join(',') : 'none';
  const archText = resolvedArch === null ? 'skip' : String(resolvedArch);
  const scopeLine =
    `[qg scope: volume=${volume}, files=${files.length}, loc=+${added}/-${removed}, ` +
    `archetypes=[${archetypesText}], complexity=[${complexityText}], driver=${driver}, ` +
    `resolved=code:${resolvedCode}|arch:${archText}|xml:${resolvedXml}|hygiene:${resolvedHygiene}, ` +
    `config=${computeConfigStamp({ config, root, configState })}]`;

  const result = {
    volume,
    volumeReason,
    files: files.length,
    loc: { added, removed },
    archetypes: archetypeLabels,
    complexity,
    driver,
    resolved,
    scopeLine,
  };
  if (noGit) result.note = 'no_git';
  return result;
}
