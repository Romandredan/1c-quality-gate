/**
 * Словарь `scope` записей следа — закрытый список того, что вообще бывает проверено.
 *
 * Зачем понадобился. Одну и ту же проверку документация называла тремя именами:
 * `static-diagnostics` в навыке контура кода, `lsp-diagnostics` в описании формата, а
 * инструмент печатал `static-analysis`. Валидатор проверял `scope` только на kebab-case и
 * принимал все три. Это не опечатка в тексте, а документированное приглашение написать
 * строку следа, которую ни один инструмент плагина не печатает: модель добросовестно
 * копирует пример из навыка и получает запись, неотличимую от полученной прогоном.
 *
 * Поле `tool` — вторая причина списка. У проверки либо есть исполняемый инструмент, либо
 * её выполняет модель. Для первых строка следа обязана происходить из прогона, и это
 * теперь проверяется журналом (`run-journal.mjs`): заявить `verdict=clean` по чтению кода
 * там, где есть инструмент, больше нельзя. Для вторых (архитектурные признаки, разбор
 * стандартов) инструмента нет и требовать нечего — они и остаются на совести прогона.
 *
 * Список закрытый намеренно. Новое имя, которого здесь нет, — либо опечатка, либо проверка,
 * о которой не знает ни валидатор, ни `validate-package.mjs`; в обоих случаях запись
 * выглядит заполненной, а закрывает пустоту.
 */

/**
 * Чем оперирует инструмент — вторая вещь, без которой сверка покрытия даёт ложные отказы.
 *
 * `files` — инструменту передают файлы, и в журнале лежат их пути: покрытие сверяется с
 * составом правки. `tree` — инструменту передают КАТАЛОГ выгрузки (сверка «диск ↔ состав»,
 * дубли UUID): пути отдельных файлов там не при чём, и сверять покрытие нечем — проверяется
 * только сам факт прогона.
 *
 * `applies` — расширения файлов, к которым проверка вообще относится. Требовать от
 * `query-lint` покрытия XML-файлов значило бы выдавать находку за то, что инструмент не
 * обязан делать.
 *
 * `coverage` — чем становится непокрытый файл: `strict` — ошибкой, `advisory` —
 * предупреждением. Строгость уместна там, где инструмент применим к КАЖДОМУ файлу своего
 * расширения: гигиена читает байты любого файла, `query-lint` и `bsl-lint` — любой `.bsl`.
 * У проверки структуры это не так: в выгрузке есть XML без своего валидатора
 * (`Ext/Predefined.xml` и подобные служебные), и требовать покрытия для них значило бы
 * выдавать находку за отсутствующий инструмент. Умолчание — `strict`.
 */

