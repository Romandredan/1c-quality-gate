# Сходимость проходов гейта, выпуск v3.16.0: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ограничить цикл гейта тремя проходами, отделить находки вне правки от находок в правке, записать остаток в журнал снятий и довести его до пользователя в чате.

**Architecture:** Состояние сессии получает запись цикла (`cycle`): проходы, решения, время последнего сообщения пользователя. `gate.mjs run` ведёт счёт проходов и печатает таблицу задетых правкой методов; валидатор разбирает разделы отчёта и исключает «Вне правки» и «Нужно решение» из блокирующих; `release` переносит остаток в журнал снятий; Stop-хук и плагин OpenCode один раз показывают остаток пользователю. Субагент `gate-runner` и навык `quality-gate` получают новые разделы отчёта и правило классификации. Снимки и проход по разнице — следующий выпуск (v3.17.0), в этом плане их нет.

**Tech Stack:** Node.js ≥ 20 без зависимостей (ESM, `node:fs`, `node:child_process`), git, тесты — собственный `tests/run-tests.mjs` и наборы `tests/*.test.mjs` с функцией `check(name, cond, detail)`.

**Spec:** `docs/superpowers/specs/2026-10-01-gate-passes-convergence-design.md`

## Global Constraints

- Пути внутри плагина — только через `${CLAUDE_PLUGIN_ROOT}` (хуки) и `dirname(HERE)` (инструменты); абсолютных путей нет.
- Никаких проектных данных в пакете; проверка — `node tools/validate-package.mjs`.
- Все записи `qg-pending.json` и `qg-done.json` — под `withStateLock` из `tools/state-lock.mjs`, по свежему прочтению.
- Хук качества никогда не ломает работу: любая внутренняя ошибка хука — молча `exit 0`.
- Бюджет навыка `quality-gate` в `tests/run-tests.mjs` (`BUDGET`) — 14,5 КБ; при росте бюджет поднимается с обоснованием в комментарии, как сделано для прежних сдвигов.
- Потолок проходов — константа `MAX_PASSES = 3`; решение для четвёртого — `--decision`, не короче 20 символов (как `--critical-decision`).
- Строки `[qg …]` в отчёт печатают инструменты и валидатор, `run` ничего не сочиняет.
- Коммиты — по одному на задачу, сообщение по-русски в стиле `feat(гейт): …`, с хвостом `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Версия в манифестах поднимается только в последней задаче (`chore(релиз): v3.16.0`).

## Review Focus

1. Четвёртый `run` в цикле с `--decision` короче 20 символов — отказ с кодом 2 и состояние без изменений (Task 2).
2. Отчёт без разделов «Вне правки» и «Нужно решение» (прежний формат) — `release` проходит, `residual` содержит только находки в правке, ничего не падает (Task 6).
3. Файл без истории в HEAD (новый) — таблица «Задето правкой» печатает «весь файл (новый)», находки по нему никогда не помечаются «вне правки» (Task 4).
4. Stop-хук в сессии, которая гейт не взводила и ничего не снимала, при чужих записях в журнале снятий — сообщения нет, код 0 (Task 7).
5. Хук `UserPromptSubmit` в проекте без состояния гейта — ничего не создаёт на диске, код 0 (Task 3).

---

### Task 1: Запись цикла в состоянии сессии (`tools/gate-cycle.mjs`)

**Files:**
- Create: `tools/gate-cycle.mjs`
- Test: `tests/gate-core.test.mjs` (конец файла, перед `rmSync(outsideDir …)`)

**Interfaces:**
- Consumes: `withStateLock(stateDir, fn)` из `tools/state-lock.mjs`; `stateDirSegments(env)` из `tools/state-dir.mjs`; `PENDING` из `hooks/gate-core.mjs`.
- Produces:
  - `MAX_PASSES` — число `3`.
  - `passCount(session)` — число записей `cycle.passes` с `startedAt` позже `cycle.userPromptAt` (если `userPromptAt` нет — все).
  - `startPass(session, now)` — добавляет `{ n, startedAt: now, base: 'HEAD' }`, `n` — длина `passes` + 1; возвращает запись.
  - `notePrompt(session, now)` — ставит `cycle.userPromptAt = now`.
  - `acceptPass(session, { report, now })` — у последней записи `passes` ставит `report` и `acceptedAt`; без проходов ничего не делает, возвращает `false`.
  - `addDecision(session, { text, pass, now })` — добавляет в `cycle.decisions`.
  - `updateSession({ root, sessionId, env, mutate })` — читает `qg-pending.json` под замком, вызывает `mutate(session, state)` для сессии `sessionId` (создавать сессию не умеет: нет сессии — возвращает `null`, ничего не пишет), записывает состояние, возвращает результат `mutate`.

- [ ] **Step 1: Напиши падающий тест**

Добавь в `tests/gate-core.test.mjs` перед строкой `rmSync(outsideDir, { recursive: true, force: true });`:

```js
// --- Цикл гейта: проходы, решения, сообщение пользователя ---
{
  const { MAX_PASSES, passCount, startPass, notePrompt, acceptPass, addDecision, updateSession } = await import('../tools/gate-cycle.mjs');
  const cr = mkdtempSync(join(tmpdir(), 'qg-core-cycle-'));
  const f = join(cr, 'src', 'CommonModules', 'Ц', 'Module.bsl');
  mkdirSync(join(cr, 'src', 'CommonModules', 'Ц'), { recursive: true });
  writeFileSync(f, 'Процедура Ц() КонецПроцедуры\n', 'utf8');
  armGate({ root: cr, filePath: f, sessionId: 'c1', env: {} });

  check('потолок проходов — три', MAX_PASSES === 3);
  const session = { files: {} };
  check('у новой сессии проходов нет', passCount(session) === 0);
  const p1 = startPass(session, '2026-10-01T10:00:00.000Z');
  check('первый проход получает номер 1 и базу HEAD', p1.n === 1 && p1.base === 'HEAD' && session.cycle.passes.length === 1);
  startPass(session, '2026-10-01T10:30:00.000Z');
  check('проходы считаются', passCount(session) === 2);
  notePrompt(session, '2026-10-01T10:40:00.000Z');
  check('сообщение пользователя сбрасывает счёт, записи остаются', passCount(session) === 0 && session.cycle.passes.length === 2);
  startPass(session, '2026-10-01T10:50:00.000Z');
  check('после сообщения считаются только новые проходы', passCount(session) === 1 && session.cycle.passes[2].n === 3);
  check('принятый отчёт записывается в последний проход', acceptPass(session, { report: 'C:/t/r.md', now: '2026-10-01T11:00:00.000Z' }) === true && session.cycle.passes[2].report === 'C:/t/r.md');
  check('без проходов принимать нечего', acceptPass({ files: {} }, { report: 'x', now: 'n' }) === false);
  addDecision(session, { text: 'Пользователь: четвёртый проход разрешён', pass: 4, now: '2026-10-01T11:10:00.000Z' });
  check('решение записано', session.cycle.decisions[0].pass === 4);

  const r = updateSession({ root: cr, sessionId: 'c1', env: {}, mutate: (s) => startPass(s, '2026-10-01T12:00:00.000Z').n });
  check('updateSession меняет сессию в состоянии под замком', r === 1 && readPendingState(cr, {}).sessions.c1.cycle.passes.length === 1);
  check('updateSession чужой сессии ничего не создаёт', updateSession({ root: cr, sessionId: 'нет', env: {}, mutate: () => 'x' }) === null && !readPendingState(cr, {}).sessions['нет']);
  rmSync(cr, { recursive: true, force: true });
}
```

- [ ] **Step 2: Убедись, что тест падает**

Run: `node tests/gate-core.test.mjs 2>&1 | tail -3`
Expected: набор падает на импорте — `Cannot find module '../tools/gate-cycle.mjs'`.

- [ ] **Step 3: Реализуй модуль**

Создай `tools/gate-cycle.mjs`:

```js
/**
 * Цикл гейта: проходы, решения, сообщение пользователя.
 *
 * Зачем. По журналам рабочего проекта сессия запускала проверку до девяти раз подряд: после
 * каждого прохода исправляла найденное, правка взводила гейт заново, и следующий проход был
 * полным. Потолок в три прохода на цикл делает это наблюдаемым и конечным; четвёртый проход
 * возможен только с записанным решением. Сообщение пользователя сбрасывает счёт: вмешавшись,
 * он начинает отсчёт заново, а записи проходов остаются — они нужны следующему выпуску как
 * база прохода по исправлению.
 *
 * Цикл — от взвода до снятия: `release` переносит `cycle` в журнал снятий, новый взвод после
 * снятия начинает запись заново. Спецификация:
 * docs/superpowers/specs/2026-10-01-gate-passes-convergence-design.md.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirSegments } from './state-dir.mjs';
import { withStateLock } from './state-lock.mjs';
import { PENDING } from '../hooks/gate-core.mjs';

export const MAX_PASSES = 3;

function cycleOf(session) {
  if (!session.cycle) session.cycle = { passes: [], decisions: [] };
  session.cycle.passes = session.cycle.passes || [];
  session.cycle.decisions = session.cycle.decisions || [];
  return session.cycle;
}

/** Проходы после последнего сообщения пользователя — именно они идут в счёт потолка. */
export function passCount(session) {
  const c = session?.cycle;
  if (!c?.passes?.length) return 0;
  const since = c.userPromptAt ? Date.parse(c.userPromptAt) : -Infinity;
  return c.passes.filter((p) => Date.parse(p.startedAt) > since).length;
}

