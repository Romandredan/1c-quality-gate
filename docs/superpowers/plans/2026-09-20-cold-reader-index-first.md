# Холодный читатель и правило «сначала индекс» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вынести холодного читателя слоя 2 в отдельного субагента со свежим контекстом, дать читающим код субагентам доступ к MCP-индексу кода и обязать их идти в индекс раньше `Read`/`Grep`/`Glob`.

**Architecture:** Читающие код субагенты переходят с закрытого списка `tools` на список запретов `disallowedTools`: закрытый список в Claude Code отрезает MCP целиком, список запретов наследует всё, кроме записи и запуска. Правило «сначала индекс» живёт одним блоком в `shared/index-first.md`; тест сверяет, что блок дословно стоит в каждом таком агенте. Слой 2 контура `code` получает универсальный путь — холодного читателя, — а `advisor()` становится необязательным усилением.

**Tech Stack:** Node.js (ESM, без зависимостей), Markdown с frontmatter, тесты `tests/run-tests.mjs` и `tests/opencode-plugin.test.mjs`.

**Spec:** обсуждение 2026-09-20. Замер расхода по транскриптам боевого проекта: около 45 ходов основной модели на прогон при контексте сессии ~460k токенов (первая оценка «около ста» была завышена двойным счётом записей транскрипта), субагенты — около 6 % стоимости прогона. Связанное предложение 10 в рабочем документе автора с идеями доработок (в репозиторий не входит).

## Global Constraints

- Плагин публичный: имён проектов, баз и путей машин автора в артефакте нет. `code-index` допустим как пример имени MCP-сервера, не как требование.
- Пути — только через `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}`.
- Frontmatter — только поддерживаемые поля. `disallowedTools` поддерживается, в том числе у плагинных агентов (code.claude.com/docs/en/sub-agents: «Tools to deny, removed from inherited or specified list»). Закрытый `tools` MCP не наследует (там же).
- Все штатные субагенты — только читающие: без `Edit`, `Write`, без запуска субагентов.
- Бюджеты навыков: `bsl-code-review` ≤ 22 КБ, `quality-gate` ≤ 14 КБ. Обосновывающее уходит в `references/`.
- Списки валидатора выводятся из источника либо сверяются тестом; своих копий не заводить.
- Перед коммитом: `node tests/run-tests.mjs`, `node tools/validate-package.mjs`.
- Никаких счётчиков состава в документации.

## Файлы

| Файл | Что делает |
|---|---|
| `shared/index-first.md` (новый) | источник блока «сначала индекс» между маркерами и обоснование |
| `agents/cold-reader.md` (новый) | холодный читатель: вход, три вопроса, формат ответа, `model: opus` |
| `agents/bsl-scout.md`, `agents/bsl-verifier.md`, `agents/antipattern-reader.md` | `disallowedTools` вместо `tools`, блок индекса, снятый `rlm-tools-bsl` убран |
| `tools/validate-package.mjs` | `tools` **или** `disallowedTools`; без закрытого списка запрет `Edit` и `Write` обязателен; модель `fable` |
| `opencode/plugin/registry.js` | перевод `disallowedTools` в карту OpenCode |
| `skills/bsl-code-review/SKILL.md`, `references/cold-reader.md` | слой 2: читатель — субагент и универсальный путь |
| `skills/quality-gate/SKILL.md`, `tools/gate.mjs`, `tools/evidence-scopes.mjs` | таблица субагентов, строка плана слоя 2, описание скоупа |
| `README.md`, `docs/OPENCODE.md` | инвентарь, оговорка о модели читателя в OpenCode |

---

### Task 1: Валидатор пакета принимает список запретов

**Files:** Modify `tools/validate-package.mjs:39,298-300`; Test `tests/run-tests.mjs` (рядом с фикстурой `pkg-broken`, строка ~1676).

- [ ] Тест: агент с `disallowedTools: Edit, Write` без `tools` проходит; агент без обоих полей — ошибка «нет поля tools или disallowedTools»; агент с `disallowedTools: Bash` — ошибка «обязан запретить Edit и Write»; `model: fable` проходит.
- [ ] Прогон — тест падает.
- [ ] Реализация: `AGENT_MODELS` += `fable`; обязательные ключи `name`, `description`; есть `tools` — как раньше; иначе требуется `disallowedTools`, содержащий `Edit` и `Write`.
- [ ] Прогон — зелёный. Commit `feat(пакет): субагент задаётся списком запретов`.

### Task 2: Перевод списка запретов под OpenCode

**Files:** Modify `opencode/plugin/registry.js:157-178`; Test `tests/opencode-plugin.test.mjs:~185`.

- [ ] Тест: агент с `disallowedTools: Edit, Write, Bash` без `tools` даёт карту `read/grep/glob/skill = true`, `bash/edit/write = false`, `permission.edit = 'deny'`.
- [ ] Прогон — падает (сейчас все семь `false`).
- [ ] Реализация: если `tools` пусто и `disallowedTools` задано — `tools[k] = !denied.has(k)`; иначе прежняя логика.
- [ ] Прогон — зелёный. Commit `feat(opencode): перевод disallowedTools в карту инструментов`.

### Task 3: Блок «сначала индекс» и доступ агентов к MCP

**Files:** Create `shared/index-first.md`; Modify три агента; Test `tests/run-tests.mjs` (после строки ~2984).

