# Маршрутизация знания в гейте качества — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сократить обязательный контекст прогона гейта вдвое и сделать модельные проходы по антипаттернам видимыми, проверяемыми и измеримыми.

**Architecture:** Знание раскладывается по четырём ярусам: навык (инварианты и цикл), план прогона (печатает инструмент), каталог карточек (триггер отдельно от разбора, индекс генерируется), изолированный субагент-читатель (сверяет код с индексом, результат аттестует инструмент и пишет в журнал). Полнота обнаружения измеряется прогоном по контрольным примерам.

**Tech Stack:** Node.js ≥ 20 (ESM, без зависимостей), тесты `tests/run-tests.mjs` (собственный `check`/`section`), headless `claude -p` для прогона по контрольным примерам.

**Spec:** `C:\Temp\claude\h---GitHub-1c-quality-gate\47a23e6e-0814-4e62-97d0-6880cfe2c10c\scratchpad\qg-context-routing-analysis.md` (разбор и решения). Копию положить в `docs/superpowers/specs/2026-09-07-context-routing-analysis.md` первым коммитом.

## Global Constraints

- Язык файлов и коммитов русский; идентификаторы и код в оригинале; без слов-гибридов (см. `CONTRIBUTING.md`, «Требования к формулировкам»).
- Пути только через `${CLAUDE_PLUGIN_ROOT}` / `$QG` в навыках, никаких абсолютных путей.
- Никаких проектных данных (проверяет `node tools/validate-package.mjs`).
- Тексты стандартов не воспроизводятся, только номера и ссылки.
- Новое блокирующее требование валидатора выходит в два шага: сначала `warn`, следующим MINOR — `error` (`docs/RELEASING.md`). В этом плане все новые требования — `warn`.
- Перед каждым коммитом: `node tests/run-tests.mjs && node tools/validate-package.mjs`.
- Ветка: `feat/context-routing` от `main`. Коммиты завершаются строкой `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Бюджеты навыков в `tests/run-tests.mjs` только снижаются, никогда не повышаются.

---

## Карта файлов

| Файл | Ответственность |
|---|---|
| `tools/evidence-scopes.mjs` | словарь проверок и реестр признаков: новые `scope` и новые `qg:BSL-*` |
| `tools/evidence-validator.mjs` | требование записи о проходах по каталогу при `code ≥ L1` (warn) |
| `skills/bsl-code-review/references/catalog/<ID>.md` | одна карточка на признак с фиксированными секциями |
| `skills/bsl-code-review/references/catalog/INDEX.md` | производный индекс триггеров (генерируется) |
| `tools/gen-catalog-index.mjs` | генератор индекса из карточек |
| `tools/catalog.mjs` | чтение каталога (`index`, `card`, `list`) и аттестация результата читателя (`attest`) |
| `agents/antipattern-reader.md` | субагент-читатель: индекс + код → кандидаты в JSON |
| `tools/profile.mjs` | таблица архетипов, расчёт профиля по трём осям |
| `tools/gate.mjs` | новая команда `plan` |
| `tests/recall/cases/<ID>/` | контрольные примеры: `defect.bsl`, `clean.bsl`, `expected.json` |
| `tests/recall.mjs` | прогон читателя по контрольным примерам через `claude -p` |
| `skills/quality-gate/SKILL.md`, `skills/bsl-code-review/SKILL.md` | ужимаются до цикла и инвариантов |
| `agents/bsl-verifier.md` | теряет пункт про семантический свод |
| `tests/run-tests.mjs` | тесты каталога, аттестации, профиля, новые бюджеты |
| `README.md`, `CONTRIBUTING.md`, `docs/RELEASING.md` | обновление описаний |

---

# Часть A. Словарь: проходы по каталогу оставляют след

### Task 1: Спецификация в репозитории и ветка

**Files:**
- Create: `docs/superpowers/specs/2026-09-07-context-routing-analysis.md`

- [ ] **Step 1: Ветка**

```bash
git switch -c feat/context-routing main
```

- [ ] **Step 2: Скопировать разбор**

Скопировать файл из scratchpad (путь в шапке плана) в `docs/superpowers/specs/2026-09-07-context-routing-analysis.md` без изменений.

- [ ] **Step 3: Проверить, что валидатор пакета не видит утечек**

Run: `node tools/validate-package.mjs`
Expected: `0 ошибок` (в разборе имена проекта пользователя убраны; каталог docs/superpowers исключён из проверки пакета).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-07-context-routing-analysis.md
git commit -m "docs(планы): разбор перегрузки контекста и маршрутизации знания

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: Новые `scope` в словаре и признаки платформенных антипаттернов в реестре

**Files:**
- Modify: `tools/evidence-scopes.mjs` (объект `SCOPES`, секция «код», и `QG_IDS`, секция «код, модельные»)
- Test: `tests/run-tests.mjs` (секция «Словарь проверок — закрытый список scope»)

**Interfaces:**
- Produces: `scope` `ai-antipatterns` и `platform-antipatterns` (layer `code`, `tool: null` в этой части; в части C станет `tools/catalog.mjs`); идентификаторы `qg:BSL-QUERY-IN-LOOP`, `qg:BSL-SUBQUERY-IN-SELECT`, `qg:BSL-CORRELATED-SUBQUERY`, `qg:BSL-TEMPTABLE-NO-INDEX`, `qg:BSL-VT-FILTER-IN-WHERE`, `qg:BSL-NO-TOP-LIMIT`, `qg:BSL-MULTI-SERVER-CALLS`, `qg:BSL-CONTEXT-CALL-UNNEEDED`, `qg:BSL-TXN-INSIDE-TRY`, `qg:BSL-MESSAGE-AS-NOTIFY`, `qg:BSL-NO-CACHE`, `qg:BSL-NESTED-LOOP-SEARCH`, `qg:BSL-DEEP-NESTING` (все `tool: null`).

- [ ] **Step 1: Тест на наличие**

В `tests/run-tests.mjs`, в секцию `Словарь проверок — закрытый список scope`, добавить:

```js
{
  const scopesMod = await import(pathToFileURL(join(ROOT, 'tools', 'evidence-scopes.mjs')).href);
  for (const s of ['ai-antipatterns', 'platform-antipatterns']) {
    check(`scope ${s} есть в словаре и относится к слою code`, scopesMod.SCOPES[s]?.layer === 'code');
  }
  const PLATFORM_MODEL_IDS = [
    'qg:BSL-QUERY-IN-LOOP', 'qg:BSL-SUBQUERY-IN-SELECT', 'qg:BSL-CORRELATED-SUBQUERY',
    'qg:BSL-TEMPTABLE-NO-INDEX', 'qg:BSL-VT-FILTER-IN-WHERE', 'qg:BSL-NO-TOP-LIMIT',
    'qg:BSL-MULTI-SERVER-CALLS', 'qg:BSL-CONTEXT-CALL-UNNEEDED', 'qg:BSL-TXN-INSIDE-TRY',
    'qg:BSL-MESSAGE-AS-NOTIFY', 'qg:BSL-NO-CACHE', 'qg:BSL-NESTED-LOOP-SEARCH', 'qg:BSL-DEEP-NESTING',
  ];
  const missing = PLATFORM_MODEL_IDS.filter((id) => !scopesMod.isKnownQgId(id));
  check('платформенные антипаттерны без инструмента получили идентификаторы', missing.length === 0, missing.join(', '));
}
```

- [ ] **Step 2: Прогнать, убедиться в падении**

Run: `node tests/run-tests.mjs 2>&1 | grep FAIL`
Expected: две строки FAIL про `ai-antipatterns` / `platform-antipatterns` и одна про идентификаторы.

- [ ] **Step 3: Добавить в словарь**

В `SCOPES` после `'adversarial-audit'` (или последнего модельного скоупа контура code):

```js
  // Проходы по каталогу антипатternов. До этой записи два самых объёмных справочника
  // контура читались «всегда», но след не оставляли: в 25 живых отчётах ни одной находки
  // и ни одной записи — отличить «код чист» от «проход не делался» было нечем.
  // `tool: null` временно: аттестацию результата читателя вводит tools/catalog.mjs.
  'ai-antipatterns': {
    layer: 'code',
    tool: null,
    about: 'антипаттерны кода, порождаемого моделью (карточки qg:AI-*)',
    granularity: 'files',
    applies: ['.bsl', '.os'],
  },
  'platform-antipatterns': {
    layer: 'code',
    tool: null,
    about: 'антипаттерны производительности и механики платформы без инструмента (карточки qg:BSL-* с tool: null)',
    granularity: 'files',
    applies: ['.bsl', '.os'],
  },
```

В `QG_IDS`, секция «код, модельные», после `'qg:API-SIGNATURE'`:

```js
  // Платформенные антипаттерны, у которых инструмента нет: до появления каталога они
  // существовали только заголовками справочника и в след попасть не могли.
  'qg:BSL-QUERY-IN-LOOP': { tool: null },
  'qg:BSL-SUBQUERY-IN-SELECT': { tool: null },
  'qg:BSL-CORRELATED-SUBQUERY': { tool: null },
  'qg:BSL-TEMPTABLE-NO-INDEX': { tool: null },
  'qg:BSL-VT-FILTER-IN-WHERE': { tool: null },
  'qg:BSL-NO-TOP-LIMIT': { tool: null },
  'qg:BSL-MULTI-SERVER-CALLS': { tool: null },
  'qg:BSL-CONTEXT-CALL-UNNEEDED': { tool: null },
  'qg:BSL-TXN-INSIDE-TRY': { tool: null },
  'qg:BSL-MESSAGE-AS-NOTIFY': { tool: null },
  'qg:BSL-NO-CACHE': { tool: null },
  'qg:BSL-NESTED-LOOP-SEARCH': { tool: null },
  'qg:BSL-DEEP-NESTING': { tool: null },
```

- [ ] **Step 4: Прогнать тесты и валидатор пакета**

Run: `node tests/run-tests.mjs && node tools/validate-package.mjs`
Expected: 0 FAIL, 0 ошибок. Если валидатор требует, чтобы README называл проверки с инструментом, это не касается `tool: null`.

- [ ] **Step 5: Commit**

```bash
git add tools/evidence-scopes.mjs tests/run-tests.mjs
git commit -m "feat(след): проходы по каталогу антипаттернов получают scope и идентификаторы

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: Валидатор предупреждает, если контур кода запущен, а о проходах по каталогу не заявлено

**Files:**
- Modify: `tools/evidence-validator.mjs` (после блока про архетип `query`, перед `if (!gate)`)
- Test: `tests/run-tests.mjs` (секция «Валидатор следа — отвергает недобросовестный прогон»)
- Create: `tests/fixtures/evidence/code-without-catalog.md`

- [ ] **Step 1: Фикстура**

`tests/fixtures/evidence/code-without-catalog.md`:

```markdown
# Отчёт

## quality evidence

[qg scope: volume=C1, files=1, loc=+5/-1, archetypes=[none], driver=volume, resolved=code:L1|arch:skip|xml:n/a|hygiene:full, config=default]
[qg sentinel: target=std454, status=found]
[qg applied: layer=hygiene, scope=file-encoding, ids=[qg:HYG-BOM], verdict=clean]
[qg applied: layer=code, scope=static-analysis, ids=[bslls:*], verdict=clean]
[qg not_verified: dimension=compilation, reason=no_platform]
```

- [ ] **Step 2: Тест**