export function startPass(session, now = new Date().toISOString()) {
  const c = cycleOf(session);
  const pass = { n: c.passes.length + 1, startedAt: now, base: 'HEAD' };
  c.passes.push(pass);
  return pass;
}

export function notePrompt(session, now = new Date().toISOString()) {
  cycleOf(session).userPromptAt = now;
}

export function acceptPass(session, { report, now = new Date().toISOString() }) {
  const c = session?.cycle;
  if (!c?.passes?.length) return false;
  const last = c.passes[c.passes.length - 1];
  last.report = report;
  last.acceptedAt = now;
  return true;
}

export function addDecision(session, { text, pass, now = new Date().toISOString() }) {
  cycleOf(session).decisions.push({ at: now, pass, text });
}

/**
 * Чтение-изменение-запись одной сессии под замком состояния. Сессии нет — null без записи:
 * цикл есть только у взведённой сессии, создавать её здесь значило бы взводить гейт мимо хука.
 */
export function updateSession({ root, sessionId, env = process.env, mutate }) {
  const stateDir = join(root, ...stateDirSegments(env));
  const pendingPath = join(stateDir, PENDING);
  if (!existsSync(pendingPath)) return null;
  return withStateLock(stateDir, () => {
    let state;
    try {
      state = JSON.parse(readFileSync(pendingPath, 'utf8'));
    } catch {
      return null;
    }
    const session = state?.sessions?.[sessionId];
    if (!session) return null;
    const result = mutate(session, state);
    writeFileSync(pendingPath, JSON.stringify(state, null, 2), 'utf8');
    return result;
  });
}
```

- [ ] **Step 4: Убедись, что тест проходит**

Run: `node tests/gate-core.test.mjs 2>&1 | tail -3`
Expected: `… пройдено, 0 провалено`.

- [ ] **Step 5: Зафиксируй**

```bash
git add tools/gate-cycle.mjs tests/gate-core.test.mjs
git commit -m "feat(гейт): запись цикла в состоянии сессии — проходы, решения, сообщение пользователя" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Счёт проходов в `gate.mjs run` и потолок с `--decision`

**Files:**
- Modify: `tools/gate.mjs` — `cmdRun` (после `const { files, sessionId, … } = ctx;`), `cmdStatus` (вывод по сессии), `main` (usage)
- Test: `tests/run-tests.mjs`, раздел `section('gate.mjs run — инструментальная фаза одним вызовом')` — новый блок после существующего

**Interfaces:**
- Consumes: `MAX_PASSES`, `passCount`, `startPass`, `addDecision`, `updateSession` из `tools/gate-cycle.mjs` (Task 1).
- Produces: строка вывода `run` вида `Проход 2 из 3 · база HEAD` в разделе `## Профиль`; отказ с кодом 2 и текстом «Потолок цикла: три прохода» без `--decision`; `cmdStatus` печатает `проходов в цикле: N из 3` после строки сессии.

- [ ] **Step 1: Напиши падающий тест**

В `tests/run-tests.mjs` после блока теста заглушки анализатора (конец раздела `run`) добавь:

```js
// Потолок проходов. Девять проходов подряд в одной сессии рабочего проекта — цикл «проход →
// исправить → проход» без участия пользователя. Три прохода на цикл; четвёртый — только с
// записанным решением, а сообщение пользователя начинает счёт заново.
{
  const pr = join(WORK, 'passes-root');
  rmSync(pr, { recursive: true, force: true });
  mkdirSync(join(pr, 'src', 'cf', 'CommonModules', 'М', 'Ext'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: pr });
  writeFileSync(join(pr, '.1c-quality-gate.json'), '{}', 'utf8');
  const bsl = 'src/cf/CommonModules/М/Ext/Module.bsl';
  writeFileSync(join(pr, bsl), BOM + 'Процедура П() Экспорт\n\tА = 1;\nКонецПроцедуры\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: pr });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: pr });
  writeFileSync(join(pr, bsl), BOM + 'Процедура П() Экспорт\n\tА = 2;\nКонецПроцедуры\n', 'utf8');
  const env = { CLAUDE_PROJECT_DIR: pr };
  execFileSync(process.execPath, [join(ROOT, 'hooks', 'gate-arm.mjs')], {
    input: JSON.stringify({ session_id: 'P1', cwd: pr, tool_input: { file_path: join(pr, bsl) } }), encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env },
  });
  const pendingOf = () => JSON.parse(readFileSync(join(pr, '.claude', '.state', 'qg-pending.json'), 'utf8')).sessions.P1;
  const runOnce = (extra = []) => run('tools/gate.mjs', ['run', '--session', 'P1', '--no-analyzer', '--only', 'hygiene-check', ...extra], { env });

  const r1 = runOnce();
  check('первый проход назван в выводе run', r1.code === 0 && /^Проход 1 из 3 · база HEAD/m.test(r1.out), r1.out.slice(0, 500));
  check('проход записан в цикл сессии', pendingOf().cycle?.passes?.length === 1 && pendingOf().cycle.passes[0].base === 'HEAD');
  runOnce();
  const r3 = runOnce();
  check('третий проход ещё разрешён', r3.code === 0 && /^Проход 3 из 3/m.test(r3.out));
  const st = run('tools/gate.mjs', ['status'], { env });
  check('status показывает счёт проходов', /проходов в цикле: 3 из 3/.test(st.out), st.out);

  const r4 = runOnce();
  check('четвёртый проход без решения отказывает', r4.code === 2 && /Потолок цикла/.test(r4.out) && /--decision/.test(r4.out), r4.out.slice(0, 400));
  check('отказ не записывает проход', pendingOf().cycle.passes.length === 3);
  const short = runOnce(['--decision', 'ок']);
  check('решение одной отпиской не принимается', short.code === 2 && /кто решил/i.test(short.out), short.out.slice(0, 300));
  const r4d = runOnce(['--decision', 'Пользователь: разрешил четвёртый проход после разбора находок']);
  check('четвёртый проход с решением идёт и решение записано',
    r4d.code === 0 && /^Проход 4 из 3/m.test(r4d.out) && pendingOf().cycle.decisions?.[0]?.pass === 4, r4d.out.slice(0, 300));

  // Сообщение пользователя — счёт заново (Task 3 проверяет сам хук; здесь — поле состояния).
  const p = join(pr, '.claude', '.state', 'qg-pending.json');
  const state = JSON.parse(readFileSync(p, 'utf8'));
  state.sessions.P1.cycle.userPromptAt = new Date(Date.now() + 1000).toISOString();
  writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
  const r5 = runOnce();
  check('после сообщения пользователя проход идёт без решения', r5.code === 0 && /^Проход 5 из 3/m.test(r5.out), r5.out.slice(0, 300));

  const noSession = run('tools/gate.mjs', ['run', '--files', bsl, '--no-analyzer', '--only', 'hygiene-check'], { env });
  check('run по --files без сессии цикл не ведёт', noSession.code === 0 && !/^Проход /m.test(noSession.out));
}
```

Замечание к тесту: `userPromptAt` ставится на секунду вперёд, потому что отметки проходов и сообщение могут попасть в одну миллисекунду; хук Task 3 ставит реальное время, и в живой работе сообщение всегда позже прохода.

- [ ] **Step 2: Убедись, что тест падает**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "FAIL|Пройдено"`
Expected: FAIL на «первый проход назван в выводе run» и следующих; остальные проверки зелёные.

- [ ] **Step 3: Реализуй счёт в `cmdRun`, вывод в `cmdStatus`, usage**

В `tools/gate.mjs` добавь импорт:

```js
import { MAX_PASSES, passCount, startPass, addDecision, updateSession } from './gate-cycle.mjs';
```

В `cmdRun` после строки `const { files, sessionId, rootDir, profile, bslFiles } = ctx;` вставь:

```js
  // Потолок цикла: три прохода без участия пользователя. Четвёртый — только с записанным
  // решением: цикл «проход → исправить → проход» иначе не кончается (девять подряд на рабочем
  // проекте). Запись прохода — до инструментов: прерванный прогон тоже проход.
  let passLine = null;
  if (sessionId) {
    const decision = typeof args.decision === 'string' ? args.decision.trim() : null;
    if (decision !== null && decision.length < 20) {
      process.stderr.write('Решение для прохода сверх потолка слишком короткое — назови, кто решил и что: «Пользователь: разрешил четвёртый проход, потому что …».\n');
      return 2;
    }
    const outcome = updateSession({
      root: rootDir,
      sessionId,
      mutate: (session) => {
        const done = passCount(session);
        if (done >= MAX_PASSES && decision === null) return { refused: done };
        const pass = startPass(session);
        if (done >= MAX_PASSES) addDecision(session, { text: decision, pass: pass.n });
        return { pass };
      },
    });
    if (outcome?.refused) {
      process.stderr.write(
        `Потолок цикла: три прохода без сообщения пользователя уже сделаны (${outcome.refused}) — четвёртый не запускается.\n` +
          'Либо сними гейт по последнему отчёту и отдай остаток пользователю, либо запусти с записанным решением:\n' +
          `  node gate.mjs run --session ${sessionId} --decision "<кто решил и что>"\n` +
          'Решение остаётся в журнале снятий.\n'
      );
      return 2;
    }
    if (outcome?.pass) passLine = `Проход ${outcome.pass.n} из ${MAX_PASSES} · база ${outcome.pass.base}`;
  }