/** @type {Record<string, { layer: string, tool: string|null, about: string, granularity?: string, applies?: string[] }>} */
export const SCOPES = {
  // --- контур code ---------------------------------------------------------
  'static-analysis': {
    layer: 'code',
    tool: 'tools/analyzer-run.mjs',
    about: 'диагностики статического анализатора (bsl-analyzer / BSL LS)',
    granularity: 'files',
    applies: ['.bsl', '.os']
  },
  // Отдельный скоуп, а не строка внутри `static-analysis`: источник другой (справка
  // платформы против индекса конфигурации), и вердикт по одному ничего не говорит о другом.
  // Замер на общем файле: анализатор молчит на несуществующем члене платформенного типа,
  // значении системного перечисления, конструкторе и свойстве — всё это компилируется и
  // падает при выполнении.
  'platform-api': {
    layer: 'code',
    tool: 'tools/platform-context-run.mjs',
    about: 'сверка кода с фактическим API платформы (сервер bsl-context)',
    granularity: 'files',
    applies: ['.bsl', '.os']
  },
  // `.xml` в applies — не оговорка: query-lint читает XML-носители запросов (`<query>`
  // схем компоновки, `<QueryText>` динамических списков), и изменённый XML обязан пройти
  // через него так же, как .bsl. XML без носителей инструмент честно журналирует как
  // просмотренный — покрытие от этого не страдает.
  'query-alias-shadowing': {
    layer: 'code',
    tool: 'tools/query-lint.mjs',
    about: 'псевдоним источника затеняет колонку временной таблицы',
    granularity: 'files',
    applies: ['.bsl', '.os', '.xml']
  },
  // Отдельный скоуп, а не строка внутри `query-alias-shadowing`: источник имён другой
  // (текст запроса против колонок пакета), и вердикт по одному ничего не говорит о другом.
  'query-alias-vs-nested-table': {
    layer: 'code',
    tool: 'tools/query-lint.mjs',
    about: 'псевдоним источника затеняет имя табличной части, чей владелец соединён в той же ветке',
    granularity: 'files',
    applies: ['.bsl', '.os', '.xml']
  },
  'query-top-order': {
    layer: 'code',
    tool: 'tools/query-lint.mjs',
    about: '«ПЕРВЫЕ N» без «УПОРЯДОЧИТЬ ПО»',
    granularity: 'files',
    applies: ['.bsl', '.os', '.xml']
  },
  'transaction-nesting': {
    layer: 'code',
    tool: 'tools/bsl-lint.mjs',
    about: 'своя транзакция внутри неявной транзакции обработчика',
    granularity: 'files',
    applies: ['.bsl', '.os']
  },
  'enum-string-assign': {
    layer: 'code',
    tool: 'tools/bsl-lint.mjs',
    about: 'присваивание примитива полю строго ссылочного типа (по XML объекта)',
    granularity: 'files',
    applies: ['.bsl', '.os']
  },
  'unbounded-string-column': {
    layer: 'code',
    tool: 'tools/bsl-lint.mjs',
    about: 'строковая колонка без квалификатора длины у таблицы, уходящей в параметр запроса',
    granularity: 'files',
    applies: ['.bsl', '.os']
  },
  // Инверсия проверки разрешения имён: сравнение с версией файла в HEAD вместо словаря
  // глобального контекста. Имя, которое модуль объявлял до правки, платформенным глобальным
  // быть не могло — отсюда отсутствие словаря и отсутствие ложных находок на нём.
  'stale-local-calls': {
    layer: 'code',
    tool: 'tools/rename-check.mjs',
    about: 'голый вызов метода, объявление которого исчезло из модуля в этой правке',
    granularity: 'files',
    applies: ['.bsl', '.os']
  },
  'query-in-loop': {
    layer: 'code',
    tool: null,
    about: 'запрос внутри цикла, N+1 (#std436)',
  },
  // Инструментальным стал не сразу: правило `qg:BSL-REF-DOT-ACCESS` покрывает ярус A
  // (имя базы оканчивается на «Ссылка»), остальное по-прежнему разбирает модель. Имя скоупа
  // при этом одно на обе половины намеренно. Заведи инструменту собственное имя — и
  // рукописная строка `attribute-access ... clean` продолжила бы проходить валидатор, а
  // именно она и была дырой: проверка без инструмента ничем не фальсифицировалась.
  'attribute-access': {
    layer: 'code',
    tool: 'tools/bsl-lint.mjs',
    about: 'обращение к реквизиту ссылки через точку (#std437); инструмент покрывает ярус A',
    granularity: 'files',
    applies: ['.bsl', '.os']
  },
  'api-verification': {
    layer: 'code',
    tool: null,
    about: 'сигнатуры платформы, существование и экспортность общих модулей',
  },
  'naming-std454': {
    layer: 'code',
    tool: null,
    about: 'именование по #std454',
  },
  'query-execution': {
    layer: 'code',
    tool: null,
    about: 'попытка выполнить запрос на живой платформе',
  },
  'adversarial-audit': {
    layer: 'code',
    tool: null,
    about: 'состязательный аудит слоя 3 (запускается только по согласию пользователя)',
  },

  // --- контур arch ---------------------------------------------------------
  'module-responsibility': {
    layer: 'arch',
    tool: null,
    about: 'границы ответственности модуля, модуль-комбайн',
  },
  'branching-dispatch': {
    layer: 'arch',
    tool: null,
    about: 'ветвление вместо диспетчеризации',
  },
  'call-graph-signs': {
    layer: 'arch',
    tool: null,
    about: 'признаки по графу вызовов (вызывающие, мёртвые экспорты)',
  },

  // --- контур xml ----------------------------------------------------------
  'structure-validation': {
    layer: 'xml',
    tool: 'tools/xml/meta-validate.py',
    about: 'структура файла метаданных: обязательные узлы, порядок, типы',
    granularity: 'files',
    applies: ['.xml'],
    coverage: 'advisory'
  },
  // Связность объявлений формы: имя обработчика и имя действия команды записаны в XML, а
  // процедура живёт в модуле. Отдельное имя от `structure-validation` не бухгалтерия: под тем
  // именем в реестре закреплён `meta-validate.py`, и сверка покрытия закрывалась бы прогоном
  // не того инструмента. Покрытие — advisory: валидатор относится к `Form.xml`, а не к любому
  // XML выгрузки.
  'form-binding': {
    layer: 'xml',
    tool: 'tools/xml/form-validate.py',
    about: 'обработчик события и действие команды разрешаются в модуле формы',
    granularity: 'files',
    applies: ['.xml'],
    coverage: 'advisory'
  },
  'registration-check': {
    layer: 'xml',
    tool: 'tools/xml/orphan-check.mjs',
    about: 'сверка «диск ↔ состав»: файл вне состава и состав без файла',
    granularity: 'tree'
  },
  'uuid-uniqueness': {
    layer: 'xml',
    tool: 'tools/xml/uuid-unique.mjs',
    about: 'дубли UUID объектов метаданных в пределах выгрузки',
    granularity: 'tree'
  },

  // --- контур hygiene ------------------------------------------------------
  'file-encoding': {
    layer: 'hygiene',
    tool: 'tools/hygiene-check.mjs',
    about: 'кодировка, BOM, переводы строк, недопустимые символы',
    granularity: 'files'
  },
};