```js
{
  const v = await import(pathToFileURL(join(ROOT, 'tools', 'evidence-validator.mjs')).href);
  const text = readFileSync(join(FIXTURES, 'evidence', 'code-without-catalog.md'), 'utf8');
  const res = v.validate(text, { gate: false });
  const warns = res.problems.filter((p) => p.severity === 'warn' && /ai-antipatterns/.test(p.message));
  check('контур кода без записи о проходе по каталогу получает предупреждение', warns.length === 1, JSON.stringify(res.problems));
  const withRecord = text + '\n[qg applied: layer=code, scope=ai-antipatterns, ids=[qg:AI-01], verdict=clean]\n[qg skipped: layer=code, scope=platform-antipatterns, reason=not_applicable]\n';
  const res2 = v.validate(withRecord, { gate: false });
  check('с записями о проходах предупреждения нет', !res2.problems.some((p) => /ai-antipatterns|platform-antipatterns/.test(p.message)), JSON.stringify(res2.problems));
}
```

- [ ] **Step 3: Прогнать, убедиться в падении первого check**

Run: `node tests/run-tests.mjs 2>&1 | grep FAIL`

- [ ] **Step 4: Реализация**

В `validate()` после блока `queryArchetype`:

```js
  // Контур кода запущен хотя бы на L1 — значит, два прохода по каталогу антипаттернов
  // обязаны быть заявлены: applied, skipped или not_verified. До этого требования два самых
  // объёмных справочника контура читались «всегда», а следа не оставляли, и отличить «код
  // чист» от «проход не делался» было нечем. Пока предупреждение: блокирующим станет
  // следующим MINOR (docs/RELEASING.md, переходное окно).
  const codeDepth = (() => {
    const s = records.find((r) => r.type === 'scope');
    const resolved = String(s?.fields?.resolved || '');
    const m = resolved.match(/(?:^|\|)code:([^|]+)/);
    return m ? m[1].trim() : null;
  })();
  if (codeDepth && codeDepth !== 'skip') {
    const skippedScopes = new Set(records.filter((r) => r.type === 'skipped' && r.fields.scope).map((r) => String(r.fields.scope).trim()));
    for (const s of ['ai-antipatterns', 'platform-antipatterns']) {
      if (closes.has(s) || skippedScopes.has(s)) continue;
      add(
        'warn',
        records.find((r) => r.type === 'scope')?.line || 0,
        `контур code запущен (${codeDepth}), но о проходе ${s} не заявлено: нужна запись ` +
          `[qg applied: layer=code, scope=${s}, ...] либо [qg skipped: layer=code, scope=${s}, reason=...]`
      );
    }
  }
```

- [ ] **Step 5: Тесты и валидатор пакета**

Run: `node tests/run-tests.mjs && node tools/validate-package.mjs`
Expected: 0 FAIL. Если существующие фикстуры `valid.md` / `all-clean.md` теперь получают предупреждение и тест на них считает предупреждения, дописать в них две записи `skipped ... reason=not_applicable`.

- [ ] **Step 6: Документация формата следа**

В `skills/quality-gate/references/evidence-format.md`, раздел `### applied`, после абзаца о `skipped` с `not_applicable`, добавить:

```markdown
**Проходы по каталогу антипаттернов заявляются всегда, когда запущен контур кода.** Записи
`scope=ai-antipatterns` и `scope=platform-antipatterns` печатает `tools/catalog.mjs attest`
по результату субагента-читателя; без них валидатор предупреждает, а следующим релизом
откажет. Причина: проходы делает модель, и без записи их пропуск неотличим от выполнения.
```

- [ ] **Step 7: Commit**

```bash
git add tools/evidence-validator.mjs tests/run-tests.mjs tests/fixtures/evidence/code-without-catalog.md skills/quality-gate/references/evidence-format.md
git commit -m "feat(валидатор): предупреждение о незаявленных проходах по каталогу антипаттернов

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

# Часть B. Каталог карточек и индекс триггеров

### Task 4: Формат карточки и генератор индекса

**Files:**
- Create: `tools/gen-catalog-index.mjs`
- Create: `skills/bsl-code-review/references/catalog/AI-07.md` (первая карточка, образец)
- Test: `tests/run-tests.mjs` (новая секция «Каталог антипаттернов — формат карточек и индекс»)

**Interfaces:**
- Produces: формат карточки (frontmatter + пять секций H2), функции `readCatalog(dir)` → `Array<{id, title, severity, group, tool, archetypes, std, trigger, file}>` и `renderIndex(cards)` → строка Markdown, экспортируемые из `tools/gen-catalog-index.mjs`.

Формат карточки (frontmatter обязателен, секции H2 ровно эти и в этом порядке):

```markdown
---
id: qg:AI-07
title: У параметров, которые метод не изменяет, не стоит Знач
severity: major
group: model
tool: null
archetypes: [always]
std: [std487, std640]
---

## Триггер

Параметры-структуры, массивы и таблицы значений без `Знач` в методах, которые их не
изменяют. Отдельно — серверные методы, вызываемые из клиентского кода формы.

## Почему

<текст из «Коротко» и «Чего Знач не делает» исходной записи AI-07>

## Как чинить

#### Неправильно

```bsl
Функция ПодобратьЦены(ТаблицаТоваров)
```

#### Правильно

```bsl
Функция ПодобратьЦены(Знач ТаблицаТоваров)
```

<остальной текст исходной записи: смежные ошибки, проявление>

## Когда это не дефект

- метод обязан изменить переданную коллекцию: заполнить таблицу результата, дописать структуру
  параметров, снять признак у строк — тогда `Знач` не ставится, а в описании параметра прямо
  сказано, что он изменяется (#std453);
- параметр примитивного типа, который метод не меняет: `Знач` ничего не даёт по существу, но
  и не мешает; правило про коллекции.

## Что проверяет инструмент

Диагностика для серверного метода, вызываемого с клиента, есть — АПК:1412, — но печатает её
автоматизированная проверка конфигураций, а не инструменты гейта. В прогоне гейта правило
проверяется чтением: изменяет метод коллекцию или нет, видно только по телу метода.
```

Значения: `severity` ∈ `critical | major | minor` (🔴/🟠/🟡 исходников); `group` ∈ `model | platform`; `tool` — `null` либо путь инструмента из `QG_IDS`; `archetypes` — `[always]` либо список меток из таблицы архетипов (`query`, `transaction`, `record-set`, `object-event`, `integration`, `rights`, `cfe-patch`, `scheduled-job`, `client-server`, `user-dialog`, `form-module`, `async-client`, `new-common-module`, `new-metadata-object`); `std` — список без `#`.

- [ ] **Step 1: Тест формата и генератора**

```js
section('Каталог антипаттернов — формат карточек и индекс');

{
  const gen = await import(pathToFileURL(join(ROOT, 'tools', 'gen-catalog-index.mjs')).href);
  const dir = join(ROOT, 'skills', 'bsl-code-review', 'references', 'catalog');
  const cards = gen.readCatalog(dir);
  check('каталог читается и не пуст', cards.length >= 1, String(cards.length));
  const SECTIONS = ['Триггер', 'Почему', 'Как чинить', 'Когда это не дефект', 'Что проверяет инструмент'];
  for (const c of cards) {
    const text = readFileSync(c.file, 'utf8');
    const h2 = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    check(`${c.id}: пять секций в заданном порядке`, JSON.stringify(h2) === JSON.stringify(SECTIONS), JSON.stringify(h2));
    check(`${c.id}: severity из списка`, ['critical', 'major', 'minor'].includes(c.severity), c.severity);
    check(`${c.id}: group из списка`, ['model', 'platform'].includes(c.group), c.group);
    check(`${c.id}: триггер непустой и короче 600 байт`, c.trigger.length > 20 && Buffer.byteLength(c.trigger) < 600, String(Buffer.byteLength(c.trigger)));
    check(`${c.id}: имя файла совпадает с id`, c.file.endsWith(`${c.id.replace(/^qg:/, '')}.md`), c.file);
    check(`${c.id}: «Когда это не дефект» — список`, /## Когда это не дефект\n\n- /.test(text));
  }
  const md = gen.renderIndex(cards);
  check('индекс содержит каждый id', cards.every((c) => md.includes(c.id)));
  check('индекс укладывается в 12 КБ на 46 карточек', Buffer.byteLength(md) / Math.max(cards.length, 1) * 46 <= 12 * 1024, String(Buffer.byteLength(md)));
}
```

- [ ] **Step 2: Прогнать, убедиться в падении (модуля нет)**

Run: `node tests/run-tests.mjs 2>&1 | grep -c FAIL`

- [ ] **Step 3: Генератор**

`tools/gen-catalog-index.mjs`:

```js
#!/usr/bin/env node
/**
 * Индекс триггеров каталога антипаттернов — производный файл из карточек.
 *
 * Зачем: для обнаружения нужны только триггеры (2–4 строки на признак), разбор нужен
 * только при попадании. Два прежних справочника грузили в контекст 131 КБ при каждом
 * прогоне, из них триггеров — меньше десятой части. Индекс генерируется, потому что
 * вручную поддерживаемая копия расходится с карточками при первой правке.
 *
 * Использование:
 *   node tools/gen-catalog-index.mjs            # перезаписать INDEX.md
 *   node tools/gen-catalog-index.mjs --check    # выйти с кодом 1, если INDEX.md устарел
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const CATALOG_DIR = join(here, '..', 'skills', 'bsl-code-review', 'references', 'catalog');
export const INDEX_FILE = join(CATALOG_DIR, 'INDEX.md');

const SEVERITY_MARK = { critical: '🔴', major: '🟠', minor: '🟡' };

/** Frontmatter карточки: плоские скаляры и списки в квадратных скобках. */
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error('нет frontmatter');
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const v = raw.trim();
    if (v === 'null') data[key] = null;
    else if (v.startsWith('[')) data[key] = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    else data[key] = v;
  }
  return { data, body: text.slice(m[0].length) };
}

/** Текст секции «## Триггер» до следующего H2, схлопнутый в один абзац. */
function triggerOf(body) {
  const m = body.match(/^## Триггер\n([\s\S]*?)(?=^## )/m);
  return (m ? m[1] : '').trim().replace(/\s*\n\s*/g, ' ');
}

export function readCatalog(dir = CATALOG_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
    .sort()
    .map((f) => {
      const file = join(dir, f);
      const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));
      for (const k of ['id', 'title', 'severity', 'group', 'archetypes']) {
        if (data[k] === undefined) throw new Error(`${f}: в frontmatter нет поля ${k}`);
      }
      return {
        id: data.id,
        title: data.title,
        severity: data.severity,
        group: data.group,
        tool: data.tool ?? null,
        archetypes: data.archetypes,
        std: data.std || [],
        trigger: triggerOf(body),
        file,
      };
    });
}

export function renderIndex(cards) {
  const head = [
    '# Индекс триггеров каталога антипаттернов',
    '',
    'Производный файл — источник истины карточки `catalog/<ID>.md`. Правки вносить в карточки,',
    'индекс перегенерировать: `node tools/gen-catalog-index.mjs`.',
    '',
    'Здесь только то, что нужно для обнаружения: идентификатор, важность и триггер. Разбор,',
    'способ исправления и законные формы — в карточке; она читается по попаданию, а не заранее.',
    'Карточки с инструментом перечислены ради «как чинить»: их находки печатает инструмент,',
    'своих находок этого класса не добавляй.',
    '',
    '| Признак | Важность | Группа | Архетипы | Инструмент | Триггер |',
    '|---|---|---|---|---|---|',
  ];
  const rows = cards.map((c) =>
    `| \`${c.id}\` | ${SEVERITY_MARK[c.severity] || c.severity} | ${c.group} | ${c.archetypes.join(', ')} | ${c.tool ? `\`${c.tool.replace(/^tools\//, '')}\`` : 'чтение'} | ${c.trigger.replace(/\|/g, '\\|')} |`
  );
  return [...head, ...rows, ''].join('\n');
}

function main(argv) {
  const cards = readCatalog();
  const md = renderIndex(cards);
  if (argv.includes('--check')) {
    const current = existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, 'utf8') : '';
    if (current !== md) {
      process.stderr.write('INDEX.md устарел, перегенерируй: node tools/gen-catalog-index.mjs\n');
      return 1;
    }
    return 0;
  }
  writeFileSync(INDEX_FILE, md, 'utf8');
  process.stdout.write(`Записано карточек: ${cards.length} → ${INDEX_FILE}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