```

В выводе профиля (`w('## Профиль\n'); for (const l of profileLines(ctx)) …`) добавь первой строкой раздела:

```js
  w('## Профиль\n');
  if (passLine) w(`${passLine}\n`);
```

В `cmdStatus` после цикла по файлам сессии (перед `if (files.some(([, meta]) => meta.source === 'shell'))`) добавь:

```js
    if (s.cycle?.passes?.length) {
      process.stdout.write(`  проходов в цикле: ${passCount(s)} из ${MAX_PASSES}${s.cycle.decisions?.length ? `, решений сверх потолка: ${s.cycle.decisions.length}` : ''}\n`);
    }
```

В usage `main` строку `run` замени на:

```js
          '  node gate.mjs run [--files <f> ...] [--only <инструмент,...>] [--no-analyzer] [--verbose] [--decision "<кто решил и что>"]\n' +
```

Если `run` вызван с `--files` (без сессии), `sessionId` равен `null`, и блок не выполняется.

- [ ] **Step 4: Убедись, что тесты проходят**

Run: `node tests/run-tests.mjs 2>&1 | tail -3`
Expected: `Пройдено: N, провалено: 0`.

- [ ] **Step 5: Зафиксируй**

```bash
git add tools/gate.mjs tests/run-tests.mjs
git commit -m "feat(гейт): потолок три прохода на цикл, четвёртый — с записанным решением" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Хук `UserPromptSubmit` сбрасывает счёт проходов

**Files:**
- Create: `hooks/gate-prompt.mjs`
- Modify: `hooks/hooks.json`
- Test: `tests/run-tests.mjs` — тот же блок, что в Task 2 (дописать в конец блока)

**Interfaces:**
- Consumes: `readPayload`, `projectRoot` из `hooks/_shared.mjs`; `notePrompt`, `updateSession` из `tools/gate-cycle.mjs`.
- Produces: событие `UserPromptSubmit` в `hooks/hooks.json`; хук пишет `cycle.userPromptAt` взведённой сессии и молчит во всех остальных случаях.

- [ ] **Step 1: Напиши падающий тест**

В конец блока теста потолка (Task 2) добавь:

```js
  // Хук сообщения пользователя: ставит отметку только взведённой сессии, в чужом проекте и
  // чужой сессии не делает ничего и не создаёт файлов.
  const prompt = (cwd, session) => execFileSync(process.execPath, [join(ROOT, 'hooks', 'gate-prompt.mjs')], {
    input: JSON.stringify({ session_id: session, cwd, hook_event_name: 'UserPromptSubmit', prompt: 'продолжай' }), encoding: 'utf8', stdio: 'pipe', env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  const before = pendingOf().cycle.userPromptAt;
  prompt(pr, 'P1');
  check('хук сообщения пользователя ставит отметку сессии', pendingOf().cycle.userPromptAt > before);
  prompt(pr, 'чужая');
  check('чужая сессия не появляется в состоянии', !JSON.parse(readFileSync(p, 'utf8')).sessions['чужая']);
  const empty = join(WORK, 'prompt-empty');
  rmSync(empty, { recursive: true, force: true });
  mkdirSync(empty, { recursive: true });
  prompt(empty, 'P1');
  check('в проекте без состояния хук ничего не создаёт', !existsSync(join(empty, '.claude')));
  const hooksJson = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  check('hooks.json подписан на UserPromptSubmit', JSON.stringify(hooksJson.hooks.UserPromptSubmit || []).includes('gate-prompt.mjs'));
```

- [ ] **Step 2: Убедись, что тест падает**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "FAIL|Пройдено"`
Expected: FAIL «хук сообщения пользователя ставит отметку сессии» (скрипта нет, execFileSync бросает — оберни вызов в блок, как `hook()` в тесте снятия при 🔴, если падение мешает дойти до проверок) и «hooks.json подписан».

- [ ] **Step 3: Реализуй хук и подписку**

Создай `hooks/gate-prompt.mjs`:

```js
#!/usr/bin/env node
/**
 * UserPromptSubmit-хук: сообщение пользователя начинает счёт проходов цикла заново.
 *
 * Потолок в три прохода (tools/gate-cycle.mjs) ограничивает автономный цикл «проход →
 * исправить → проход». Вмешавшийся пользователь — другой случай: он сам решил продолжать, и
 * отсчёт идёт с его сообщения. Записи проходов не стираются: следующий выпуск берёт из них базу
 * прохода по исправлению.
 *
 * Хук срабатывает на каждое сообщение в любом проекте, где включён плагин, поэтому работает
 * только с уже существующим состоянием и уже взведённой сессией; иначе — ничего, молча.
 */

import { readPayload, projectRoot } from './_shared.mjs';
import { notePrompt, updateSession } from '../tools/gate-cycle.mjs';

try {
  const payload = readPayload();
  if (payload?.session_id) {
    updateSession({ root: projectRoot(payload), sessionId: String(payload.session_id), mutate: (s) => notePrompt(s) });
  }
} catch {
  /* хук качества никогда не ломает работу пользователя */
}
process.exit(0);
```

В `hooks/hooks.json` добавь событие (рядом с `Stop`):

```json
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/gate-prompt.mjs\"",
            "timeout": 10
          }
        ]
      }
    ],
```

- [ ] **Step 4: Убедись, что тесты проходят**

Run: `node tests/run-tests.mjs 2>&1 | tail -3 && node tools/validate-package.mjs | tail -1`
Expected: `провалено: 0`; пакет без ошибок.

- [ ] **Step 5: Зафиксируй**

```bash
git add hooks/gate-prompt.mjs hooks/hooks.json tests/run-tests.mjs
git commit -m "feat(гейт): сообщение пользователя начинает счёт проходов заново" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Таблица «Задето правкой» и пометка «вне правки» в выводе инструментов

**Files:**
- Modify: `tools/profile.mjs` — `analyzeChangedMethods` (возврат), `computeProfile` (поле `touched`)
- Modify: `tools/gate.mjs` — `cmdRun` (раздел `## Задето правкой`, пометка строк вывода инструментов), новая функция `markOutside`
- Test: `tests/run-tests.mjs` — новый блок в разделе `run`

**Interfaces:**
- Consumes: `diffs[*].changedLines` (Set номеров строк рабочего дерева), `methodRanges(source)` → `[{ name, start, end, signature }]` — уже есть в `profile.mjs`.
- Produces: `computeProfile(...).touched` — объект `{ [rel]: { kind: 'methods'|'lines'|'whole', methods: [{ name, start, end }], ranges: [[from, to]] } }`; экспорт `touchedLine(touched, rel, line)` → `true`, если строка в правке (для неизвестного файла или `whole` — всегда `true`); `cmdRun` печатает раздел `## Задето правкой` и к строкам вывода инструментов вне правки дописывает ` ← вне правки`.

- [ ] **Step 1: Напиши падающий тест**

В `tests/run-tests.mjs`, в разделе `run`, новый блок:

