# Исключение тестовых модулей из гейта: план

**Spec:** `docs/superpowers/specs/2026-09-14-tests-exclusion-design.md`

Каждая задача — TDD: падающий тест, реализация, прогон `node tests/run-tests.mjs` и
`node tools/validate-package.mjs`, коммит.

1. **`tools/path-match.mjs`** — `normalizePattern`, `validatePatterns`, `matchesAny`.
   Тесты в `run-tests.mjs`: каталог без маски, `*`, `**`, `?`, регистр, кириллица, обратный
   слэш, `./` и хвостовой `/`; отказ на пустом, абсолютном, `..`, не-строке, не-массиве.
2. **Раздел `tests` в `tools/config.mjs`** — `DEFAULTS.tests.paths = []`, описание в
   `template()`. Тесты: раздел в шаблоне, умолчание, `config=custom:tests` при заданных путях.
3. **Взвод в `hooks/gate-core.mjs`** — параметр `readConfig`, исключение, снятие ранее
   взведённого, удаление опустевшей сессии. Передача `readConfig` из `hooks/gate-arm.mjs` и
   `opencode/plugin/quality-gate.js`. Тесты в `tests/gate-core.test.mjs`.
4. **План в `tools/gate.mjs`** — проверка `tests.paths` с отказом, раздел «Исключено
   настройкой проекта», подсказка YAxUnit, поля JSON `excludedPaths` и `yaxunitHint`.
   Тесты в `run-tests.mjs` через `gate.mjs plan --files` на временном проекте.
5. **Документация** — раздел `tests` в `docs/CONFIG.md`.
6. **Выпуск v3.8.0** по `docs/RELEASING.md`; раздел `tests` в конфиге TradeProd без
   коммита в его репозиторий.