```

- [ ] **Step 4: Первая карточка `AI-07.md`** по формату выше, текст перенести из `ai-antipatterns.md` строки 253–314 (содержимое разделов «Коротко», «Чего Знач не делает», «Смежная ошибка» ×2, «Как проявляется», «Когда так делать не нужно», «Что проверяет инструмент»). Ни одна фраза исходника не теряется; строки `ЗаполнитьЗначенияСвойств(Приёмник` и `&НаКлиентеНаСервереБезКонтекста` не переформулировать (на них есть тесты).

- [ ] **Step 5: Сгенерировать индекс и прогнать тесты**

Run: `node tools/gen-catalog-index.mjs && node tests/run-tests.mjs 2>&1 | grep -E "FAIL|passed|прошло"`
Expected: секция каталога зелёная.

- [ ] **Step 6: Commit**

```bash
git add tools/gen-catalog-index.mjs skills/bsl-code-review/references/catalog tests/run-tests.mjs
git commit -m "feat(каталог): формат карточки антипаттерна и генератор индекса триггеров

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: Перенос всех записей `ai-antipatterns.md` в карточки

**Files:**
- Create: `skills/bsl-code-review/references/catalog/AI-01.md` … `AI-22.md` (кроме `AI-07`, уже есть)
- Modify: `tests/run-tests.mjs` (пары `mustContain`, указывающие на `ai-antipatterns.md`, и тест «Реестр признаков — полнота»)

Соответствие: заголовок `### AI-NN · <title> <emoji>` в `ai-antipatterns.md` → файл `AI-NN.md`; `title` без emoji; `severity` по emoji; `group: model`; `tool` — `tools/bsl-lint.mjs` для `AI-02` (механизирован как `qg:BSL-REF-DOT-ACCESS`) и `AI-16` (`qg:BSL-UNBOUNDED-STRING-COLUMN`), иначе `null`; `archetypes`: `AI-01` → `[record-set]`, `AI-10`, `AI-16`, `AI-17`, `AI-18` → `[query]`, `AI-06` → `[object-event, form-module]`, `AI-12` → `[object-event, transaction]`, `AI-14` → `[always]`, остальные `[always]`; `std` — все `#stdNNN`, упомянутые в записи.

Разнесение текста по секциям: «Что искать» / «Диагностический признак» / «Признак в сравнении версий» → `## Триггер`; «Почему» / «Почему это опасно» / «Коротко» / «Конкретная ловушка» → `## Почему`; «Как правильно» / пары «Неправильно / Правильно» / «Не потеряй при этом» / «Смежная ошибка» → `## Как чинить`; «Контр-сигнал» / «Когда так делать не нужно» → `## Когда это не дефект`; «Механизированная часть» / «Что проверяет инструмент» → `## Что проверяет инструмент`. Если в записи нет контр-сигнала, написать список минимум из одного пункта с причиной, исходя из текста записи (например, для `AI-04`: «отчёт прямо называет проверку непрогнанной и причину — это заявленный пропуск, а не дефект»). Если нет раздела про инструмент, писать: «Инструмента нет, правило проверяется чтением кода.»

- [ ] **Step 1: Создать 21 карточку** по соответствию выше. Проверять по ходу: `node tools/gen-catalog-index.mjs && node tests/run-tests.mjs 2>&1 | grep FAIL`.

- [ ] **Step 2: Перенаправить тесты `mustContain`**

Каждая пара с первым элементом `skills/bsl-code-review/references/ai-antipatterns.md` меняет путь на карточку по тексту: `'AI-01'` → `catalog/AI-01.md` (искомая строка становится `id: qg:AI-01`), `'AI-04'` → `catalog/AI-04.md`, `'AI-05'` → `catalog/AI-05.md`, `ЗаполнитьЗначенияСвойств(Приёмник` → `catalog/AI-07.md`, `соединении (\`ПО\`)`, `таблицу в запрос отправляет **другой метод**`, `#std432 п. 2`, `ВЫРАЗИТЬ(Т.Поле КАК СТРОКА(N))` → `catalog/AI-16.md`, `Выгрузить()`, `без \`ОписаниеТипов\``, `Сворачивать нужно копию` → `catalog/AI-17.md`, `ключ — это набор колонок, а не колонка`, `соответствию состава колонок в индексе`, `в регламентном задании по большому списку` → `catalog/AI-18.md`, `Механизированная часть` → `catalog/AI-02.md` (в карточке эта фраза остаётся в секции «Что проверяет инструмент»).

- [ ] **Step 3: Тест полноты реестра — по каталогу, а не по заголовкам**

В секции «Реестр признаков — полнота» заменить блок про `aiDoc` на:

```js
  const gen = await import(pathToFileURL(join(ROOT, 'tools', 'gen-catalog-index.mjs')).href);
  const cardIds = gen.readCatalog().map((c) => c.id);
  const aiInCatalog = cardIds.filter((id) => id.startsWith('qg:AI-'));
  check('AI-карточки в каталоге есть', aiInCatalog.length >= 22, `найдено ${aiInCatalog.length}`);
  const aiMissing = aiInCatalog.filter((id) => !registry[id]);
  check('все AI-карточки в реестре', aiMissing.length === 0, aiMissing.join(', '));
  const aiOrphans = Object.keys(registry).filter((id) => id.startsWith('qg:AI-')).filter((id) => !aiInCatalog.includes(id));
  check('в реестре нет AI-признаков без карточки', aiOrphans.length === 0, aiOrphans.join(', '));
```

- [ ] **Step 4: Удалить `ai-antipatterns.md` и починить ссылки**

```bash
git rm skills/bsl-code-review/references/ai-antipatterns.md
```

Ссылки заменить: `agents/bsl-verifier.md:146` — пункт 6 удалить целиком (семантический свод не для механического чеклиста; замена появится в части C); `CONTRIBUTING.md:13` — «Файлы `ai-antipatterns.md` и …» → «Карточки `catalog/AI-*.md` и …»; `README.md:278` — ссылку на `ai-antipatterns.md` заменить на `skills/bsl-code-review/references/catalog/INDEX.md`; `skills/bsl-architecture-review/references/ai-antipatterns-arch.md:3` → «Продолжение каталога `catalog/AI-*.md` контура кода»; `bsl-anti-patterns.md:69` → `catalog/AI-09.md`; `tools/bsl-lint.mjs:672,1148` — комментарии на `catalog/AI-02.md` и `catalog/AI-09.md`; `tools/evidence-scopes.mjs` — комментарии про `ai-antipatterns.md` → «каталог карточек»; `skills/bsl-code-review/SKILL.md:134` — временно: «Источник: `references/catalog/INDEX.md`; карточка читается по попаданию» (окончательная редакция в части C). Хвост «Что проверяется другими контурами» из удаляемого файла перенести в шапку генератора (`head` в `renderIndex`) как два абзаца.

- [ ] **Step 5: Прогнать всё**

Run: `node tools/gen-catalog-index.mjs && node tests/run-tests.mjs && node tools/validate-package.mjs`
Expected: 0 FAIL, 0 ошибок (валидатор пакета ловит битые ссылки на удалённый файл — починить все).

- [ ] **Step 6: Commit**

```bash
git add -A skills/bsl-code-review/references tests/run-tests.mjs agents/bsl-verifier.md CONTRIBUTING.md README.md skills/bsl-architecture-review/references/ai-antipatterns-arch.md tools/bsl-lint.mjs tools/evidence-scopes.mjs tools/gen-catalog-index.mjs skills/bsl-code-review/SKILL.md
git commit -m "refactor(каталог): антипаттерны кода модели — по карточке на признак

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: Перенос `bsl-anti-patterns.md` и карточки для инструментальных признаков

**Files:**
- Create: 13 карточек `BSL-*.md` для модельных признаков из Task 2 и карточки для инструментальных `BSL-TXN-IN-HANDLER`, `BSL-ENUM-STRING-ASSIGN`, `BSL-STALE-LOCAL-CALL`, `BSL-FORM-ATTR-SHADOW`, `BSL-DISPATCH-NO-FALLBACK`, `BSL-DB-READ-IN-LOOP`, `BSL-REF-DOT-ACCESS`, `BSL-STRTEMPLATE-ARITY`, `BSL-UNBOUNDED-STRING-COLUMN`, `QRY-TOP-WITHOUT-ORDER`, `QRY-ALIAS-SHADOWS-FIELD`, `QRY-ALIAS-SHADOWS-NESTED-TABLE`
- Delete: `skills/bsl-code-review/references/bsl-anti-patterns.md`
- Modify: `tests/run-tests.mjs`

Соответствие записей `bsl-anti-patterns.md` → карточка (`group: platform`, `severity`: CRITICAL→critical, HIGH→major, MEDIUM→minor):

| Запись | Карточка | tool | archetypes |
|---|---|---|---|
| 1. Запрос в цикле | `BSL-QUERY-IN-LOOP` | null | always |
| 1а. Чтение базы через вызов | `BSL-DB-READ-IN-LOOP` | tools/bsl-lint.mjs | always |
| 2. Обращение через точку | `BSL-REF-DOT-ACCESS` | tools/bsl-lint.mjs | always |
| 3. Подзапрос в SELECT | `BSL-SUBQUERY-IN-SELECT` | null | query |
| 3а. Коррелированный подзапрос | `BSL-CORRELATED-SUBQUERY` | null | query |
| 3б. ВТ без индекса | `BSL-TEMPTABLE-NO-INDEX` | null | query |
| 4. Фильтр ВТ в ГДЕ | `BSL-VT-FILTER-IN-WHERE` | null | query |
| 5. Нет ПЕРВЫЕ N | `BSL-NO-TOP-LIMIT` | null | query |
| 5. ПЕРВЫЕ N без порядка (часть п. 5) | `QRY-TOP-WITHOUT-ORDER` | tools/query-lint.mjs | query |
| 6. Множественные вызовы | `BSL-MULTI-SERVER-CALLS` | null | client-server, form-module |
| 7. &НаСервере без нужды | `BSL-CONTEXT-CALL-UNNEEDED` | null | client-server, form-module |
| 8. Транзакция внутри Попытки | `BSL-TXN-INSIDE-TRY` | null | transaction |
| 8а. Сообщить() | `BSL-MESSAGE-AS-NOTIFY` | null | always |
| 8б. Транзакция в обработчике | `BSL-TXN-IN-HANDLER` | tools/bsl-lint.mjs | transaction, object-event |
| 8в. Примитив в ссылочное поле | `BSL-ENUM-STRING-ASSIGN` | tools/bsl-lint.mjs | always |
| 8г. Исчезнувшее объявление | `BSL-STALE-LOCAL-CALL` | tools/rename-check.mjs | always |
| 8д. Переменная под именем реквизита | `BSL-FORM-ATTR-SHADOW` | tools/bsl-lint.mjs | form-module |
| 8е. Ветки без Иначе | `BSL-DISPATCH-NO-FALLBACK` | tools/bsl-lint.mjs | always |
| 9. Нет кеширования | `BSL-NO-CACHE` | null | always |
| 10. O(n²) | `BSL-NESTED-LOOP-SEARCH` | null | always |
| 11. Глубокая вложенность | `BSL-DEEP-NESTING` | null | always |

Карточки без записи в справочнике пишутся заново, коротко (до 40 строк), по строке таблицы признаков в `bsl-code-review/SKILL.md` и комментарию в исходнике инструмента: `BSL-STRTEMPLATE-ARITY` (`tools/bsl-lint.mjs`, строка таблицы 167), `BSL-UNBOUNDED-STRING-COLUMN` (разбор уже в `AI-16.md`, карточка ссылается на неё), `QRY-ALIAS-SHADOWS-FIELD` и `QRY-ALIAS-SHADOWS-NESTED-TABLE` (разбор в `bsl-query-reference.md`, карточка ссылается).

Секция «Когда это не дефект» для платформенных записей, где контр-сигнала в исходнике нет (пункты с причиной):

- `BSL-QUERY-IN-LOOP`: цикл по пакетам, где один запрос обрабатывает пакет строк (пакетная схема); цикл по узлам обмена или базам, у которых разные источники; запрос с разными текстами на витке.
- `BSL-SUBQUERY-IN-SELECT`: подзапрос по константе или параметру без связи с внешней строкой (вычисляется один раз).
- `BSL-CORRELATED-SUBQUERY`: `СУЩЕСТВУЕТ` в условии по индексированному полю на малой таблице; проверка наличия, где соединение дало бы дубли.
- `BSL-TEMPTABLE-NO-INDEX`: временная таблица до 100 строк; таблица, которая далее не участвует в соединении.
- `BSL-VT-FILTER-IN-WHERE`: условие по полю, которого нет среди параметров виртуальной таблицы (ресурсы, вычисляемые поля); условие с `ИЛИ` между измерениями, которое параметры не выражают.
- `BSL-NO-TOP-LIMIT`: запрос по ключу с заведомо одной строкой; запрос с агрегатами без группировки; запрос уже ограничен параметрами периода и отбора.
- `BSL-MULTI-SERVER-CALLS`: вызовы разделены ожиданием ответа пользователя (диалог между ними); второй вызов зависит от результата первого и выполняется не всегда.
- `BSL-CONTEXT-CALL-UNNEEDED`: метод читает или пишет реквизиты формы или её элементы; метод вызывает другие контекстные методы.
- `BSL-TXN-INSIDE-TRY`: `Попытка` снаружи и `НачатьТранзакцию` внутри с `ОтменитьТранзакцию` в исключении — это законная форма; дефект только когда `НачатьТранзакцию` стоит выше `Попытка` и исключение уходит без отмены.
- `BSL-MESSAGE-AS-NOTIFY`: отладочный вывод в одноразовой обработке; сообщение уже сопровождается записью в журнал регистрации.
- `BSL-NO-CACHE`: вызов дешёвый (чтение константы модуля, арифметика); вызов с побочным эффектом; параметры между вызовами меняются.
- `BSL-NESTED-LOOP-SEARCH`: обе коллекции до 50 элементов; внешняя коллекция обходится один раз, а внутренняя уже соответствие.
- `BSL-DEEP-NESTING`: вложенность образована одним длинным условием с `И`, а не лестницей; обработчик с обязательной структурой платформы (например, `Попытка` внутри цикла внутри транзакции).

- [ ] **Step 1: Создать карточки** по таблице. Тексты переносить целиком; фразы, на которые есть тесты (`Запрос в цикле`, `Коррелированный подзапрос`, `ИНДЕКСИРОВАТЬ ПО`, `СообщитьПользователю`, `qg:BSL-TXN-IN-HANDLER`, `#std783 п. 1.4`, `qg:QRY-TOP-WITHOUT-ORDER`, `Законные формы`, `BSL-ENUM-STRING-ASSIGN`, `Составные типы`, `ОбработкаУдаленияПроведения`, `ПередУдалением`, `qg:BSL-REF-DOT-ACCESS`, `нижняя граница`, `Отбор.Ссылка.Значение`, `присваивание в этом же методе`, `#std453`, `с именами объектов конфигурации инструмент не сопоставляет`), не менять.

- [ ] **Step 2: Перенаправить `mustContain`** — каждая пара с `bsl-anti-patterns.md` указывает на карточку: `Запрос в цикле` → `BSL-QUERY-IN-LOOP.md`; `Коррелированный подзапрос` → `BSL-CORRELATED-SUBQUERY.md`; `ИНДЕКСИРОВАТЬ ПО` → `BSL-TEMPTABLE-NO-INDEX.md`; `СообщитьПользователю` → `BSL-MESSAGE-AS-NOTIFY.md`; `qg:BSL-TXN-IN-HANDLER`, `#std783 п. 1.4`, `ОбработкаУдаленияПроведения`, `ПередУдалением` → `BSL-TXN-IN-HANDLER.md`; `qg:QRY-TOP-WITHOUT-ORDER`, `Законные формы` → `QRY-TOP-WITHOUT-ORDER.md`; `BSL-ENUM-STRING-ASSIGN`, `Составные типы` → `BSL-ENUM-STRING-ASSIGN.md`; `qg:BSL-REF-DOT-ACCESS`, `нижняя граница`, `Отбор.Ссылка.Значение`, `присваивание в этом же методе`, `#std453`, `с именами объектов конфигурации инструмент не сопоставляет` → `BSL-REF-DOT-ACCESS.md`. Тест про обработчики неявной транзакции (`TRANSACTIONAL_HANDLERS`) читает `catalog/BSL-TXN-IN-HANDLER.md` вместо `bsl-anti-patterns.md`.

- [ ] **Step 3: Тест «каждый qg:* контура кода имеет карточку»** в секции «Реестр признаков — полнота»:

```js
  const codeIds = Object.keys(registry).filter((id) => /^qg:(AI|BSL|QRY)-/.test(id));
  const noCard = codeIds.filter((id) => !cardIds.includes(id));
  check('у каждого признака контура кода есть карточка', noCard.length === 0, noCard.join(', '));
  const noRegistry = cardIds.filter((id) => !registry[id]);
  check('у каждой карточки есть признак в реестре', noRegistry.length === 0, noRegistry.join(', '));
  for (const c of gen.readCatalog()) {
    check(`${c.id}: tool карточки совпадает с реестром`, (c.tool || null) === (registry[c.id]?.tool || null), `${c.tool} против ${registry[c.id]?.tool}`);
  }
```

- [ ] **Step 4: Удалить справочник, починить ссылки**

```bash
git rm skills/bsl-code-review/references/bsl-anti-patterns.md
```

Ссылки: `bsl-query-optimization.md:5`, `bsl-refactoring.md:126,130`, `tools/bsl-lint.mjs:672`, `README.md`, `skills/bsl-code-review/SKILL.md` (таблица признаков, колонка «Разбор»: `references/catalog/<ID>.md`; таблица в п. 1 Слоя 1б: «Источник: `references/catalog/INDEX.md`»).

- [ ] **Step 5: Валидатор пакета и CI проверяют свежесть индекса**

В `tools/validate-package.mjs` после блока 6 (signs-map) добавить:

```js
// --- 6б. Индекс каталога синхронен с карточками ------------------------------
{
  const gen = await import(pathToFileURL(join(ROOT, 'tools', 'gen-catalog-index.mjs')).href);
  const cards = gen.readCatalog();
  const expected = gen.renderIndex(cards);
  const current = existsSync(gen.INDEX_FILE) ? readFileSync(gen.INDEX_FILE, 'utf8') : '';
  if (current !== expected) fail('catalog/INDEX.md', 'индекс устарел — перегенерируй: node tools/gen-catalog-index.mjs');
}
```

(если `validate-package.mjs` не async-модуль, обернуть в `await` на верхнем уровне ESM — это допустимо). В `.github/workflows/validate.yml` и `release.yml` рядом с шагом про `signs-map.md` добавить шаг `node tools/gen-catalog-index.mjs --check`.

- [ ] **Step 6: Прогнать всё**

Run: `node tools/gen-catalog-index.mjs && node tests/run-tests.mjs && node tools/validate-package.mjs`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(каталог): платформенные антипаттерны и инструментальные признаки — карточками

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

# Часть C. Субагент-читатель и аттестация результата

### Task 7: `tools/catalog.mjs` — чтение каталога и аттестация

**Files:**
- Create: `tools/catalog.mjs`
- Modify: `tools/evidence-scopes.mjs` (`ai-antipatterns`, `platform-antipatterns` → `tool: 'tools/catalog.mjs'`)
- Test: `tests/run-tests.mjs` (новая секция «Аттестация результата читателя каталога»)

**Interfaces:**
- Consumes: `readCatalog`, `renderIndex` из `tools/gen-catalog-index.mjs`; `recordRun`, `normalizePath` из `tools/run-journal.mjs`; `isKnownQgId` из `tools/evidence-scopes.mjs`.
- Produces: CLI `node tools/catalog.mjs index [--archetypes a,b]`, `card <ID>`, `list --json`, `attest --result <json> --files <f>... [--archetypes a,b]`; функция `attest({ result, files, archetypes, root })` → `{ ok, problems: string[], evidence: string[] }`.

Формат файла результата читателя (JSON):

```json
{
  "examined": ["qg:AI-01", "qg:AI-03"],
  "files": ["src/cfe/Ext/CommonModules/Модуль/Ext/Module.bsl"],
  "findings": [
    { "id": "qg:AI-07", "file": "src/.../Module.bsl", "line": 120, "method": "ПодобратьЦены",
      "quote": "Функция ПодобратьЦены(ТаблицаТоваров)", "note": "метод только читает таблицу" }
  ],
  "unreadable": []
}
```

Правила аттестации (каждое нарушение — строка в `problems`, при любой — `ok: false`, код возврата 2, записи в журнал не пишутся):

1. `examined` содержит ровно множество `id` карточек с `tool: null`, чьи `archetypes` включают `always` или пересекаются с переданными `--archetypes` (карточки с инструментом читатель не проверяет). Недостающий или лишний `id` — нарушение.
2. `files` совпадает с `--files` по каноническому ключу (`normalizePath`).
3. Каждая находка: `id` из реестра и из `examined`; `file` из `files`; `line` в пределах файла; `quote` непустая и встречается в строках `line-2 … line+2` файла после схлопывания пробелов. Это делает выдуманную находку дороже настоящей.
4. `unreadable` — файлы из `files`, которые не удалось прочитать; они не считаются проверенными: если список непуст, вместо `applied` печатается `not_verified: dimension=<scope>, reason=unreadable, files=N`.

Вывод при `ok`: две строки следа и две записи журнала (`recordRun({ scope, tool: 'tools/catalog.mjs', verdict, files })`):

```
[qg applied: layer=code, scope=ai-antipatterns, ids=[<examined qg:AI-*>], verdict=clean|violation:<первый id находки AI>]
[qg applied: layer=code, scope=platform-antipatterns, ids=[<examined qg:BSL-*>], verdict=clean|violation:<первый id BSL>]
```

Если для скоупа `examined` пуст (например, ни один платформенный признак не активен по архетипам), печатается `[qg skipped: layer=code, scope=platform-antipatterns, reason=not_applicable]` и запись журнала с `verdict: 'not_applicable'`.

- [ ] **Step 1: Тест**

```js
section('Аттестация результата читателя каталога');

{
  const cat = await import(pathToFileURL(join(ROOT, 'tools', 'catalog.mjs')).href);
  const gen = await import(pathToFileURL(join(ROOT, 'tools', 'gen-catalog-index.mjs')).href);
  const root = join(WORK, 'attest-root');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.1c-quality-gate.json'), '{}', 'utf8');
  const bsl = join(root, 'src', 'Module.bsl');
  writeFileSync(bsl, 'Функция ПодобратьЦены(ТаблицаТоваров)\n\tВозврат ТаблицаТоваров.Количество();\nКонецФункции\n', 'utf8');

  const expectedExamined = gen.readCatalog().filter((c) => !c.tool && c.archetypes.includes('always')).map((c) => c.id);
  const good = {
    examined: expectedExamined,
    files: ['src/Module.bsl'],
    findings: [{ id: 'qg:AI-07', file: 'src/Module.bsl', line: 1, method: 'ПодобратьЦены', quote: 'Функция ПодобратьЦены(ТаблицаТоваров)', note: 'только читает' }],
    unreadable: [],
  };
  const ok = cat.attest({ result: good, files: ['src/Module.bsl'], archetypes: [], root });
  check('корректный результат аттестуется', ok.ok === true, ok.problems.join('; '));
  check('печатается запись ai-antipatterns с violation', ok.evidence.some((l) => /scope=ai-antipatterns.*verdict=violation:qg:AI-07/.test(l)), ok.evidence.join('\n'));
  check('печатается запись platform-antipatterns', ok.evidence.some((l) => /scope=platform-antipatterns/.test(l)), ok.evidence.join('\n'));

  const fake = { ...good, findings: [{ ...good.findings[0], quote: 'Такой строки в файле нет' }] };
  const bad = cat.attest({ result: fake, files: ['src/Module.bsl'], archetypes: [], root });
  check('цитата, которой нет в файле, отвергается', bad.ok === false && bad.problems.some((p) => /цитат/i.test(p)), bad.problems.join('; '));

  const partial = { ...good, examined: expectedExamined.slice(1) };
  const bad2 = cat.attest({ result: partial, files: ['src/Module.bsl'], archetypes: [], root });
  check('неполный список проверенных признаков отвергается', bad2.ok === false && bad2.problems.some((p) => /examined/.test(p)), bad2.problems.join('; '));

  const unknown = { ...good, findings: [{ ...good.findings[0], id: 'qg:AI-99' }] };
  const bad3 = cat.attest({ result: unknown, files: ['src/Module.bsl'], archetypes: [], root });
  check('вымышленный идентификатор отвергается', bad3.ok === false, bad3.problems.join('; '));

  const journal = await import(pathToFileURL(join(ROOT, 'tools', 'run-journal.mjs')).href);
  const runs = journal.readJournal(root).filter((r) => r.tool === 'tools/catalog.mjs');
  check('успешная аттестация оставила записи в журнале для обоих скоупов', new Set(runs.map((r) => r.scope)).size === 2, JSON.stringify(runs));
}
```

- [ ] **Step 2: Прогнать, убедиться в падении**

- [ ] **Step 3: Реализация `tools/catalog.mjs`**

```js
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

  const contents = new Map();
  for (const f of files) {
    const abs = resolve(root, f);
    if (existsSync(abs)) contents.set(normalizePath(f, root), readFileSync(abs, 'utf8').split(/\r?\n/));
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

  const unreadable = Array.isArray(result?.unreadable) ? result.unreadable : [];
  if (problems.length) return { ok: false, problems, evidence: [] };

  const evidence = [];
  for (const scope of ['ai-antipatterns', 'platform-antipatterns']) {
    const ids = examined.filter((id) => scopeOf(id) === scope);
    if (ids.length === 0) {
      evidence.push(`[qg skipped: layer=code, scope=${scope}, reason=not_applicable]`);
      recordRun({ scope, tool: TOOL, verdict: 'not_applicable', files, root });
      continue;
    }
    if (unreadable.length) {
      evidence.push(`[qg not_verified: dimension=${scope}, reason=unreadable, files=${unreadable.length}]`);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
```

Проверить сигнатуру `recordRun` и `normalizePath` в `tools/run-journal.mjs` (аргумент `root`) и при расхождении подстроиться под фактическую.

- [ ] **Step 4: Переключить словарь на инструмент**

В `tools/evidence-scopes.mjs` у `ai-antipatterns` и `platform-antipatterns` заменить `tool: null` на `tool: 'tools/catalog.mjs'`, комментарий обновить: «строку печатает `catalog.mjs attest` после сверки результата читателя с каталогом и файлами». Проверить, что `TOOL_BACKED` теперь их включает, а README называет оба скоупа (тест «README называет все проверки с инструментом»): добавить их в таблицу инструментальных проверок README.

- [ ] **Step 5: Прогнать всё**

Run: `node tests/run-tests.mjs && node tools/validate-package.mjs`

- [ ] **Step 6: Commit**

```bash
git add tools/catalog.mjs tools/evidence-scopes.mjs tests/run-tests.mjs README.md
git commit -m "feat(каталог): аттестация результата читателя — след и журнал печатает инструмент

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8: Субагент `antipattern-reader`

**Files:**
- Create: `agents/antipattern-reader.md`
- Modify: `skills/bsl-code-review/SKILL.md` (Слой 1б, пункты 1 и 2 → один пункт «Каталог антипаттернов»)
- Modify: `skills/quality-gate/SKILL.md` (таблица субагентов: строка; таблица инструментов: строка `ai-antipatterns`, `platform-antipatterns` → `tools/catalog.mjs`)
- Test: `tests/run-tests.mjs` (`mustContain`)

- [ ] **Step 1: Тест**

Добавить в `mustContain`:

```js
  ['agents/antipattern-reader.md', 'quote', 'читатель обязан цитировать строку кода'],
  ['agents/antipattern-reader.md', 'catalog.mjs index', 'читатель получает индекс из инструмента'],
  ['skills/bsl-code-review/SKILL.md', 'antipattern-reader', 'контур кода делегирует проход по каталогу читателю'],
  ['skills/bsl-code-review/SKILL.md', 'catalog.mjs attest', 'контур кода аттестует результат читателя'],
  ['skills/quality-gate/SKILL.md', 'antipattern-reader', 'оркестратор знает субагента-читателя'],
  ['skills/quality-gate/SKILL.md', 'tools/catalog.mjs', 'оркестратор называет инструмент аттестации'],
```

Проверить в блоке «навык не читает семантический свод дешёвой моделью»:

```js
  check('верификатор не грузит каталог антипаттернов', !readFileSync(join(ROOT, 'agents', 'bsl-verifier.md'), 'utf8').includes('catalog/'));
  check('читатель работает не на haiku', /^model:\s*(sonnet|opus|inherit)/m.test(readFileSync(join(ROOT, 'agents', 'antipattern-reader.md'), 'utf8')));
```

- [ ] **Step 2: Агент**

`agents/antipattern-reader.md`:

```markdown
---
name: antipattern-reader
description: >-
  Читатель каталога антипаттернов контура кода. Получает индекс триггеров и список
  изменённых файлов, сверяет код с каждым активным признаком без инструмента и возвращает
  результат в JSON: что проверял, что нашёл, с файлом, строкой и дословной цитатой. Не
  знает формулировки задачи и своих выводов не смягчает. НЕ ревьюит логику и архитектуру,
  НЕ добавляет находок по признакам с инструментом, НЕ правит файлы.

  Примеры вызова:

  <example> Контекст: контур кода на классе C1 по одному общему модулю. user: "Проверь
  изменённые файлы по каталогу антипаттернов." assistant: "Запускаю antipattern-reader с
  индексом и списком файлов — вернёт JSON для catalog.mjs attest." <commentary>Проход по
  каталогу отделён от контекста оркестратора: читатель видит только индекс и код.</commentary>
  </example>
  <example> Контекст: архетип query, активны признаки по запросам. user: "Прогони каталог с
  архетипами query,transaction." assistant: "Запускаю antipattern-reader, индекс отфильтрован
  по архетипам." <commentary>Активный набор признаков задаёт инструмент, а не читатель.</commentary>
  </example>
model: sonnet
tools: Read, Grep, Glob
---

# antipattern-reader — читатель каталога

Ты получаешь: (1) индекс триггеров, напечатанный `node "$QG/tools/catalog.mjs" index
[--archetypes ...]`; (2) список файлов. Больше ничего о задаче ты не знаешь, и это условие
работы: читатель, узнавший намерение автора, читает код таким, каким он задуман, а не таким,
какой он есть.

## Порядок

1. Прочитай каждый файл из списка целиком. Файл, который не читается, попадает в `unreadable`.
2. Для каждого признака индекса с инструментом «чтение» пройди по всем методам файла и реши,
   срабатывает ли триггер. Признаки с инструментом пропускай: их находки печатает инструмент.
3. Сработал триггер — открой карточку (`node "$QG/tools/catalog.mjs" card <ID>` либо файл
   `references/catalog/<ID>.md` навыка `bsl-code-review`) и проверь секцию «Когда это не
   дефект». Законная форма — не находка.
4. Каждая находка несёт `file`, `line`, `method`, `quote` — дословную строку кода из файла
   (одна строка, без переносов), `note` — одна фраза, почему это дефект здесь.
5. Верни ровно один JSON без пояснений вокруг:

```json
{
  "examined": ["qg:AI-01", "…все признаки с инструментом «чтение» из индекса…"],
  "files": ["…все файлы из списка…"],
  "findings": [
    { "id": "qg:AI-07", "file": "src/.../Module.bsl", "line": 120, "method": "ПодобратьЦены",
      "quote": "Функция ПодобратьЦены(ТаблицаТоваров)", "note": "метод только читает таблицу" }
  ],
  "unreadable": []
}
```

## Правила

- `examined` — все признаки индекса с инструментом «чтение», даже если ни один не сработал.
  Пропущенный признак делает результат недействительным: аттестация его отвергнет.
- Не придумывай строки: `quote` сверяется с файлом. Нет цитаты — нет находки.
- Не понижай и не повышай важность, не предлагай исправлений: это делает контур по карточке.
- Не смотри в другие файлы, историю и задачу. Индекс и код — весь твой вход.
```

- [ ] **Step 3: Контур кода**

В `skills/bsl-code-review/SKILL.md` пункты «1. Антипаттерны производительности…» и «2. Антипаттерны кода, порождаемого моделью» заменить одним:

```markdown
### 1. Каталог антипаттернов — субагент `antipattern-reader`

Индекс триггеров печатает инструмент, полная карточка читается по попаданию:

```bash
node "$QG/tools/catalog.mjs" index --archetypes <метки через запятую>
```

**Делегируй субагенту `antipattern-reader`**: передай ему вывод `index` и список изменённых
`.bsl`. Он не знает задачи и возвращает JSON — сохрани его в файл и аттестуй:

```bash
node "$QG/tools/catalog.mjs" attest --result <файл.json> --files <файл.bsl> ... --archetypes <метки>
```

Инструмент сверяет полноту списка проверенных признаков, состав файлов и цитату каждой
находки с самим файлом, после чего печатает строки следа `ai-antipatterns` и
`platform-antipatterns` и пишет журнал. Отвергнутый результат — повтори запуск читателя с
его замечаниями, не правь JSON руками. Читателя в среде нет — прогони индекс сам по той же
процедуре и аттестуй так же: строку следа в обоих случаях печатает инструмент.

Признаки с инструментом (`bsl-lint`, `query-lint`, `rename-check`) в проход не входят — их
строки печатают инструменты, а карточка нужна для «как чинить»:
`node "$QG/tools/catalog.mjs" card <ID>`.

Почему проход изолирован: 131 КБ двух прежних справочников в контексте оркестратора не давали
ни одной находки за 25 прогонов и не оставляли следа — разбор в
`../../docs/superpowers/specs/2026-09-07-context-routing-analysis.md`.
```

Инвариант 1 контура переписать: «**Каталог антипаттернов проходится всегда** — читателем либо самостоятельно, но след печатает `catalog.mjs attest`.»

- [ ] **Step 4: Оркестратор**

В `skills/quality-gate/SKILL.md`: таблица субагентов — строка `| antipattern-reader | контур code, каталог антипаттернов | кандидаты по индексу триггеров с цитатами; результат аттестует catalog.mjs | один на прогон контура |`; таблица инструментов — строка `| ai-antipatterns, platform-antipatterns | tools/catalog.mjs (аттестация результата читателя) |`.

- [ ] **Step 5: Бюджеты**: если `bsl-code-review/SKILL.md` вышел за 27 КБ, сжать за счёт удалённых таблиц антипаттернов, но не ниже смысла. Бюджет не повышать.

- [ ] **Step 6: Прогнать всё, commit**

```bash
node tests/run-tests.mjs && node tools/validate-package.mjs
git add agents/antipattern-reader.md skills/bsl-code-review/SKILL.md skills/quality-gate/SKILL.md tests/run-tests.mjs
git commit -m "feat(контур-кода): субагент-читатель каталога антипаттернов

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

# Часть D. Контрольные примеры и замер полноты

### Task 9: Контрольные примеры по каждой модельной карточке

**Files:**
- Create: `tests/recall/cases/<ID>/defect.bsl`, `clean.bsl`, `expected.json` для каждой карточки с `tool: null` (22 AI + 13 BSL)
- Test: `tests/run-tests.mjs` (секция «Контрольные примеры каталога — состав»)

`expected.json`:

```json
{ "defect": ["qg:AI-07"], "clean": [] }
```

Правила примера: `defect.bsl` — полный метод (`Процедура`/`Функция` … `КонецПроцедуры`/`КонецФункции`) от 15 строк с одним дефектом этого признака и без других дефектов каталога; `clean.bsl` — тот же метод в законной форме из секции «Когда это не дефект» или «Правильно» карточки. Источник: пара «Неправильно / Правильно» из карточки; если пары нет, написать по секции «Триггер». Файлы в UTF-8 с BOM (как настоящие модули; `hygiene-check` на них не гоняется).

- [ ] **Step 1: Тест состава**

```js
section('Контрольные примеры каталога — состав');

{
  const gen = await import(pathToFileURL(join(ROOT, 'tools', 'gen-catalog-index.mjs')).href);
  const casesDir = join(ROOT, 'tests', 'recall', 'cases');
  for (const c of gen.readCatalog().filter((x) => !x.tool)) {
    const dir = join(casesDir, c.id.replace(/^qg:/, ''));
    const ok = ['defect.bsl', 'clean.bsl', 'expected.json'].every((f) => existsSync(join(dir, f)));
    check(`${c.id}: контрольный пример на месте`, ok, dir);
    if (!ok) continue;
    const exp = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
    check(`${c.id}: expected называет сам признак`, Array.isArray(exp.defect) && exp.defect.includes(c.id) && Array.isArray(exp.clean) && exp.clean.length === 0);
    const defect = readFileSync(join(dir, 'defect.bsl'), 'utf8');
    check(`${c.id}: defect.bsl — полный метод от 15 строк`, defect.split('\n').length >= 15 && /Конец(Процедуры|Функции)/.test(defect));
  }
}
```

- [ ] **Step 2: Написать 35 пар** по правилам. Прогонять тест по ходу.

- [ ] **Step 3: Commit**

```bash
git add tests/recall tests/run-tests.mjs
git commit -m "test(каталог): контрольные примеры по каждой модельной карточке

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 10: Прогон читателя по контрольным примерам

**Files:**
- Create: `tests/recall.mjs`
- Modify: `docs/RELEASING.md`, `CONTRIBUTING.md`, `.gitignore` (`tests/recall/results/`)

- [ ] **Step 1: Зонд headless-режима** (один раз, результат фиксируется комментарием в скрипте)

```bash
claude -p "Ответь JSON" --output-format json --model sonnet --allowedTools "" --json-schema '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}'
```

Записать в комментарий `tests/recall.mjs`, в каком поле ответа лежит структурированный результат (ожидается `structured_output` в объекте с `"type":"result"`), и версию CLI (`claude --version`).

- [ ] **Step 2: Скрипт**

```js
#!/usr/bin/env node
/**
 * Замер полноты читателя каталога по контрольным примерам.
 *
 * Вопрос, на который отвечает: ловит ли проход по каталогу те дефекты, ради которых карточки
 * написаны. Без этого замера экономия контекста доказуема, а сохранность обнаружения — нет.
 *
 * Не входит в run-tests.mjs: нужен доступ к модели. Запускается по команде и перед релизом:
 *   node tests/recall.mjs [--cases "AI-*"] [--model sonnet] [--concurrency 4] [--min-recall 0.8]
 * Результат — tests/recall/results/<дата>.json; код 1, если полнота ниже порога или есть
 * находки на clean.bsl (ложные срабатывания считаются отдельно и тоже валят прогон при > 0.1).
 *
 * Headless-вызов: `claude -p` с --output-format json и --json-schema; проверено на
 * Claude Code <версия из зонда>, структурированный ответ лежит в поле <из зонда>.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readCatalog, renderIndex } from '../tools/gen-catalog-index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CASES = join(ROOT, 'tests', 'recall', 'cases');
const RESULTS = join(ROOT, 'tests', 'recall', 'results');

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] ?? true] : []).filter(Boolean));
const MODEL = args.model || 'sonnet';
const MIN_RECALL = Number(args['min-recall'] ?? 0.8);
const MAX_FP = Number(args['max-false-positive'] ?? 0.1);
const glob = args.cases ? new RegExp('^' + String(args.cases).replace(/\*/g, '.*') + '$') : null;