```js
// Классификация «в правке / вне правки»: гейт проверяет правку, а не модуль. Находка в
// нетронутом методе не исправляется в этом цикле — она уходит в техдолг. Границу печатает
// run, чтобы субагент классифицировал модельные находки по той же таблице, а не на глаз.
{
  const tr = join(WORK, 'touched-root');
  rmSync(tr, { recursive: true, force: true });
  mkdirSync(join(tr, 'src', 'cf', 'CommonModules', 'М', 'Ext'), { recursive: true });
  mkdirSync(join(tr, 'src', 'cf', 'Catalogs'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: tr });
  writeFileSync(join(tr, '.1c-quality-gate.json'), '{}', 'utf8');
  const bsl = 'src/cf/CommonModules/М/Ext/Module.bsl';
  const xml = 'src/cf/Catalogs/Товары.xml';
  writeFileSync(join(tr, bsl), BOM + 'Процедура Старая() Экспорт\n\tА = 1;\nКонецПроцедуры\n\nПроцедура Новая() Экспорт\n\tБ = 1;\nКонецПроцедуры\n', 'utf8');
  writeFileSync(join(tr, xml), '<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject>\n<a/>\n<b/>\n</MetaDataObject>\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: tr });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: tr });
  writeFileSync(join(tr, bsl), BOM + 'Процедура Старая() Экспорт\n\tА = 1;\nКонецПроцедуры\n\nПроцедура Новая() Экспорт\n\tБ = 2;\n\tВ = 3;\nКонецПроцедуры\n', 'utf8');
  writeFileSync(join(tr, xml), '<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject>\n<a/>\n<c/>\n</MetaDataObject>\n', 'utf8');
  const fresh = 'src/cf/CommonModules/Н/Ext/Module.bsl';
  mkdirSync(join(tr, 'src', 'cf', 'CommonModules', 'Н', 'Ext'), { recursive: true });
  writeFileSync(join(tr, fresh), BOM + 'Процедура Н() Экспорт\nКонецПроцедуры\n', 'utf8');

  const { computeProfile, touchedLine } = await import(pathToFileURL(join(ROOT, 'tools', 'profile.mjs')).href);
  const prof = computeProfile({ files: [bsl, xml, fresh], root: tr, config: {}, metrics: {}, configState: null });
  check('профиль называет задетые методы с границами', prof.touched?.[bsl]?.methods?.some((m) => m.name === 'Новая' && m.start === 5), JSON.stringify(prof.touched));
  check('нетронутый метод в правку не входит', !touchedLine(prof.touched, bsl, 2) && touchedLine(prof.touched, bsl, 6));
  check('XML задет диапазонами строк hunk', prof.touched?.[xml]?.kind === 'lines' && touchedLine(prof.touched, xml, 4) && !touchedLine(prof.touched, xml, 3), JSON.stringify(prof.touched?.[xml]));
  check('новый файл задет целиком', prof.touched?.[fresh]?.kind === 'whole' && touchedLine(prof.touched, fresh, 1));
  check('неизвестный файл считается в правке — ошибка в громкую сторону', touchedLine(prof.touched, 'нет/такого.bsl', 1));

  const r = run('tools/gate.mjs', ['run', '--files', bsl, xml, fresh, '--no-analyzer', '--only', 'hygiene-check,bsl-lint'], { env: { QG_PROJECT_DIR: tr } });
  check('run печатает раздел «Задето правкой»', /## Задето правкой[\s\S]*Module\.bsl: Новая\(5[–-]8\)/.test(r.out), r.out.slice(0, 900));
  check('новый файл назван целиком', /Н\/Ext\/Module\.bsl: весь файл \(новый\)/.test(r.out));
  const { markOutside } = await import(pathToFileURL(join(ROOT, 'tools', 'gate.mjs')).href);
  check('строка вывода инструмента вне правки помечается', /← вне правки$/.test(markOutside(`${bsl}:2 — qg:X что-то`, prof.touched, [bsl, xml, fresh])));
  check('строка в правке не помечается', !/вне правки/.test(markOutside(`${bsl}:6 — qg:X что-то`, prof.touched, [bsl, xml, fresh])));
  check('строка без адреса не помечается', !/вне правки/.test(markOutside('итого: 2 находки', prof.touched, [bsl])));
}
```

`pathToFileURL` импортируй из `node:url` в шапке `tests/run-tests.mjs`, если его там нет. Экспорт `markOutside` из `tools/gate.mjs` требует, чтобы импорт файла не запускал `main`: добавь в конец `gate.mjs` ту же защиту, что в `evidence-validator.mjs`:

```js
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('gate.mjs')) {
  process.exit(main(process.argv));
}
```

(На Windows `process.argv[1]` содержит обратные слэши, поэтому проверка по хвосту имени — рабочая; при импорте из теста `argv[1]` — `run-tests.mjs`, и `main` не вызывается.)

- [ ] **Step 2: Убедись, что тест падает**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "FAIL|Пройдено"`
Expected: FAIL «профиль называет задетые методы» и далее.

- [ ] **Step 3: Реализуй `touched` в профиле**

В `tools/profile.mjs`:

1. `analyzeChangedMethods` собирает границы. После `const touchedBodies = [];` добавь `const touched = {};`, внутри цикла по методам после `touchedBodies.push(...)`:

```js
      (touched[d.rel] = touched[d.rel] || { kind: 'methods', methods: [], ranges: [] }).methods.push({ name: method.name, start: method.start, end: method.end });