/** Имена, у которых есть исполняемый инструмент: их нельзя заявить без прогона. */
export const TOOL_BACKED = Object.fromEntries(
  Object.entries(SCOPES)
    .filter(([, v]) => v.tool)
    .map(([k, v]) => [k, v.tool])
);

/**
 * Имена, встречавшиеся в документации до сведения словаря.
 *
 * Нужны не для совместимости, а для сообщения: «неизвестный scope» на `lsp-diagnostics`
 * оставляет читателя гадать, как правильно, а прежние отчёты ещё существуют.
 */
export const RENAMED = {
  'lsp-diagnostics': 'static-analysis',
  'static-diagnostics': 'static-analysis',
  branching: 'branching-dispatch',
  'api-signatures': 'api-verification',
  'common-modules': 'api-verification',
  'object-structure': 'structure-validation',
};

export function isKnownScope(scope) {
  return Object.prototype.hasOwnProperty.call(SCOPES, scope);
}

/**
 * Реестр признаков — закрытый список законных `qg:*` в поле `ids` записи `applied`.
 *
 * Зачем понадобился. Проверка идентификатора по форме (`qg:ЗАГЛАВНЫМИ-ЧЕРЕЗ-ДЕФИС`)
 * пропускала любое правдоподобное имя: в живой сессии больше половины `qg:*` в отчётах
 * не существовало в плагине — `qg:XML-VALID` вместо `qg:XML-STRUCT`, `qg:XML-UUID-UNIQUE`
 * вместо `qg:XML-UUID-DUP`, выдуманные `qg:XML-FIELDS-EXIST` и `qg:SKD-VALID`. Причина не
 * злая воля: машиночитаемого списка не было, признаки перечислялись прозой в трёх SKILL.md,
 * и потребитель образовывал имена по аналогии. Отчёт с вымышленными признаками выглядит
 * при этом строже настоящего.
 *
 * Набор дрейфует между версиями (qg:HYG-EOL появился в v2.0.0 — отчёты на v1.3.0 его
 * «знали» до рождения), поэтому единственный источник истины — этот файл, а полнота
 * стережётся тестами: признаки ARCH сверяются с `signs-map.json`, признаки AI — с
 * заголовками `ai-antipatterns.md`, инструментальные — со строками, которые печатают
 * сами инструменты.
 *
 * `tool` — тот же смысл, что в SCOPES: непустой означает «строку печатает инструмент,
 * заявлять её руками нельзя»; null — признак проверяет модель по чеклисту.
 */