const SCHEMA = {
  type: 'object',
  properties: {
    examined: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' }, method: { type: 'string' }, quote: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'file', 'line', 'quote'] } },
    unreadable: { type: 'array', items: { type: 'string' } },
  },
  required: ['examined', 'files', 'findings', 'unreadable'],
};

const agentBody = readFileSync(join(ROOT, 'agents', 'antipattern-reader.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');
const cards = readCatalog().filter((c) => !c.tool);
const index = renderIndex(cards);

function ask(fileName, code) {
  const prompt = [
    'Индекс триггеров:', '', index, '',
    `Файл ${fileName}:`, '', '```bsl', code, '```', '',
    'Верни JSON по схеме.',
  ].join('\n');
  const r = spawnSync('claude', ['-p', prompt, '--output-format', 'json', '--model', MODEL, '--allowedTools', '', '--system-prompt', agentBody, '--json-schema', JSON.stringify(SCHEMA)], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`claude -p завершился с кодом ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  return out.structured_output ?? JSON.parse(out.result);
}

const rows = [];
for (const name of readdirSync(CASES).sort()) {
  if (glob && !glob.test(name)) continue;
  const dir = join(CASES, name);
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  for (const kind of ['defect', 'clean']) {
    const code = readFileSync(join(dir, `${kind}.bsl`), 'utf8').replace(/^\uFEFF/, '');
    const got = ask(`${name}/${kind}.bsl`, code);
    const found = [...new Set(got.findings.map((f) => f.id))];
    const want = expected[kind];
    rows.push({ case: name, kind, want, found, hit: want.every((id) => found.includes(id)), falsePositive: kind === 'clean' && found.length > 0 });
    process.stdout.write(`${rows.at(-1).hit && !rows.at(-1).falsePositive ? ' ok ' : 'FAIL'}  ${name}/${kind}  ожидалось [${want}] найдено [${found}]\n`);
  }
}

const defects = rows.filter((r) => r.kind === 'defect');
const recall = defects.filter((r) => r.hit).length / Math.max(defects.length, 1);
const cleans = rows.filter((r) => r.kind === 'clean');
const fpRate = cleans.filter((r) => r.falsePositive).length / Math.max(cleans.length, 1);
mkdirSync(RESULTS, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
writeFileSync(join(RESULTS, `${stamp}.json`), JSON.stringify({ model: MODEL, recall, fpRate, rows }, null, 2), 'utf8');
process.stdout.write(`\nПолнота: ${(recall * 100).toFixed(0)}% (порог ${MIN_RECALL * 100}%), ложные на чистых: ${(fpRate * 100).toFixed(0)}% (порог ${MAX_FP * 100}%)\n`);
process.exit(recall >= MIN_RECALL && fpRate <= MAX_FP ? 0 : 1);
```

- [ ] **Step 3: Прогнать на двух кейсах, затем на всех**

Run: `node tests/recall.mjs --cases "AI-07"` затем `node tests/recall.mjs`
Expected: печать по строке на пример, итог. Первый полный прогон — базовая линия; результат сохранить и **записать в отчёт по задаче число полноты и список промахов**. Промахи не «чинить» подгонкой примеров: это данные.

- [ ] **Step 4: Документация**

`docs/RELEASING.md`, раздел про прогон перед релизом: пункт «`node tests/recall.mjs` — полнота читателя каталога не ниже порога; результат прикладывается к описанию релиза одной строкой». `CONTRIBUTING.md`, раздел про новые антипаттерны: «Новая карточка приходит с парой `tests/recall/cases/<ID>/defect.bsl` и `clean.bsl`». `.gitignore`: `tests/recall/results/`.

- [ ] **Step 5: Commit**

```bash
git add tests/recall.mjs docs/RELEASING.md CONTRIBUTING.md .gitignore
git commit -m "test(каталог): замер полноты читателя по контрольным примерам

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

# Часть E. План прогона печатает инструмент, навыки ужимаются

### Task 11: `tools/profile.mjs` — таблица архетипов и расчёт профиля

**Files:**
- Create: `tools/profile.mjs`
- Test: `tests/run-tests.mjs` (новая секция «Профиль изменения считает инструмент»)

**Interfaces:**
- Produces: `ARCHETYPES` (массив `{label, markers: RegExp[], pathMarker?: RegExp, minCode: 'L1'|'L2', minArch: null|1|2|3, refs: string[]}`), `computeProfile({ files, root, config, metrics })` → `{ volume, files, loc: {added, removed}, archetypes: string[], complexity: string[], driver, resolved: {code, arch, xml, hygiene}, scopeLine }`.

Таблица архетипов переносится из `skills/quality-gate/SKILL.md` (колонки «Маркер в изменениях», «Мин. code», «Мин. arch») и «Стандарты под архетип» из `bsl-code-review/SKILL.md` (колонка `refs`):

```js
export const ARCHETYPES = [
  { label: 'query', markers: [/Новый\s+Запрос/i, /ВЫБРАТЬ\s/i], minCode: 'L2', minArch: null, refs: ['bsl-query-optimization.md', 'bsl-query-reference.md'] },
  { label: 'transaction', markers: [/НачатьТранзакцию/i, /Заблокировать\s*\(/i, /БлокировкаДанных/i], minCode: 'L2', minArch: null, refs: ['bsl-coding-standards.md'] },
  { label: 'record-set', markers: [/Записать\s*\(\s*Истина\s*\)/i, /СоздатьНаборЗаписей/i], minCode: 'L2', minArch: null, refs: [] },
  { label: 'object-event', markers: [/Процедура\s+(ПередЗаписью|ПриЗаписи|ОбработкаПроведения|ОбработкаУдаленияПроведения|ПередУдалением)\b/i], minCode: 'L2', minArch: 1, refs: [] },
  { label: 'integration', markers: [/HTTPСоединение/i, /WSПрокси/i, /Новый\s+COMОбъект/i], minCode: 'L2', minArch: 1, refs: [] },
  { label: 'rights', markers: [/УстановитьПривилегированныйРежим/i], pathMarker: /\/Roles\/[^/]+\/Ext\/Rights\.xml$/i, minCode: 'L2', minArch: 2, refs: [] },
  { label: 'cfe-patch', markers: [/&(Перед|После|Вместо|ИзменениеИКонтроль)\s*\(/i], minCode: 'L2', minArch: 1, refs: [] },
  { label: 'scheduled-job', markers: [/ФоновыеЗадания\./i, /РегламентныеЗадания\./i], pathMarker: /\/ScheduledJobs\//i, minCode: 'L2', minArch: null, refs: [] },
  { label: 'client-server', markers: [/&НаСервере(БезКонтекста)?\b/i, /&НаКлиенте(НаСервере)?\b/i], minCode: 'L1', minArch: 1, refs: [] },
  { label: 'user-dialog', markers: [/ПоказатьВопрос/i, /ВопросАсинх/i, /ОповещениеОЗавершении/i], minCode: 'L1', minArch: 1, refs: [] },
  { label: 'form-module', markers: [], pathMarker: /\/Forms?\/[^/]+\/(Ext\/Form\/)?Module\.bsl$/i, minCode: 'L1', minArch: 'loc>400', refs: ['bsl-form-module-rules.md'] },
  { label: 'async-client', markers: [/\bАсинх\b/i, /\bЖдать\b/i, /Обещание/i], minCode: 'L1', minArch: null, refs: ['bsl-async.md'] },
  { label: 'new-common-module', markers: [], newFile: /\/CommonModules\/[^/]+\/Ext\/Module\.bsl$/i, minCode: 'L1', minArch: 2, refs: ['bsl-coding-standards.md', 'bsp-common-modules.md'] },
  { label: 'new-metadata-object', markers: [], newFile: /\/src\/.*\.(xml|mdo)$/i, minCode: 'L1', minArch: 3, refs: [] },
];
```

Правила `computeProfile`: изменённые строки — `git diff --numstat HEAD -- <файл>` (новый файл без истории — все строки как добавленные, `newFile` считается истинным); маркеры ищутся в добавленных строках диффа (`git diff -U0 HEAD -- <файл>`, строки с `+`), `pathMarker` — по пути; объём: `C0` если только комментарии и пробелы (все добавленные строки начинаются с `//` или пусты), `C1` если `files ≤ config.volume.c1MaxFiles` и `added+removed ≤ config.volume.c1MaxLines`, `C3` если сработал `new-metadata-object` или `new-common-module`, иначе `C2`; сложность — из `metrics` (объект `analyzer-run --json` → `metrics[file]`): `nesting:N` при `N ≥ maxNesting`, `method-lines:N`, `params:N`; итог по формуле `max(по объёму, максимум минимумов архетипов, по сложности)`; `driver` — первый по порядку: `complexity:<метрика>`, если сложность подняла итог выше объёма и архетипов, иначе `archetype:<label>`, если архетип поднял, иначе `volume`. `scopeLine` — готовая строка `[qg scope: …, config=<из config.mjs>]` (`config` берётся функцией `configStamp` из `tools/config.mjs`, см. её экспорт около строки 254).

- [ ] **Step 1: Тест**

```js
section('Профиль изменения считает инструмент');

{
  const prof = await import(pathToFileURL(join(ROOT, 'tools', 'profile.mjs')).href);
  const root = join(WORK, 'profile-root');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'src', 'cf', 'CommonModules', 'Модуль', 'Ext'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
  const file = 'src/cf/CommonModules/Модуль/Ext/Module.bsl';
  writeFileSync(join(root, file), '\uFEFFПроцедура П() Экспорт\n\tЗапрос = Новый Запрос;\n\tНачатьТранзакцию();\nКонецПроцедуры\n', 'utf8');
  const config = { volume: { c1MaxLines: 40, c1MaxFiles: 1 }, complexity: { maxNesting: 4, maxMethodLines: 120, maxParams: 7 }, archetypes: { custom: [] } };
  const p = prof.computeProfile({ files: [file], root, config, metrics: {} });
  check('новый файл — все строки добавленные', p.loc.added >= 4, JSON.stringify(p.loc));
  check('архетипы query и transaction найдены', p.archetypes.includes('query') && p.archetypes.includes('transaction'), p.archetypes.join(','));
  check('объём C1, но code поднят архетипом до L2', p.volume === 'C1' && p.resolved.code === 'L2', JSON.stringify(p.resolved));
  check('driver называет архетип', /^archetype:(query|transaction)$/.test(p.driver), p.driver);
  check('строка scope готова и с config', /^\[qg scope: volume=C1, files=1, loc=\+\d+\/-\d+, archetypes=\[query,transaction\], .*config=default\]$/.test(p.scopeLine), p.scopeLine);

  const custom = { ...config, archetypes: { custom: [{ name: 'my-arch', markers: ['ОсобыйМаркер'], minCode: 'L2', minArch: '2' }] } };
  writeFileSync(join(root, file), '\uFEFFПроцедура П() Экспорт\n\tОсобыйМаркер();\nКонецПроцедуры\n', 'utf8');
  const p2 = prof.computeProfile({ files: [file], root, config: custom, metrics: {} });
  check('проектный архетип участвует', p2.archetypes.includes('my-arch') && p2.resolved.arch === 2, JSON.stringify(p2));
}
```

- [ ] **Step 2: Прогнать, падение** — Run: `node tests/run-tests.mjs 2>&1 | grep FAIL`

- [ ] **Step 3: Реализовать `tools/profile.mjs`** по правилам выше. `git` через `spawnSync` как в `tools/rename-check.mjs`; при отсутствии git весь файл считается добавленным и это отмечается полем `note: 'no_git'`.

- [ ] **Step 4: Прогнать всё, commit**

```bash
node tests/run-tests.mjs && node tools/validate-package.mjs
git add tools/profile.mjs tests/run-tests.mjs
git commit -m "feat(профиль): три оси считает инструмент, таблица архетипов — в коде

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 12: `gate.mjs plan`

**Files:**
- Modify: `tools/gate.mjs` (новая команда `plan`, вызов в `main`)
- Test: `tests/run-tests.mjs` (секция «План прогона печатает инструмент»)

**Interfaces:**
- Consumes: `computeProfile` из `tools/profile.mjs`; `SCOPES`, `TOOL_BACKED` из `tools/evidence-scopes.mjs`; `readCatalog` из `tools/gen-catalog-index.mjs`; `resolveConfig` из `tools/config.mjs`.
- Produces: `node tools/gate.mjs plan [--session <id>] [--files <f>...] [--json] [--no-analyzer]`.

Вывод (текст; `--json` — тот же состав объектом):

```
1c-quality-gate v3.6.0
Корень проекта: …
Сессия: <id> (файлов: N)

## Профиль
volume=C1 files=1 loc=+12/-3 archetypes=[query] complexity=[none] driver=archetype:query
resolved: code=L2 arch=skip xml=n/a hygiene=full
[qg scope: …]                                   ← перенести в отчёт дословно

## Инструменты (в этом порядке)
node "$QG/tools/hygiene-check.mjs" <файлы>
node "$QG/tools/analyzer-run.mjs" --changed <f> …
node "$QG/tools/platform-context-run.mjs" --changed <f> …
node "$QG/tools/query-lint.mjs" <f> …
node "$QG/tools/bsl-lint.mjs" <f> …
node "$QG/tools/rename-check.mjs" <f> …
node "$QG/tools/catalog.mjs" index --archetypes query      ← вход субагента antipattern-reader
node "$QG/tools/catalog.mjs" attest --result <json> --files <f> … --archetypes query

## Модельные проходы контура code (L2)
- каталог антипаттернов: субагент antipattern-reader, активных признаков: 27 (см. index выше)
- стандарты под архетип: references/bsl-query-optimization.md, references/bsl-query-reference.md; чеклист checklist-code.md разделы 6, 7
- api-verification: субагент bsl-verifier
- слой 2: advisor(); холодный читатель — нет (класс C1)

## Контур arch: skip (объём ниже порога, архетипы без минимума по arch)
## Контур xml: n/a (XML не менялся)

## Закрыть в следе
- query-execution (архетип query): applied либо not_verified reason=no_platform
- compilation: not_verified reason=no_platform, если платформа не запускалась
```

Соответствие «архетип → разделы чеклиста» задаётся в `profile.mjs` полем `checklist: [6, 7]` у `query`, `[8]` у `transaction`, `[9]` у `object-event`, `[10]` у `client-server`/`form-module`, `[12]` у `scheduled-job`, `[13, 14]` у `rights`, `[15]` у `integration`. Команды инструментов формируются из `SCOPES`: для каждого `TOOL_BACKED` инструмента, у которого есть файлы с подходящим `applies`, одна строка; порядок фиксированный массивом `TOOL_ORDER` в `gate.mjs`. Анализатор для метрик сложности: `plan` запускает `analyzer-run.mjs --json --changed …` сам, если не передан `--no-analyzer`; при ошибке — `complexity=[not_computed]` и строка «сложность не считалась: <причина>», `driver` тогда без `complexity`.

- [ ] **Step 1: Тест**

```js
section('План прогона печатает инструмент');

{
  const root = join(WORK, 'plan-root');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'src', 'cf', 'CommonModules', 'М', 'Ext'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
  writeFileSync(join(root, '.1c-quality-gate.json'), '{}', 'utf8');
  const file = 'src/cf/CommonModules/М/Ext/Module.bsl';
  writeFileSync(join(root, file), '\uFEFFПроцедура П() Экспорт\n\tЗапрос = Новый Запрос;\nКонецПроцедуры\n', 'utf8');
  const r = run('tools/gate.mjs', ['plan', '--files', file, '--no-analyzer', '--json'], { env: { QG_PROJECT_DIR: root } });
  check('plan завершается успешно', r.code === 0, r.out.slice(0, 300));
  const plan = JSON.parse(r.out);
  check('в плане есть строка scope', /^\[qg scope: /.test(plan.scopeLine), plan.scopeLine);
  check('в плане названы инструменты для .bsl', plan.tools.some((t) => /bsl-lint\.mjs/.test(t)) && plan.tools.some((t) => /query-lint\.mjs/.test(t)), plan.tools.join('\n'));
  check('в плане есть вход читателя с архетипом query', plan.tools.some((t) => /catalog\.mjs" index --archetypes query/.test(t)), plan.tools.join('\n'));
  check('справочники под архетип названы', plan.references.includes('bsl-query-optimization.md'), JSON.stringify(plan.references));
  check('требования к следу перечислены', plan.mustClose.includes('query-execution') && plan.mustClose.includes('compilation'), JSON.stringify(plan.mustClose));
  const text = run('tools/gate.mjs', ['plan', '--files', file, '--no-analyzer'], { env: { QG_PROJECT_DIR: root } });
  check('текстовый план содержит разделы', /## Профиль/.test(text.out) && /## Инструменты/.test(text.out), text.out.slice(0, 400));
}
```

- [ ] **Step 2: Прогнать, падение**

- [ ] **Step 3: Реализация** в `tools/gate.mjs`: функция `cmdPlan(args)`; список файлов — из `--files` либо из состояния сессии (`pickSession`, как в `verify`); `--json` печатает `{ profile, scopeLine, tools, references, checklist, modelPasses, contours, mustClose }`. Команды печатать с буквальным `$QG` (навык подставляет), в `--json` — так же.

- [ ] **Step 4: Прогнать всё, commit**

```bash
git add tools/gate.mjs tests/run-tests.mjs
git commit -m "feat(гейт): команда plan — профиль, команды и справочники печатает инструмент

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 13: Сверка заявленного профиля с расчётным при снятии гейта

**Files:**
- Modify: `tools/evidence-validator.mjs` (строгий режим, после сверки `config`)
- Test: `tests/run-tests.mjs`

Правило: в режиме `--gate` валидатор считает профиль сам (`computeProfile` по файлам сессии, без анализатора) и сравнивает с записью `scope`: заявленный `volume` ниже расчётного или заявленные `archetypes` не содержат расчётного архетипа — `warn` с текстом «модель вправе поднять глубину, но не понизить; следующим релизом это станет ошибкой». Расхождение вверх — не замечание.

- [ ] **Step 1: Тест** — в секции валидатора: след с `volume=C1, archetypes=[none]` на файле с `Новый Запрос` в 60 строках даёт `warn` про `archetypes` и про `volume`; след с `C2` и `[query]` — без предупреждений этого рода.

- [ ] **Step 2: Реализация** — блок в `validate()` внутри `if (gate)`, использует `ownSession(root, session)` для списка файлов (уже есть в валидаторе, строка ~277).

- [ ] **Step 3: Тесты, commit**

```bash
git commit -am "feat(валидатор): заявленный профиль сверяется с расчётным — понижать нельзя

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 14: Оркестратор ужимается до цикла

**Files:**
- Modify: `skills/quality-gate/SKILL.md`
- Modify: `skills/quality-gate/references/profile-axes.md` (принимает таблицы как обоснование)
- Modify: `commands/gate.md`, `hooks/gate-core.mjs` (`gateHint`: строка про `plan`)
- Modify: `tests/run-tests.mjs` (`BUDGET['quality-gate'] = 14 * 1024`, `mustContain`)

Новая структура `SKILL.md` (целевой размер ≤ 14 КБ):

1. Frontmatter и «Главное правило», ЖЁСТКИЙ-ШЛЮЗ — без изменений.
2. «Инварианты прогона» — восемь пунктов без изменений плюс девятый: «**План прогона печатает `gate.mjs plan`**; модель вправе поднять глубину с записанной причиной, понизить — нет».
3. «Шаг 1. План»: `QG` (блок разрешения пути переносится сюда из конца файла, без изменений), затем `node "$QG/tools/gate.mjs" plan` и что с выводом делать: строку `scope` перенести дословно; при несогласии с профилем поднять глубину и добавить в отчёт фразу «глубина поднята: <причина>».
4. «Шаг 2. Инструменты» — выполнить команды из плана в напечатанном порядке; строки следа переносятся дословно; «Перед повторным прогоном проверь `gate.mjs status`» и `verified_earlier` — абзац остаётся.
5. «Шаг 3. Контуры» — таблица «контур → навык» (4 строки) остаётся; «Контур исполняется вызовом навыка, а не по памяти» — абзац остаётся (на нём тест), таблица инструментов **удаляется** (её печатает план); таблица субагентов остаётся (4 строки); абзац про недоступность.
6. «Слой 3» — абзац без изменений.
7. «Шаг 4. Sentinel» — без изменений.
8. «Шаг 5. Отчёт и след», «Шаг 6. Снятие гейта» — без изменений, кроме удаления повторов, уже сказанных в плане.

Удаляемое переезжает в `references/profile-axes.md` как обоснование: три оси с прозой, таблица архетипов (с пометкой «источник истины — `tools/profile.mjs`, таблица здесь для чтения»), матрица глубин по объёму, правило разрешения, понижающий модификатор.

- [ ] **Step 1: Обновить тесты** — `mustContain`: пары `['skills/quality-gate/SKILL.md', 'archetypes.custom', …]`, `'volume.c1MaxLines'`, `'complexity.maxNesting'` перенаправить на `tools/profile.mjs` (там читаются ключи настройки); `'tools/query-lint.mjs'` (оркестратор называет инструменты поимённо) → на `tools/gate.mjs` с иглой `query-lint.mjs`; добавить `['skills/quality-gate/SKILL.md', 'gate.mjs" plan', 'оркестратор начинает с плана']`. Бюджет `14 * 1024` с комментарием-причиной. Тест достижимости справочников дополнить: справочник достижим, если его имя есть в SKILL.md **или** в `ARCHETYPES[*].refs` из `tools/profile.mjs`.

- [ ] **Step 2: Переписать навык и `profile-axes.md`.**

- [ ] **Step 3: `commands/gate.md`** — пункт 1 и 2 заменить: «Выполни `node "$QG/tools/gate.mjs" plan` и следуй напечатанному плану; профиль можно поднять, не понизить». `gateHint` в `hooks/gate-core.mjs` — после строки про Skill добавить `План прогона: node "<packageRoot>/tools/gate.mjs" plan`. Обновить соответствующий тест вывода хука, если он сверяет текст.

- [ ] **Step 4: Прогнать всё, commit**

```bash
node tests/run-tests.mjs && node tools/validate-package.mjs
git add -A
git commit -m "refactor(оркестратор): навык — инварианты и цикл, таблицы — в план и справочник

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 15: Контур кода ужимается, верификатор освобождается

**Files:**
- Modify: `skills/bsl-code-review/SKILL.md`
- Modify: `agents/bsl-verifier.md`
- Modify: `tests/run-tests.mjs` (`BUDGET['bsl-code-review'] = 16 * 1024`)

Изменения в `SKILL.md`: таблица признаков в п. 3 Слоя 1б удаляется (признаки и разбор — в `catalog/INDEX.md`, команды — в плане); остаются: команды п. 3 одной строкой «выполни строки плана для `query-lint`, `bsl-lint`, `rename-check`», абзацы про частичное покрытие `attribute-access`, про перенос записей дословно, про конкатенированные запросы; п. 4 «Стандарты под архетип» — таблица удаляется, остаётся: «справочники и разделы чеклиста называет план; тексты стандартов через `v8std`»; пп. 5–7, Слой 2, Слой 3, Автофикс, Выход — без изменений.

`bsl-verifier.md`: убедиться, что пункт про антипаттерны модели удалён (Task 5) и карта проверок не ссылается на каталог.

- [ ] **Step 1: Бюджет и `mustContain`** — `['skills/bsl-code-review/SKILL.md', 'qg:BSL-UNBOUNDED-STRING-COLUMN', …]` перенаправить на `catalog/INDEX.md`; `['skills/bsl-code-review/SKILL.md', 'tools/query-lint.mjs', …]` → на `tools/gate.mjs`.

- [ ] **Step 2: Переписать, прогнать, commit**

```bash
node tests/run-tests.mjs && node tools/validate-package.mjs
git add -A
git commit -m "refactor(контур-кода): таблицы признаков и справочников — в каталог и план

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 16: README, замер и версия

**Files:**
- Modify: `README.md` (разделы «Что проверяется», «Состав пакета», «Порядок прогона», «Расчёт глубины», «Скрипты», «Структура репозитория»)
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json` → `3.6.0`
- Modify: `CLAUDE.md` («Перед коммитом»: `node tools/gen-catalog-index.mjs`; «Раскладка»: `catalog/`)

- [ ] **Step 1: README** — «Порядок прогона», пункт 1–2: «`gate.mjs plan` печатает профиль, строку `scope`, команды инструментов и справочники под архетип; модель может поднять глубину, не понизить»; «Состав пакета»: строка про `antipattern-reader`, инструменты `catalog.mjs`, `profile.mjs`; «Расчёт глубины»: абзац «источник истины — `tools/profile.mjs`»; «Скрипты»: `gen-catalog-index.mjs`, `catalog.mjs`, `tests/recall.mjs`; «Структура репозитория»: `references/catalog/`.

- [ ] **Step 2: Замер горячего пути** — скриптом посчитать байты обязательного чтения на C1 и C2 по новой раскладке (оркестратор + контур кода + INDEX.md + evidence-format + hygiene + routing-contract; для C2 плюс навык архитектуры с картой) и записать числа в описание релиза и в `docs/superpowers/specs/2026-09-07-context-routing-analysis.md` разделом «Результат». Ожидание: C1 ≤ 110 КБ (было 249), C2 ≤ 190 КБ (было 363). Если не достигнуто — сказать прямо, где остался объём.

- [ ] **Step 3: Полный прогон читателя** — `node tests/recall.mjs`, число полноты в описание релиза.

- [ ] **Step 4: Версия 3.6.0** (MINOR: новые проверки, новые предупреждения валидатора, новая команда; удалённые справочники заменены каталогом без смены имён `scope`). Тег не ставить — это решение владельца.

- [ ] **Step 5: Прогнать всё, commit**

```bash
node tests/run-tests.mjs && node tools/validate-package.mjs && node tools/gen-catalog-index.mjs --check
git add -A
git commit -m "chore(релиз): v3.6.0 — маршрутизация знания по ярусам

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Самопроверка плана

**Покрытие спецификации.** Словарь и след — Tasks 2–3, 7. Карточки и индекс — Tasks 4–6. Читатель — Task 8. План прогона и профиль инструментом — Tasks 11–13. Ужатие навыков и переписывание тестов достижимости — Tasks 14–15. Контрольные примеры и замер — Tasks 9–10, 16. Освобождение верификатора — Tasks 5, 15. Двухшаговый ввод требований — Tasks 3, 13 (warn).

**Согласованность имён.** `readCatalog`, `renderIndex`, `INDEX_FILE`, `CATALOG_DIR` (Task 4) используются в Tasks 6, 7, 9, 10, 12. `attest`, `expectedExamined` (Task 7) — в Task 8 через CLI. `computeProfile`, `ARCHETYPES` (Task 11) — в Tasks 12–14. Скоупы `ai-antipatterns`, `platform-antipatterns` (Task 2) — в Tasks 3, 7, 8, 12.

**Что план не делает.** Не переносит арх-контур на карточки (у него уже `signs-map.json`); не трогает XML-контур; не ставит тег релиза; не включает `tests/recall.mjs` в CI.