```

и верни `{ touchedCount, touchedBodies, newMethods, signatureChanges, touched }`.

2. Добавь функции (рядом с `allLineNumbers`):

```js
/** Сжатие множества номеров строк в диапазоны [[от, до], …] по возрастанию. */
function rangesOf(set) {
  const sorted = [...set].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/**
 * Задето ли строкой то, чего правка касалась. Файл без записи — в правке: пометить «вне
 * правки» то, чьи границы неизвестны, значило бы спрятать находку.
 */
export function touchedLine(touched, rel, line) {
  const t = touched?.[String(rel).split('\\').join('/')];
  if (!t || t.kind === 'whole') return true;
  const n = Number(line);
  if (!Number.isFinite(n)) return true;
  if (t.kind === 'methods') return t.methods.some((m) => n >= m.start && n <= m.end);
  return t.ranges.some(([a, b]) => n >= a && n <= b);
}
```

3. В `computeProfile` после `const methodAnalysis = analyzeChangedMethods(diffs, root);`:

```js
  // Граница правки по файлам: методы (BSL с историей), диапазоны строк (XML и прочее), весь
  // файл (новый или без git). По ней run и субагент делят находки на «в правке» и «вне правки».
  const touched = { ...methodAnalysis.touched };
  for (const d of diffs) {
    if (touched[d.rel]) continue;
    if (d.isNew || d.note === 'no_git') touched[d.rel] = { kind: 'whole', methods: [], ranges: [] };
    else touched[d.rel] = { kind: 'lines', methods: [], ranges: rangesOf(d.changedLines) };
  }
```

и добавь `touched` в возвращаемый объект `result`.

- [ ] **Step 4: Реализуй раздел и пометку в `run`**

В `tools/gate.mjs` добавь импорт `touchedLine` из `./profile.mjs` и функцию перед `cmdRun`:

```js
/**
 * Пометка строки вывода инструмента, адрес которой лежит вне правки: `<файл>:<строка>` либо
 * `<файл>(<строка>` по любому файлу сессии (совпадение по хвосту пути, регистр не важен).
 * Приближение заявлено: строка без адреса остаётся как есть.
 */
export function markOutside(line, touched, files) {
  for (const rel of files) {
    const base = String(rel).split(/[\\/]/).pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = line.match(new RegExp(`${base}[:(](\\d+)`, 'i'));
    if (!m) continue;
    return touchedLine(touched, rel, Number(m[1])) ? line : `${line} ← вне правки`;
  }
  return line;
}

function touchedLines(touched, files) {
  return files.map((rel) => {
    const t = touched?.[rel];
    if (!t || t.kind === 'whole') return `${rel}: весь файл (новый)`;
    if (t.kind === 'methods') return `${rel}: ${t.methods.map((m) => `${m.name}(${m.start}–${m.end})`).join(', ')}`;
    return `${rel}: строки ${t.ranges.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(', ')}`;
  });
}
```

В `cmdRun` после вывода профиля (`for (const l of profileLines(ctx)) w(…)`) добавь:

```js
  w('\n## Задето правкой\n');
  w('Граница относительно HEAD: находка по строке вне этих методов и диапазонов — «вне правки», в этом цикле не исправляется и гейт не держит.\n');
  for (const l of touchedLines(profile.touched, files)) w(`${l}\n`);
```

В выводе `## Вывод инструментов с находками и сбоями` строку `const cut = …` замени так, чтобы строки помечались:

```js
      const cut = (args.verbose === true ? lines : lines.slice(0, RUN_OUTPUT_LINES)).map((l) => markOutside(l, profile.touched, files));
```

- [ ] **Step 5: Убедись, что тесты проходят**

Run: `node tests/run-tests.mjs 2>&1 | tail -3`
Expected: `провалено: 0`. Если старые проверки раздела `run` сравнивают вывод по якорям — они по-прежнему проходят: новый раздел добавлен между профилем и инструментами, строки следа не менялись.

- [ ] **Step 6: Зафиксируй**

```bash
git add tools/profile.mjs tools/gate.mjs tests/run-tests.mjs
git commit -m "feat(гейт): граница правки по методам и строкам; пометка находок вне правки в выводе run" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Разделы отчёта в валидаторе и запись принятого отчёта в проход

**Files:**
- Modify: `tools/evidence-validator.mjs` — `NOT_FINDINGS`, новая `reportSections(text)` на базе `collectSevere`, `main` (запись принятия)
- Test: `tests/run-tests.mjs` — раздел валидатора (блок после теста `uncoveredFindings`/критичных находок; найди `section('` с «валидатор» и добавь новый блок в его конец)

**Interfaces:**
- Consumes: `acceptPass`, `updateSession` из `tools/gate-cycle.mjs`.
- Produces: экспорт `reportSections(text)` → `{ inChange: [{ sev, title, line }], outside: [...], needsDecision: [...] }` — все уровни 🔴/🟠/🟡; `severeFindings(text)` по-прежнему возвращает только 🔴/🟠 и только из `inChange`; CLI `--gate --session <id>` при нулевом коде возврата записывает путь отчёта в последний проход сессии.

- [ ] **Step 1: Напиши падающий тест**

```js
// Разделы отчёта: «Вне правки» и «Нужно решение» — не блокируют снятие, «Открыто в правке» —
// как раньше. Прежний формат (один список находок) разбирается как «в правке».
{
  const { reportSections, severeFindings } = await import(pathToFileURL(join(ROOT, 'tools', 'evidence-validator.mjs')).href);
  const text = [
    '# Отчёт', '', '## Вердикт', 'есть замечания: 🟠 1, 🟡 1; вне правки 2; нужно решение 1', '',
    '## Открыто в правке', '', '### 🟠 Запрос в цикле', 'Файл: M.bsl:40. Правило: qg:BSL-DB-READ-IN-LOOP', '',
    '### 🟡 Шапка расходится с кодом', 'Файл: M.bsl:12', '',
    '## Вне правки', '', '### 🔴 Потеря строки выборки в старом методе', 'Файл: M.bsl:300', '', '### 🟡 Магическое число', 'Файл: M.bsl:310', '',
    '## Нужно решение пользователя', '', '### 🟠 Поведение при пустом ответе сервиса не определено', 'Файл: M.bsl:55', '',
    '## Отклонённые кандидаты', '', '### 🔴 Ложная TypeMismatch', 'отклонена', '',
    '## quality evidence', '', '[qg scope: volume=C1, files=1, loc=+1/-0, archetypes=[none], driver=volume, resolved=code:L1|arch:skip|xml:n/a|hygiene:full]',
  ].join('\n');
  const s = reportSections(text);
  check('в правке — две находки с уровнями', s.inChange.length === 2 && s.inChange[0].sev === '🟠' && s.inChange[1].sev === '🟡', JSON.stringify(s.inChange));
  check('вне правки — две, включая 🔴', s.outside.length === 2 && s.outside[0].sev === '🔴', JSON.stringify(s.outside));
  check('нужно решение — одна', s.needsDecision.length === 1 && /пустом ответе/.test(s.needsDecision[0].title));
  check('отклонённые не считаются', !JSON.stringify(s).includes('Ложная TypeMismatch'));
  const severe = severeFindings(text);
  check('блокирующие — только из раздела в правке', severe.length === 1 && severe[0].sev === '🟠', JSON.stringify(severe));
  const legacy = '# Отчёт\n\n## Находки\n\n### 🔴 Одна\nФайл: M.bsl:1\n\n### 🟡 Две\nФайл: M.bsl:2\n\n## quality evidence\n';
  const l = reportSections(legacy);
  check('прежний формат — всё в правке', l.inChange.length === 2 && l.outside.length === 0 && l.needsDecision.length === 0);
}
```

Для записи принятого отчёта — в блок теста потолка (Task 2) после проверок `run` добавь:

```js
  // Принятый валидатором отчёт записывается в последний проход: следующему выпуску нужен путь
  // к прошлому отчёту для прохода по исправлению, а сессии — для списков остатка.
  const okReport = join(WORK, 'passes-accepted.md');
  writeFileSync(okReport, readFileSync(ev('valid.md'), 'utf8'), 'utf8');
  const v = run('tools/evidence-validator.mjs', [okReport, '--gate', '--session', 'P1'], { env });
  check('валидатор принял след фикстуры', v.code === 0, v.out.slice(0, 300));
  const lastPass = pendingOf().cycle.passes.at(-1);
  check('принятый отчёт записан в последний проход', lastPass.report === okReport && typeof lastPass.acceptedAt === 'string', JSON.stringify(lastPass));
```

(`ev('valid.md')` — существующая фикстура следа из тестов валидатора; проверь, что она проходит `--gate` на сессии с одним `.bsl`: тест снятия при 🔴 использует её так же.)

- [ ] **Step 2: Убедись, что тест падает**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "FAIL|Пройдено"`
Expected: FAIL на импорте `reportSections` (нет экспорта) и «принятый отчёт записан».

- [ ] **Step 3: Реализуй разбор разделов**

В `tools/evidence-validator.mjs`:

1. Константы:

```js
const NOT_FINDINGS = /отклон|не\s*провер|непровер|предложени|вне\s+правки|нужно\s+решени/i;
const OUTSIDE_SECTION = /вне\s+правки/i;
const DECISION_SECTION = /нужно\s+решени/i;
```

2. Переименуй `collectSevere` в `collectFindings` и расширь: каждая запись `stack` помимо `excluded` несёт `section`: `'outside'`, если заголовок или предок совпал с `OUTSIDE_SECTION`, `'decision'` — с `DECISION_SECTION`, иначе `'change'`; `excluded` считается по `NOT_FINDINGS` только когда `section === 'change'` (то есть «Вне правки» и «Нужно решение» не исключаются, а помечаются). Находки собираются всех уровней (`sev` любой из `SEVERITY_LEAD`), в объект находки добавь `section`. Внутри функции:

```js
    const parentSection = stack.map((s) => s.section).filter((x) => x && x !== 'change').pop() || null;
    const section = OUTSIDE_SECTION.test(title) ? 'outside' : DECISION_SECTION.test(title) ? 'decision' : parentSection || 'change';
    const entry = { level, section, excluded: stack.some((s) => s.excluded) || (section === 'change' && NOT_FINDINGS.test(title)) };
```

и `if (sev) { entry.finding = { title: …, sev, line: i + 1, body: [], section }; current = entry.finding; findings.push(entry.finding); }` — без фильтра `SEVERE`.

3. Экспорты:

```js
/** Находки прозы по разделам: в правке, вне правки, нужно решение. Все уровни. */
export function reportSections(text) {
  const all = collectFindings(text).map((f) => ({ sev: f.sev, title: f.title, line: f.line, section: f.section }));
  return {
    inChange: all.filter((f) => f.section === 'change'),
    outside: all.filter((f) => f.section === 'outside'),
    needsDecision: all.filter((f) => f.section === 'decision'),
  };
}

export function severeFindings(text) {
  return collectFindings(text)
    .filter((f) => f.section === 'change' && SEVERE.includes(f.sev))
    .map((f) => ({ title: f.title, sev: f.sev, line: f.line, ids: [...new Set(([f.title, ...f.body].join('\n').match(FINDING_ID) || []).map(normId))] }));
}
```

Комментарий над `collectFindings` дополни: раздел «Вне правки» — находки в коде, которого правка не касалась, гейт не держат по решению владельца (спецификация 2026-10-01); «Нужно решение» — то, что субагент оценить не может, уходит пользователю в итоге.

4. В `main` после расчёта `exitCode`, перед печатью итога:

```js
  // Принятый отчёт — часть записи прохода: по нему следующий проход проверяет закрытие находок,
  // а снятие печатает остаток. Пишется только в режиме гейта и только по названной сессии.
  if (gate && session && exitCode === 0) {
    try {
      updateSession({ root: root || projectRoot(), sessionId: session, mutate: (s) => acceptPass(s, { report: resolvePath(file) }) });
    } catch {
      /* запись прохода — удобство следующего прохода, не условие приёмки следа */
    }
  }
```

с импортами `import { resolve as resolvePath } from 'node:path';` и `import { acceptPass, updateSession } from './gate-cycle.mjs';`.

- [ ] **Step 4: Убедись, что тесты проходят**

Run: `node tests/run-tests.mjs 2>&1 | tail -3`
Expected: `провалено: 0`. Тест снятия при 🔴 (`critical.md` с заголовком `### 🔴 …` под `## Находки`) по-прежнему отказывает: раздел «Находки» — `change`.

- [ ] **Step 5: Зафиксируй**

```bash
git add tools/evidence-validator.mjs tests/run-tests.mjs
git commit -m "feat(след): разделы отчёта «вне правки» и «нужно решение» не блокируют снятие; принятый отчёт записывается в проход" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Остаток в журнале снятий и в выводе `release`

**Files:**
- Modify: `tools/gate.mjs` — `cmdRelease` (запись `record`, вывод)
- Test: `tests/run-tests.mjs` — блок теста снятия при 🔴 (`section` перед `run`): дописать проверки

**Interfaces:**
- Consumes: `reportSections` (Task 5).
- Produces: в записи журнала снятий поля `residual: { inChange: [{sev,title}], outside: [...], needsDecision: [...] }` и `cycle` (из состояния сессии; `null`, если проходов не было); вывод `release` печатает блок «Остаток».

- [ ] **Step 1: Напиши падающий тест**

В блок теста снятия при 🔴 после проверки `'🟠 без 🔴 решения не требует'` добавь:

```js
  const sectioned = report('sections.md', [
    '## Вердикт', 'есть замечания: 🟠 1; вне правки 1; нужно решение 1', '',
    '## Открыто в правке', '', '### 🟠 Запрос в цикле', 'Файл: Module.bsl:40. Правило: qg:BSL-DB-READ-IN-LOOP', '',
    '## Вне правки', '', '### 🔴 Потеря строки в старом методе', 'Файл: Module.bsl:300. Правило: qg:LOGIC-CASE-LOSS', '',
    '## Нужно решение пользователя', '', '### 🟡 Срок хранения не согласован', 'Файл: Module.bsl:12', '',
  ].join('\n'));
  arm();
  const relSections = run('tools/gate.mjs', ['release', '--evidence', sectioned, '--session', 'K1'], { env });
  check('🔴 вне правки гейт не держит', relSections.code === 0, relSections.out.slice(0, 400));
  check('release печатает остаток по разделам', /Остаток[\s\S]*в правке[\s\S]*🟠 1[\s\S]*вне правки[\s\S]*Потеря строки[\s\S]*нужно решение[\s\S]*Срок хранения/i.test(relSections.out), relSections.out);
  const recSections = JSON.parse(readFileSync(join(proj, '.claude', '.state', 'qg-done.json'), 'utf8')).sessions.K1;
  check('остаток записан в журнал снятий',
    recSections.residual?.inChange?.[0]?.sev === '🟠' && recSections.residual?.outside?.[0]?.title.includes('Потеря строки') && recSections.residual?.needsDecision?.length === 1, JSON.stringify(recSections.residual));
  check('запись цикла перенесена в журнал', 'cycle' in recSections);
```

- [ ] **Step 2: Убедись, что тест падает**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "FAIL|Пройдено"`
Expected: FAIL «release печатает остаток» и «остаток записан».

- [ ] **Step 3: Реализуй**

В `tools/gate.mjs` импортируй `reportSections` из `./evidence-validator.mjs` (рядом с `validate, severeFindings`). В `cmdRelease`:

1. После `criticalFindings = severeFindings(evidenceText)…` (внутри `if (evidenceFile)`) добавь `residual = reportSections(evidenceText);` — объяви `let residual = null;` рядом с `let criticalFindings = [];`.

2. В `record` добавь поля:

```js
    residual,
    cycle: sessionState.cycle || null,
```

3. Перед заключительным `process.stdout.write((evidenceFile ? …` добавь вывод:

```js
  if (residual) {
    const count = (list) => ['🔴', '🟠', '🟡'].map((s) => `${s} ${list.filter((f) => f.sev === s).length}`).join(' ');
    const titles = (list) => list.map((f) => `  ${f.sev} ${f.title}\n`).join('');
    process.stdout.write(
      `Остаток — покажи пользователю в завершающем сообщении:\n` +
        `  в правке: ${count(residual.inChange)}\n${titles(residual.inChange)}` +
        `  вне правки (техдолг, в этом цикле не исправлялось): ${residual.outside.length}\n${titles(residual.outside)}` +
        `  нужно решение пользователя: ${residual.needsDecision.length}\n${titles(residual.needsDecision)}`
    );
  }
```

- [ ] **Step 4: Убедись, что тесты проходят**

Run: `node tests/run-tests.mjs 2>&1 | tail -3`
Expected: `провалено: 0`.

- [ ] **Step 5: Зафиксируй**

```bash
git add tools/gate.mjs tests/run-tests.mjs
git commit -m "feat(гейт): остаток находок по разделам в журнале снятий и выводе release" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Итог пользователю: Stop-хук и `session.idle` OpenCode

**Files:**
- Modify: `hooks/gate-core.mjs` — новая `residualNote({ root, sessionId, env })`
- Modify: `hooks/gate-check.mjs` — печать `systemMessage`
- Modify: `opencode/plugin/quality-gate.js` — `event` (`session.idle`)
- Test: `tests/run-tests.mjs` (блок снятия при 🔴, конец), `tests/opencode-plugin.test.mjs`

**Interfaces:**
- Consumes: запись `residual` в `qg-done.json` (Task 6).
- Produces: `residualNote({ root, sessionId, env })` → строка сообщения либо `null`; при возврате строки ставит `relayedAt` в записи (под замком). Stop-хук печатает `{"systemMessage": "<строка>"}` и выходит с кодом 0; плагин OpenCode отправляет ту же строку сообщением в сессию.

- [ ] **Step 1: Напиши падающие тесты**

В конец блока снятия при 🔴 (`tests/run-tests.mjs`):

```js
  // Итог доходит до пользователя независимо от текста модели: первое завершение после снятия
  // печатает служебное сообщение со счётом остатка; второе — уже нет.
  const stopOut = (session) => {
    try {
      return execFileSync(process.execPath, [join(ROOT, 'hooks', 'gate-check.mjs')], { input: JSON.stringify({ session_id: session, cwd: proj }), encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } });
    } catch (e) {
      return `EXIT ${e.status}: ${e.stdout || ''}${e.stderr || ''}`;
    }
  };
  const first = stopOut('K1');
  check('Stop после снятия печатает остаток пользователю', /"systemMessage"/.test(first) && /в правке: 🔴 0, 🟠 1, 🟡 0/.test(first) && /вне правки 1/.test(first) && /нужно решение 1/.test(first) && /sections\.md/.test(first), first.slice(0, 500));
  const second = stopOut('K1');
  check('повторное завершение остаток не повторяет', !/systemMessage/.test(second), second.slice(0, 300));
  check('чужая сессия чужой остаток не видит', !/systemMessage/.test(stopOut('K9')));
```

В `tests/opencode-plugin.test.mjs` после проверок `session.idle` (строки ~79–90) добавь:

```js
// Итог после снятия: один раз сообщением в сессию, как systemMessage Stop-хука в Claude Code.
{
  const donePath = join(root, '.opencode', '.state', 'qg-done.json');
  mkdirSync(join(root, '.opencode', '.state'), { recursive: true });
  writeFileSync(donePath, JSON.stringify({ version: 2, sessions: { s7: { releasedAt: 'now', files: {}, mode: 'evidence', evidenceFile: 'C:/t/r.md', evidenceArchive: null,
    residual: { inChange: [{ sev: '🟡', title: 'Шапка' }], outside: [], needsDecision: [] } } } }), 'utf8');
  const before = client.prompts.length;
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's7' } } });
  check('idle после снятия отправляет остаток один раз', client.prompts.length === before + 1 && /в правке: 🔴 0, 🟠 0, 🟡 1/.test(JSON.stringify(client.prompts.at(-1))));
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's7' } } });
  check('повторный idle остаток не повторяет', client.prompts.length === before + 1);
}
```

(Переменные `root`, `plugin`, `client` — те, что заведены в начале набора; `mkdirSync`/`writeFileSync` там импортированы.)

- [ ] **Step 2: Убедись, что тесты падают**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "FAIL|Пройдено"; node tests/opencode-plugin.test.mjs 2>&1 | tail -2`
Expected: FAIL «Stop после снятия печатает остаток» и «idle после снятия отправляет остаток».