Блок стоит между `<!-- index-first:begin -->` и `<!-- index-first:end -->`. Содержание: заголовок «Сначала индекс кода»; две обязательные проверки наличия до первого `Read`/`Grep`/`Glob` по коду (`ToolSearch` по имени `code-index`, затем по смыслу `bsl index symbol callers`; в OpenCode — просмотр списка инструментов по имени сервера); индекс найден — `Grep` и `Glob` по коду запрещены, `Read` только для файлов из входа и точечно по строкам из индекса; индекс не найден — первая строка ответа называет оба запроса и помечает перебор.

- [ ] Тест: у `bsl-scout`, `bsl-verifier`, `antipattern-reader` тело содержит блок из `shared/index-first.md` дословно; нет строки `tools:`; `disallowedTools` содержит `Edit`, `Write`, `Agent`; ни в одном файле `agents/` нет `rlm-tools-bsl`.
- [ ] Прогон — падает.
- [ ] Реализация: `shared/index-first.md` (блок и раздел «Почему дважды и почему жёстко»). Frontmatter: `bsl-scout` — `disallowedTools: Edit, Write, NotebookEdit, Bash, PowerShell, Agent`; `bsl-verifier` — `Edit, Write, NotebookEdit, Agent`; `antipattern-reader` — `Edit, Write, NotebookEdit, Bash, PowerShell, Skill, Agent`. Прежние разделы о `ToolSearch` и `rlm-tools-bsl` заменить блоком.
- [ ] Прогон — зелёный. Commit `fix(агенты): доступ к MCP-индексу и правило «сначала индекс»`.

### Task 4: Субагент `cold-reader`

**Files:** Create `agents/cold-reader.md`; Test `tests/run-tests.mjs`.

- [ ] Тест: файл есть; `model: opus`; `disallowedTools` содержит `Edit`, `Write`, `Bash`, `Skill`, `Agent`; в теле три вопроса, требование цитаты `quote`, запрет на вопросы о замысле; блок индекса дословно.
- [ ] Прогон — падает.
- [ ] Реализация: frontmatter по образцу `antipattern-reader`; тело: роль, вход (сравнение версий и пути изменённых файлов, ничего больше), блок индекса, три вопроса, формат ответа JSON `{read, findings: [{file, line, quote, question, claim, breaks_on, confidence}], not_checked}`, правила: без цитаты находки нет; замысел не угадывать и не запрашивать; код не править.
- [ ] Прогон — зелёный. Commit `feat(агенты): холодный читатель — отдельный субагент`.

### Task 5: Слой 2 — читатель как универсальный путь

**Files:** Modify `skills/bsl-code-review/SKILL.md:180-211`, `skills/bsl-code-review/references/cold-reader.md`, `skills/quality-gate/SKILL.md:127-141`, `tools/gate.mjs:854-861,906-907`, `tools/evidence-scopes.mjs:195-203`, `tools/evidence-validator.mjs:564-573` (только текст сообщения); Test `tests/run-tests.mjs`.

| Условие | Кто исполняет |
|---|---|
| C3 либо проведение, деньги, права, необратимое | `cold-reader` обязательно; `advisor()` дополнительно, если доступен |
| прочие L2, `advisor()` доступен | `advisor()` |
| прочие L2, `advisor()` недоступен | `cold-reader` вместо `skipped` |

Модель читателя: в файле `opus`; сессия на модели выше — оркестратор передаёт её параметром `model` при запуске. `skipped reason=advisor_unavailable` остаётся законным, только когда недоступны оба.

- [ ] Тест: навык называет `cold-reader` субагентом и параметр `model`; строка `gate.mjs plan` для L2 содержит `cold-reader`; существующие тесты на строку плана обновить.
- [ ] Прогон — падает.
- [ ] Реализация текстов; бюджет `bsl-code-review` держать, обоснование — в `references/cold-reader.md` (раздел «Почему отдельный субагент» с замером).
- [ ] Прогон — зелёный, включая сквозной тест «строка из plan → evidence-validator». Commit `feat(контур code): холодный читатель — универсальный путь слоя 2`.

### Task 6: Документация и выпуск

**Files:** `README.md:270,318-319,707`, `docs/OPENCODE.md:35`, версии в `.claude-plugin/plugin.json`, `package.json`.

- [ ] README: строка инвентаря `cold-reader`. `docs/OPENCODE.md`: оговорка — поле `model` в OpenCode не переносится, читатель идёт на модели сессии, пока модель агента не задана в конфигурации OpenCode; на слабой модели сессии задать её обязательно.
- [ ] `node tests/run-tests.mjs`, `node tools/validate-package.mjs` — зелёные.
- [ ] Версия 3.10.0, PR, после зелёного CI — слияние, тег, выпуск, обновление установленного плагина и проверка на проекте (`docs/RELEASING.md`).

## Что сознательно не входит

- `gate.mjs run` — отдельный план (предложение 1).
- Плоская схема контура `code` и агент разбора диагностик — отдельный план после `run`. Поправка к обсуждению: документация допускает вложенный запуск субагентов (до трёх уровней), поэтому вариант «контур — один агент-обёртка» снова рассматривается; проверить пробным запуском при планировании.
- Живая проверка того, что агент действительно идёт в индекс: состав агентов читается на старте сессии, поэтому она делается после выпуска на проекте.