const ARCH_SIGNS = Array.from({ length: 11 }, (_, i) => [`qg:ARCH-A${i + 1}`, { tool: null }]);
const AI_SIGNS = Array.from({ length: 16 }, (_, i) => [`qg:AI-${String(i + 1).padStart(2, '0')}`, { tool: null }]);

/** @type {Record<string, { tool: string|null }>} */
export const QG_IDS = {
  // --- гигиена: печатает tools/hygiene-check.mjs ---------------------------
  'qg:HYG-BOM': { tool: 'tools/hygiene-check.mjs' },
  'qg:HYG-ENCODING': { tool: 'tools/hygiene-check.mjs' },
  'qg:HYG-CTRL': { tool: 'tools/hygiene-check.mjs' },
  'qg:HYG-DASH': { tool: 'tools/hygiene-check.mjs' },
  'qg:HYG-EOL': { tool: 'tools/hygiene-check.mjs' },

  // --- xml: печатают валидаторы tools/xml/* --------------------------------
  'qg:XML-STRUCT': { tool: 'tools/xml/meta-validate.py' },
  'qg:XML-ORPHAN': { tool: 'tools/xml/orphan-check.mjs' },
  'qg:XML-UUID-DUP': { tool: 'tools/xml/uuid-unique.mjs' },
  'qg:XML-FORM-HANDLER-MISSING': { tool: 'tools/xml/form-validate.py' },
  'qg:XML-FORM-ACTION-MISSING': { tool: 'tools/xml/form-validate.py' },
  'qg:SKD-PARAM-VT-COLLISION': { tool: 'tools/xml/skd-validate.py' },
  'qg:SKD-GROUP-NONAGGREGATE-FIELD': { tool: 'tools/xml/skd-validate.py' },
  'qg:SKD-GROUP-EMPTY-SELECTION': { tool: 'tools/xml/skd-validate.py' },

  // --- код, инструментальные -----------------------------------------------
  'qg:QRY-ALIAS-SHADOWS-FIELD': { tool: 'tools/query-lint.mjs' },
  'qg:QRY-ALIAS-SHADOWS-NESTED-TABLE': { tool: 'tools/query-lint.mjs' },
  'qg:QRY-TOP-WITHOUT-ORDER': { tool: 'tools/query-lint.mjs' },
  'qg:BSL-TXN-IN-HANDLER': { tool: 'tools/bsl-lint.mjs' },
  'qg:BSL-ENUM-STRING-ASSIGN': { tool: 'tools/bsl-lint.mjs' },
  'qg:BSL-UNBOUNDED-STRING-COLUMN': { tool: 'tools/bsl-lint.mjs' },
  'qg:BSL-REF-DOT-ACCESS': { tool: 'tools/bsl-lint.mjs' },
  'qg:BSL-STALE-LOCAL-CALL': { tool: 'tools/rename-check.mjs' },

  // --- код, модельные ------------------------------------------------------
  'qg:QRY-EXECUTED': { tool: null },
  'qg:API-MODULE': { tool: null },
  'qg:API-SIGNATURE': { tool: null },

  // --- архитектура: состав сверяется тестом с signs-map.json ---------------
  ...Object.fromEntries(ARCH_SIGNS),

  // --- AI-антипаттерны: состав сверяется тестом с ai-antipatterns.md -------
  ...Object.fromEntries(AI_SIGNS),
};

export function isKnownQgId(id) {
  return Object.prototype.hasOwnProperty.call(QG_IDS, id);
}