- [ ] **Step 3: Реализуй**

В `hooks/gate-core.mjs` добавь экспорт:

```js
/**
 * Итог снятого гейта для пользователя — один раз. Основной канал — завершающее сообщение
 * сессии по тексту передачи; это страховка на случай, когда модель списки сократила.
 * Возвращает строку и ставит `relayedAt`; нечего сказать или уже сказано — null.
 */
export function residualNote({ root, sessionId, env = process.env }) {
  const stateDir = join(root, ...stateDirSegments(env));
  const donePath = join(stateDir, DONE);
  if (!existsSync(donePath)) return null;
  return withStateLock(stateDir, () => {
    let done;
    try {
      done = JSON.parse(readFileSync(donePath, 'utf8'));
    } catch {
      return null;
    }
    const rec = done?.sessions?.[sessionId];
    if (!rec?.residual || rec.relayedAt) return null;
    const r = rec.residual;
    const count = (list) => ['🔴', '🟠', '🟡'].map((s) => `${s} ${list.filter((f) => f.sev === s).length}`).join(', ');
    rec.relayedAt = new Date().toISOString();
    writeFileSync(donePath, JSON.stringify(done, null, 2), 'utf8');
    return (
      `Гейт сессии снят. Остаток в правке: ${count(r.inChange)}; вне правки ${r.outside.length}; нужно решение ${r.needsDecision.length}. ` +
      `Отчёт: ${rec.evidenceArchive || rec.evidenceFile || '—'}`
    );
  });
}
```

В `hooks/gate-check.mjs` импортируй `residualNote` и в `main` в ветке `if (files.length === 0) { … return 0; }` перед `return 0` добавь:

```js
    const note = residualNote({ root: projectRoot(payload), sessionId });
    if (note) process.stdout.write(JSON.stringify({ systemMessage: note }) + '\n');
```

(`state` может быть `null` — тогда `main` выходит раньше строкой `if (!state) return 0;`; перенеси вызов `residualNote` и туда: после снятия последней сессии файла `qg-pending.json` нет, а остаток есть. Проще: вычисли `note` в начале `main` сразу после `readPayload`, до проверки состояния, и печатай его в обеих ветках с кодом 0.)

В `opencode/plugin/quality-gate.js` в начале обработчика `session.idle` после `if (!sessionId) return;`:

```js
        const note = core.residualNote({ root, sessionId, env: stateEnv });
        if (note) {
          await client.session.prompt({ path: { id: sessionId }, body: { parts: [{ type: 'text', text: `[ГЕЙТ КАЧЕСТВА 1С] ${note}` }] } }).catch(() => {});
          return;
        }
```

- [ ] **Step 4: Убедись, что тесты проходят**

Run: `node tests/run-tests.mjs 2>&1 | tail -3 && node tests/opencode-plugin.test.mjs 2>&1 | tail -1`
Expected: оба без провалов.

- [ ] **Step 5: Зафиксируй**

```bash
git add hooks/gate-core.mjs hooks/gate-check.mjs opencode/plugin/quality-gate.js tests/run-tests.mjs tests/opencode-plugin.test.mjs
git commit -m "feat(гейт): остаток после снятия доходит до пользователя служебным сообщением" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Тексты передачи, блокировки и подсказки

**Files:**
- Modify: `hooks/gate-core.mjs` — `handoffLines`, `blockMessage`, `gateHint`
- Modify: `hooks/gate-arm.mjs`, `hooks/gate-shell.mjs` — передача числа проходов в `gateHint`
- Test: `tests/gate-core.test.mjs` (раздел `blockMessage`)

**Interfaces:**
- Consumes: `passCount`, `MAX_PASSES` из `tools/gate-cycle.mjs`; `readPendingState`.
- Produces: `handoffLines({ sessionId, packageRoot, mode, passes = 0 })` — пункт 8 при `passes > 0`, абзац о находках вне правки и о трёх списках в завершающем сообщении; `blockMessage({ …, passes = 0 })` и `gateHint({ …, passes = 0 })` печатают «Проверка станет проходом N из 3».

- [ ] **Step 1: Напиши падающий тест**

В `tests/gate-core.test.mjs` после цикла `for (const [mode, bm] of [['claude', bmC], ['opencode', bmO]])`:

```js
// Цикл проходов в текстах: номер прохода и потолок, правило о находках вне правки, три списка
// в завершающем сообщении — сессия узнаёт их из текста передачи, другого канала к ней нет.
{
  const bm2 = blockMessage({ sessionId: 's1', files, packageRoot: root, mode: 'claude', passes: 2 });
  check('блокировка называет номер прохода и потолок', /проходом 3 из 3/.test(bm2));
  check('передача на повторном проходе требует отчёт по прошлым находкам', /8\. По каждой находке прошлого отчёта/.test(bm2));
  check('первый проход пункта 8 не требует', !/8\. По каждой/.test(bmC));
  for (const bm of [bmC, bm2]) {
    check('правило о находках вне правки', /вне правки[^\n]*не исправляй/i.test(bm));
    check('три списка в завершающем сообщении', /исправлено за цикл/i.test(bm) && /вне правки/i.test(bm) && /нужно решение/i.test(bm));
  }
  const bmCap = blockMessage({ sessionId: 's1', files, packageRoot: root, mode: 'claude', passes: 3 });
  check('после потолка названы два выхода', /потолок цикла/i.test(bmCap) && /--decision/.test(bmCap));
  const hint2 = gateHint({ kind: 'bsl', rel: 'a.bsl', sessionId: 'sess-1', packageRoot: root, mode: 'claude', passes: 1 });
  check('подсказка при взводе называет следующий проход', /проходом 2 из 3/.test(hint2));
}
```

- [ ] **Step 2: Убедись, что тест падает**

Run: `node tests/gate-core.test.mjs 2>&1 | grep -E "FAIL|пройдено"`
Expected: FAIL по всем новым проверкам.

- [ ] **Step 3: Реализуй тексты**

В `hooks/gate-core.mjs` импортируй `MAX_PASSES` из `../tools/gate-cycle.mjs` (циклического импорта нет: `gate-cycle` берёт из `gate-core` только константу `PENDING`; если Node сообщит о цикле — вынеси `PENDING`/`DONE` в `tools/state-dir.mjs` и импортируй оттуда в обоих).

`handoffLines({ sessionId, packageRoot, mode = 'claude', passes = 0 })` — после строки `'  7. Пути к спецификации, плану, задаче — если есть.',` добавь:

```js
    ...(passes > 0
      ? ['  8. По каждой находке прошлого отчёта: исправлена — как именно; не исправлена — почему. Субагент проверит причину по коду.']
      : []),
```

после `'Не оценивай свою работу…'`:

```js
    '',
    `Эта проверка станет проходом ${passes + 1} из ${MAX_PASSES} в цикле. Находки вне правки (раздел отчёта «Вне правки») не исправляй:`,
    'гейт проверяет правку, а не модуль; они уходят пользователю как техдолг.',
```

и в конец (после строки о недоступном субагенте):

```js
    '',
    'Заканчивай работу сообщением пользователю с тремя списками: исправлено за цикл; остаток в правке с твоей',
    'оценкой; вне правки и то, что требует его решения. Остаток печатает release — не сокращай его.',
```

В `blockMessage` добавь параметр `passes = 0`, передай его в `handoffLines`, а после блока `foreign` добавь:

```js
  if (passes >= MAX_PASSES) {
    lines.push(
      '',
      `Потолок цикла: проходов уже ${passes} из ${MAX_PASSES}. Либо сними гейт по последнему отчёту и отдай остаток пользователю,`,
      `либо запусти проверку с записанным решением: node "${toolPath('gate.mjs')}" run --session ${sessionId} --decision "<кто решил и что>"`
    );
  }
```

В `gateHint` добавь параметр `passes = 0` и после строки `call` в обоих вариантах (`bsl` и `metadata-xml`) вставь строку:

```js
          ...(passes > 0 ? [`Проверка после этой правки станет проходом ${passes + 1} из ${MAX_PASSES} в цикле.`] : []),
```

В `hooks/gate-arm.mjs` и `hooks/gate-shell.mjs` при вызове `gateHint` передай `passes: passCount(readPendingState(root)?.sessions?.[sessionId] || {})` (импорт `passCount` из `../tools/gate-cycle.mjs`, `readPendingState` из `./gate-core.mjs`). В `hooks/gate-check.mjs` передай в `blockMessage` `passes: passCount(sessions[sessionId])`. В `opencode/plugin/quality-gate.js` — то же для `blockMessage` и `gateHint` (`core.readPendingState`).

- [ ] **Step 4: Убедись, что тесты проходят**

Run: `node tests/gate-core.test.mjs 2>&1 | tail -1 && node tests/run-tests.mjs 2>&1 | tail -2`
Expected: без провалов. `cmdHandoff` в `gate.mjs` тоже передаёт `passes` (из состояния сессии), иначе `/gate` печатает текст первого прохода на повторном.

- [ ] **Step 5: Зафиксируй**

```bash
git add hooks/gate-core.mjs hooks/gate-arm.mjs hooks/gate-shell.mjs hooks/gate-check.mjs opencode/plugin/quality-gate.js tools/gate.mjs tests/gate-core.test.mjs
git commit -m "feat(гейт): номер прохода, правило о находках вне правки и три списка итога в текстах передачи" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Субагент `gate-runner` и навык `quality-gate`: разделы отчёта и классификация

**Files:**
- Modify: `agents/gate-runner.md` — «Порядок», «Ответ», новый раздел «Разделы отчёта»
- Modify: `skills/quality-gate/SKILL.md` — «Шаг 5. Отчёт и след»
- Modify: `tests/run-tests.mjs` — полнота правил `gate-runner` (список `needle`), бюджет `quality-gate`

**Interfaces:**
- Consumes: раздел `## Задето правкой` из `run` (Task 4), разделы отчёта валидатора (Task 5), строку `Проход N из 3` (Task 2).
- Produces: отчёт субагента с разделами «Открыто в правке», «Вне правки», «Нужно решение пользователя», «Отклонённые кандидаты»; ответ субагента со строками `Проход`, `Вне правки`, `Нужно решение`.

- [ ] **Step 1: Напиши падающие проверки полноты правил**

В `tests/run-tests.mjs` в список `needle` для `gate-runner` добавь:

```js
      ['## Вне правки', 'находки в нетронутом коде — отдельным разделом'],
      ['## Нужно решение пользователя', 'то, что субагент оценить не может, — отдельным разделом'],
      ['Задето правкой', 'классификация по таблице run, а не на глаз'],
      ['🔴 в правке никогда не попадает', '🔴 в правке остаётся блокирующим'],
      ['Вне правки:', 'ответ называет число находок вне правки'],
      ['Нужно решение:', 'ответ называет число находок, требующих решения'],
```

Бюджет `quality-gate` подними до `15 * 1024` с комментарием: «15 вместо 14,5 КБ: шаг 5 получил разделы отчёта „Вне правки“ и „Нужно решение“ — это формат, который проверяет валидатор и читает release; в справочник не выносится».

- [ ] **Step 2: Убедись, что проверки падают**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "FAIL|Пройдено"`
Expected: FAIL по шести новым строкам полноты правил.

- [ ] **Step 3: Допиши агент**

В `agents/gate-runner.md` в «Порядок» пункт 1 дополни: «`run` печатает номер прохода (`Проход N из 3`) и раздел `## Задето правкой` — границу правки по методам и строкам». Добавь после «Описание работы — утверждение автора, а не факт» раздел:

```markdown
## Разделы отчёта

Находки раскладываются по разделам, и валидатор читает их по заголовкам:

- `## Открыто в правке` — 🔴 / 🟠 / 🟡 с идентификаторами, как раньше. Строка находки попадает
  в методы и диапазоны из раздела `Задето правкой` вывода `run`.
- `## Вне правки` — находки любого уровня в коде, которого правка не касалась: проверяй по той же
  таблице, не на глаз. Гейт они не держат и в этом цикле не исправляются — уходят пользователю
  как техдолг. 🔴 вне правки помещай не сюда, а первым пунктом в «Нужно решение».
- `## Нужно решение пользователя` — то, что ты не можешь оценить сам: дефект ли это и насколько
  он важен (уровень «вопрос», низкая уверенность, зависимость от данных или договорённостей).
  🔴 в правке никогда не попадает сюда: он остаётся в «Открыто в правке» и снимается только
  исправлением либо решением пользователя через `--critical-decision`.
- `## Отклонённые кандидаты` — как раньше.

Находка без строки считается в правке. Вердикт называет уровни и числа — «есть замечания:
🟠 1, 🟡 4; вне правки 3; нужно решение 1» — без формулировок вроде «находка блокирует
вердикт „Чисто“»: снятие гейта требует только отсутствия 🔴 в правке.

На проходе 2 и 3 (номер печатает `run`) описание работы содержит пункт 8 — что сделано по
каждой находке прошлого отчёта. Сверяй его по коду так же, как остальные пункты.
```

В «Ответ» формат дополни строками после `🟡 находок:`:

```
Проход: N из 3
Вне правки: <число> — техдолг, подробно в отчёте
Нужно решение: <число> — подробно в отчёте
```

- [ ] **Step 4: Допиши навык**

В `skills/quality-gate/SKILL.md`, «Шаг 5. Отчёт и след», после первого абзаца («Отчёт для человека — находки по важности…») добавь:

```markdown
Находки — по разделам, валидатор читает их по заголовкам: `## Открыто в правке` (в методах и
диапазонах из `## Задето правкой` вывода `run`), `## Вне правки` (нетронутый код: гейт не держат,
в этом цикле не исправляются — техдолг пользователю; 🔴 вне правки — в «Нужно решение»),
`## Нужно решение пользователя` (что сам оценить не можешь; 🔴 в правке сюда не попадает).
Вердикт называет уровни и числа. Проходов на цикл — три (`run` печатает номер); четвёртый —
только с `--decision "<кто решил и что>"`.
```

- [ ] **Step 5: Убедись, что всё проходит**

Run: `node tests/run-tests.mjs 2>&1 | tail -3 && node tools/validate-package.mjs | tail -1`
Expected: без провалов, бюджет навыка в пределах, пакет без ошибок.

- [ ] **Step 6: Зафиксируй**

```bash
git add agents/gate-runner.md skills/quality-gate/SKILL.md tests/run-tests.mjs
git commit -m "feat(гейт): разделы отчёта «вне правки» и «нужно решение», номер прохода в агенте и навыке" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Документация

**Files:**
- Modify: `README.md` — раздел «Порядок прогона» (новый подраздел «Цикл проходов»), таблица команд `gate.mjs` (`--decision`), раздел «Файлы в проекте пользователя» (`cycle`, `residual`), таблица хуков (`UserPromptSubmit`)
- Modify: `docs/OPENCODE.md` — строка таблицы отличий об итоге после снятия и о сбросе счёта
- Modify: `docs/INSTALL.md` — диагностика: «Четвёртый проход не запускается»

- [ ] **Step 1: README, «Порядок прогона»**

После существующего нумерованного порядка добавь подраздел:

```markdown
### Цикл проходов

Цикл — от взвода гейта до снятия. Первый проход полный; после него сессия исправляет все
открытые находки в правке, с которыми согласна, и запускает следующий проход. Проходов на цикл
— три, четвёртый `gate.mjs run` не запускает без `--decision "<кто решил и что>"`; решение
остаётся в журнале снятий. Сообщение пользователя начинает счёт заново.

Находки делятся по границе правки, которую печатает `run` (`## Задето правкой`): в правке —
методы BSL и диапазоны строк XML, изменённые относительно HEAD; вне правки — остальное. Находки
вне правки гейт не держат на любом уровне и в этом цикле не исправляются: они уходят
пользователю как техдолг. 🔴 вне правки и находки, которые субагент не может оценить, попадают
в раздел «Нужно решение пользователя».

При снятии `release` переносит остаток — открытое в правке, вне правки, требующее решения — в
журнал снятий и печатает его; первое завершение после снятия показывает пользователю служебное
сообщение со счётом по уровням и путём к отчёту. Почему так — разбор журналов рабочего проекта в
[docs/superpowers/specs/2026-10-01-gate-passes-convergence-design.md](docs/superpowers/specs/2026-10-01-gate-passes-convergence-design.md).
```

- [ ] **Step 2: README, остальные места**

- В таблицу «Команды, субагенты и хуки» добавь строку: `| [`gate-prompt.mjs`](hooks/gate-prompt.mjs) | хук `UserPromptSubmit` | сообщение пользователя начинает счёт проходов цикла заново |`.
- В блок команд `gate.mjs` добавь: `node "$QG/tools/gate.mjs" run --session <id> --decision "<кто решил и что>"   # четвёртый проход цикла — только с записанным решением`.
- В раскладке `qg-pending.json` допиши «цикл: проходы и решения», в `qg-done.json` — «остаток находок по разделам».

- [ ] **Step 3: OPENCODE.md и INSTALL.md**

В таблицу отличий `docs/OPENCODE.md` добавь: `| Итог после снятия | `systemMessage` Stop-хука, один раз | сообщение плагина на `session.idle`, один раз |` и `| Сброс счёта проходов | хук `UserPromptSubmit` | нет — потолок действует без сброса |`.

В «Диагностика» `docs/INSTALL.md` добавь:

```markdown
**Четвёртый проход не запускается.** На цикл отведено три прохода. Либо снимите гейт по
последнему отчёту — остаток уйдёт в журнал снятий и в чат, — либо запустите проверку с
записанным решением: `node "$QG/tools/gate.mjs" run --session <id> --decision "<кто решил и что>"`.
Ваше сообщение в сессии начинает счёт заново.
```

- [ ] **Step 4: Проверь и зафиксируй**

Run: `node tools/validate-package.mjs | tail -1 && node tests/run-tests.mjs 2>&1 | tail -2`

```bash
git add README.md docs/OPENCODE.md docs/INSTALL.md
git commit -m "docs(гейт): цикл проходов, граница правки, остаток в журнале и в чате" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: A/B агента и навыка, выпуск v3.16.0

**Files:**
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`, `README.md`, `docs/OPENCODE.md`, `opencode/opencode.json.example` — версия `3.16.0`

- [ ] **Step 1: A/B до выпуска (правило памяти: менялись агент и навык)**

Две копии плагина через `git archive` (`v3.15.0` и ветка) с разными `name` в `plugin.json`, стенд — временный git-репозиторий с одним модулем и правкой, в которой есть находка в задетом методе и находка в нетронутом (например, запрос в цикле в старом методе). Запуск `claude -p --plugin-dir <копия>` на haiku-сессии, которая делегирует субагенту дословное задание; из `stream-json` считать вызовы инструментов субагента и цену. Сверить: новая версия кладёт находку нетронутого метода в «Вне правки», `release` проходит без `--critical-decision`, остаток напечатан; старая — находка в общем списке. Итог — таблицей «показатель × версия» в описании релиза. Ловушки — `~/.claude/projects/h---GitHub-1c-quality-gate/memory/headless-ab-pitfalls.md`.

- [ ] **Step 2: Версия и описание релиза**

Подними версию в шести файлах (`sed -i 's/3\.15\.0/3.16.0/g'` по списку из коммита `chore(релиз): v3.15.0`), прогони `node tests/run-tests.mjs` и `node tools/validate-package.mjs`, напиши описание по шаблону `docs/RELEASING.md` (вступление: три прохода на цикл, находки вне правки — в техдолг, итог в чат; «Новое» — путь модели по шагам; «Замеры» — A/B и числа тестов; «Совместимость»: ломающих нет, `recall.mjs` не переснимался — карточки каталога не менялись).

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json package.json README.md docs/OPENCODE.md opencode/opencode.json.example
git commit -m "chore(релиз): v3.16.0" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 3: PR, слияние, тег, обновление**

Как в v3.15.0: ветка на origin, PR через плагин GitHub, зелёный CI, слияние rebase (по явному слову владельца, если классификатор отклонит), аннотированный тег `v3.16.0` на коммите выпуска в `main` с описанием (`git tag -a v3.16.0 --cleanup=whitespace -F release-notes.md`), `git push origin v3.16.0`, проверка workflow `release`, `claude plugin marketplace update 1c-quality-gate` и `claude plugin update 1c-quality-gate@1c-quality-gate`, сквозная проверка хуков установленной версии на временном репозитории.
