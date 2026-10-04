# Сходимость проходов гейта, выпуск v3.17.0: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Проход по исправлению проверяет только то, что изменилось со снимка прошлого прохода, и не теряет находки прошлого отчёта, — повторное чтение уже проверенного кода уходит.

**Architecture:** `gate.mjs run` при старте прохода записывает снимок (blob каждого файла сессии) и базу каждого файла: `HEAD` либо blob, проверенный прошлым принятым проходом (`files[rel].checked`). `profile.mjs` считает объём, архетипы и строки `scope` от этой базы, а границу правки («Задето правкой») — по-прежнему от `HEAD`. Валидатор, приняв отчёт по названной сессии, ставит файлам `checked`, сверяет заявленную базу и пересчитывает профиль от неё, разбирает раздел «Закрыто» и требует, чтобы каждая открытая находка прошлого отчёта нашлась в новом. Модельные слои на проходе по исправлению читают разницу от базы (`fix.diff`) и прошлый отчёт, а не файлы целиком.

**Tech Stack:** Node.js ≥ 20 без зависимостей (ESM, `node:fs`, `node:child_process`), git (`hash-object -w`, `cat-file`, `diff <blob> <blob>`), тесты — `tests/run-tests.mjs` и `tests/gate-core.test.mjs` с функцией `check(name, cond, detail)`.

**Spec:** `docs/superpowers/specs/2026-10-01-gate-passes-convergence-design.md` (разделы «Состояние», «Разница от базы», «Отчёт субагента», «Выпуск» → v3.17.0). Предыдущий план того же дизайна: `docs/superpowers/plans/2026-10-01-gate-passes-convergence-v3.16.md`.

## Global Constraints

- Пути внутри плагина — только через `${CLAUDE_PLUGIN_ROOT}` (хуки) и `dirname(HERE)` (инструменты); абсолютных путей нет.
- Никаких проектных данных в пакете; проверка — `node tools/validate-package.mjs`.
- Все записи `qg-pending.json` — под `withStateLock` из `tools/state-lock.mjs`, по свежему прочтению (`updateSession` из `tools/gate-cycle.mjs`).
- Хуки никогда не ломают работу: внутренняя ошибка хука — молча `exit 0`.
- «В правке» всегда считается относительно `HEAD`, а не относительно базы прохода (спецификация, раздел «Понятия»).
- Поле `base` записи `scope` необязательно: его отсутствие означает `HEAD`. В `REQUIRED` валидатора оно не добавляется — прежние отчёты проходят без правки (выпуск MINOR).
- Закрытые списки валидатора выводятся из источника: шаблон метки базы `SCOPE_BASE` экспортирует `tools/profile.mjs`, валидатор его импортирует; своя копия запрещена (CLAUDE.md, «Валидатор не отвергает собственный вывод плагина»).
- Снимок, которого нет в хранилище объектов git, — база `HEAD` с пометкой `base_missing`, а не ошибка. Файл вне git — `no_git`, каждый проход полный, как сейчас.
- Бюджет навыка `quality-gate` (`BUDGET` в `tests/run-tests.mjs`) сейчас 15,5 КБ при фактических 15 686 байтах. Обосновывающий текст прохода по исправлению уходит в новый справочник `skills/quality-gate/references/fix-pass.md`; исполняемое остаётся в навыке; бюджет поднимается до 16 КБ с комментарием-обоснованием. `bsl-code-review/SKILL.md` (22 439 из 22 528 байт) в этом выпуске не меняется.
- Строки `[qg …]` печатают инструменты и валидатор; `run` ничего не сочиняет.
- Коммиты — по одному на задачу, сообщение по-русски в стиле `feat(гейт): …`, с хвостом `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Версия в манифестах поднимается только в последней задаче (`chore(релиз): v3.17.0`).

## Review Focus

1. Снимок прошлого прохода убран сборкой мусора git (`git cat-file -e` ложно) — база файла `HEAD`, пометка `base_missing` в выводе `run`, проход идёт, ничего не падает (Task 1, Task 2).
2. Файл сессии удалён из рабочего дерева посреди цикла — `hash-object` не находит файла, blob `null`, база `HEAD`, без исключения (Task 1).
3. Файл изменён между `run` и валидатором — отчёт принят, `checked` этому файлу не поставлен, валидатор предупреждает, следующий проход считает файл от прошлой базы (Task 4).
4. Файл, новый относительно `HEAD` и не менявшийся со снимка, на проходе 2 даёт 0 строк, не включает архетип `new-common-module`, а в таблице «Задето правкой» остаётся «весь файл (новый)» (Task 2).
5. Неисправленная 🟡 прохода 1 отсутствует в отчёте прохода 2 — валидатор отказывает с именем находки; находка, перенесённая под «Закрыто», не блокирует снятие и не попадает в `residual` (Task 5).
6. Файл сессии вне корня проекта или вне git (ключ состояния — абсолютный путь) — база всегда `HEAD` с пометкой `no_git`, отметка `checked` не ставится, `run` не называет существующий файл удалённым (Task 1, Task 2).

---

### Task 1: Снимок и база прохода в состоянии сессии (`tools/gate-cycle.mjs`)

**Files:**
- Modify: `tools/gate-cycle.mjs`
- Test: `tests/gate-core.test.mjs` (новый блок после блока «Цикл гейта: проходы, решения, сообщение пользователя», перед `rmSync(outsideDir …)`)

**Interfaces:**
- Consumes: `withStateLock`, `stateDirSegments` (как сейчас); `spawnSync` из `node:child_process`.
- Produces:
  - `snapshotBlobs(root, files)` → `{ [rel]: sha | null }`. По каждому файлу `git hash-object -w <rel>` с `cwd: root`; сбой (файла нет, git недоступен, файл вне репозитория) — `null`.
  - `blobExists(root, sha)` → `boolean` (`git cat-file -e <sha>`, код 0).
  - `resolveBases({ session, blobs, root })` → `{ bases, label, notes }`:
    - `bases[rel]` — `'HEAD'` либо `{ pass: <n>, blob: <sha> }` из `session.files[rel].checked`;
    - `'HEAD'` с `notes[rel] = 'no_git'`, если файл вне корня (`isAbsolute(rel)` либо `rel.startsWith('..')`) или git недоступен (`git rev-parse --is-inside-work-tree` не 0) — проверяется первым;
    - `'HEAD'`, если `checked` нет, если текущий blob `null` или если blob из `checked` отсутствует в хранилище (тогда `notes[rel] = 'base_missing'`);
    - `notes[rel] = 'unchanged:<n>'`, если текущий blob равен blob базы `{ pass: n }` либо (для файла без `checked`) blob в `blobs` последнего прохода `n`;
    - `notes[rel] = 'deleted'`, если текущий blob `null` и файла нет на диске (`!existsSync(join(root, rel))`); blob `null` у существующего файла — `'no_git'`;
    - `label` — `'HEAD'`, если ни у одного файла нет blob-базы, иначе `pass:<максимальный n среди баз>`.
  - `startPass(session, now, extra = {})` — как сейчас, плюс поля `extra` (`blobs`, `bases`, `notes`) и `base: extra.label ?? 'HEAD'` в записи прохода.
  - `lastAcceptedReport(session, { before = Infinity } = {})` → `{ n, report } | null` — последний проход с `report` и `acceptedAt` и номером меньше `before`.
  - `markChecked(session, currentBlobs)` → `{ checked: rel[], changed: rel[] }`: для последнего прохода сравнивает `pass.blobs[rel]` с `currentBlobs[rel]`; при совпадении (и не `null`) ставит `session.files[rel].checked = { blob, pass: pass.n }`, иначе добавляет `rel` в `changed`. Файлы, которых нет в `session.files`, и файлы с `pass.notes[rel] === 'no_git'` пропускает. Без проходов — `{ checked: [], changed: [] }`.

- [ ] **Step 1: Напиши падающий тест**

Добавь в `tests/gate-core.test.mjs` перед строкой `rmSync(outsideDir, { recursive: true, force: true });`:

```js
// --- Снимок и база прохода ---
{
  const { snapshotBlobs, blobExists, resolveBases, startPass, lastAcceptedReport, markChecked } = await import('../tools/gate-cycle.mjs');
  const { execFileSync } = await import('node:child_process');
  const sr = mkdtempSync(join(tmpdir(), 'qg-core-snap-'));
  execFileSync('git', ['init', '-q'], { cwd: sr });
  mkdirSync(join(sr, 'm'), { recursive: true });
  writeFileSync(join(sr, 'm', 'A.bsl'), 'А = 1;\n', 'utf8');
  writeFileSync(join(sr, 'm', 'B.bsl'), 'Б = 1;\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: sr });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: sr });
  writeFileSync(join(sr, 'm', 'A.bsl'), 'А = 2;\n', 'utf8');

  const blobs1 = snapshotBlobs(sr, ['m/A.bsl', 'm/B.bsl', 'm/Нет.bsl']);
  check('снимок даёт blob каждого существующего файла', /^[0-9a-f]{40}$/.test(blobs1['m/A.bsl']) && /^[0-9a-f]{40}$/.test(blobs1['m/B.bsl']));
  check('удалённый файл в снимке — null, без исключения', blobs1['m/Нет.bsl'] === null);
  check('записанный снимок есть в хранилище', blobExists(sr, blobs1['m/A.bsl']));
  check('выдуманного blob в хранилище нет', !blobExists(sr, '0123456789012345678901234567890123456789'));

  const session = { files: { 'm/A.bsl': { kind: 'code', edits: 1 }, 'm/B.bsl': { kind: 'code', edits: 1 } } };
  const r1 = resolveBases({ session, blobs: blobs1, root: sr });
  check('без отметок проверки база HEAD у всех', r1.label === 'HEAD' && r1.bases['m/A.bsl'] === 'HEAD' && r1.bases['m/B.bsl'] === 'HEAD');
  check('удалённый файл помечен', r1.notes['m/Нет.bsl'] === 'deleted');
  startPass(session, '2026-10-04T10:00:00.000Z', { blobs: blobs1, bases: r1.bases, notes: r1.notes, label: r1.label });
  check('проход хранит снимок и базы', session.cycle.passes[0].blobs['m/A.bsl'] === blobs1['m/A.bsl'] && session.cycle.passes[0].base === 'HEAD');

  // Файл изменён во время прохода — отметку не получает.
  writeFileSync(join(sr, 'm', 'B.bsl'), 'Б = 2;\n', 'utf8');
  const now = snapshotBlobs(sr, ['m/A.bsl', 'm/B.bsl']);
  const marked = markChecked(session, now);
  check('неизменённый файл получает отметку проверки', session.files['m/A.bsl'].checked?.blob === blobs1['m/A.bsl'] && session.files['m/A.bsl'].checked.pass === 1);
  check('изменённый во время прохода — без отметки и назван', !session.files['m/B.bsl'].checked && marked.changed.includes('m/B.bsl'));
  session.cycle.passes[0].report = 'C:/t/r1.md';
  session.cycle.passes[0].acceptedAt = '2026-10-04T10:20:00.000Z';

  // Второй проход: A исправлен, B — от HEAD (отметки нет).
  writeFileSync(join(sr, 'm', 'A.bsl'), 'А = 3;\n', 'utf8');
  const blobs2 = snapshotBlobs(sr, ['m/A.bsl', 'm/B.bsl']);
  const r2 = resolveBases({ session, blobs: blobs2, root: sr });
  check('проверенный файл идёт от снимка прохода 1', r2.bases['m/A.bsl']?.pass === 1 && r2.bases['m/A.bsl'].blob === blobs1['m/A.bsl']);
  check('файл без отметки идёт от HEAD', r2.bases['m/B.bsl'] === 'HEAD');
  check('метка базы — pass:1', r2.label === 'pass:1');
  check('прошлый принятый отчёт находится', lastAcceptedReport(session)?.report === 'C:/t/r1.md');
  check('отчёт текущего прохода не считается прошлым', lastAcceptedReport(session, { before: 1 }) === null);

  // Неизменённый со снимка файл помечается.
  const r2same = resolveBases({ session, blobs: { 'm/A.bsl': blobs1['m/A.bsl'] }, root: sr });
  check('файл, не менявшийся с прохода 1, помечен', r2same.notes['m/A.bsl'] === 'unchanged:1');

  // Снимок убран сборкой мусора — база HEAD с пометкой.
  const gone = { files: { 'm/A.bsl': { kind: 'code', edits: 1, checked: { blob: '0123456789012345678901234567890123456789', pass: 1 } } } };
  const r3 = resolveBases({ session: gone, blobs: { 'm/A.bsl': blobs2['m/A.bsl'] }, root: sr });
  check('пропавший снимок — HEAD и base_missing', r3.bases['m/A.bsl'] === 'HEAD' && r3.notes['m/A.bsl'] === 'base_missing' && r3.label === 'HEAD');

  // Файл вне корня проекта (ключ состояния — абсолютный путь) и файл без git: проход всегда полный.
  const outside = mkdtempSync(join(tmpdir(), 'qg-core-snap-out-'));
  const outFile = join(outside, 'X.bsl');
  writeFileSync(outFile, 'Х = 1;\n', 'utf8');
  const outBlobs = snapshotBlobs(sr, [outFile]);
  const outSession = { files: { [outFile]: { kind: 'code', edits: 1, checked: { blob: blobs1['m/A.bsl'], pass: 1 } } } };
  const r4 = resolveBases({ session: outSession, blobs: outBlobs, root: sr });
  check('файл вне корня — HEAD и no_git, не «удалён»', r4.bases[outFile] === 'HEAD' && r4.notes[outFile] === 'no_git' && r4.label === 'HEAD', JSON.stringify(r4));
  const outPassSession = { files: { [outFile]: { kind: 'code', edits: 1 } } };
  startPass(outPassSession, '2026-10-04T11:00:00.000Z', { blobs: outBlobs, bases: r4.bases, notes: r4.notes, label: r4.label });
  markChecked(outPassSession, outBlobs);
  check('файлу вне git отметка проверки не ставится', !outPassSession.files[outFile].checked);
  const nogit = mkdtempSync(join(tmpdir(), 'qg-core-snap-nogit-'));
  writeFileSync(join(nogit, 'Y.bsl'), 'У = 1;\n', 'utf8');
  const r5 = resolveBases({ session: { files: { 'Y.bsl': { kind: 'code', edits: 1 } } }, blobs: snapshotBlobs(nogit, ['Y.bsl']), root: nogit });
  check('проект без git — HEAD и no_git', r5.bases['Y.bsl'] === 'HEAD' && r5.notes['Y.bsl'] === 'no_git', JSON.stringify(r5));
  rmSync(outside, { recursive: true, force: true });
  rmSync(nogit, { recursive: true, force: true });
  rmSync(sr, { recursive: true, force: true });
}
```

- [ ] **Step 2: Запусти тест — он падает**

Run: `node tests/gate-core.test.mjs`
Expected: FAIL — `snapshotBlobs is not a function` (импорт не находит экспорт).

- [ ] **Step 3: Реализуй**

В `tools/gate-cycle.mjs` добавь импорт `import { spawnSync } from 'node:child_process';`, расширь импорт пути до `import { join, isAbsolute } from 'node:path';`, замени `startPass` и добавь функции:

```js
/**
 * Снимок файлов сессии на старте прохода: blob каждого файла, записанный в хранилище объектов
 * (`hash-object -w`), — по нему следующий проход считает разницу. Недостижимый blob живёт до
 * сборки мусора; пропажу ловит `resolveBases`, и проход становится полным, а не падает.
 */
export function snapshotBlobs(root, files) {
  const out = {};
  for (const rel of files) {
    const r = spawnSync('git', ['hash-object', '-w', rel], { cwd: root, encoding: 'utf8' });
    const sha = String(r.stdout || '').trim();
    out[rel] = !r.error && r.status === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  }
  return out;
}

export function blobExists(root, sha) {
  if (!sha) return false;
  const r = spawnSync('git', ['cat-file', '-e', sha], { cwd: root, encoding: 'utf8' });
  return !r.error && r.status === 0;
}

/**
 * База каждого файла: blob, проверенный последним принятым проходом (`checked`), либо HEAD.
 * Отметку ставит валидатор при приёмке отчёта, поэтому файл, добавленный после прохода или
 * изменённый во время него, идёт от HEAD либо от своей прежней отметки — проверенное раньше
 * не теряется, непроверенное не выдаётся за проверенное.
 */
export function resolveBases({ session, blobs, root }) {
  const bases = {};
  const notes = {};
  const lastPass = session?.cycle?.passes?.at?.(-1) || null;
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  const gitOk = !git.error && git.status === 0;
  let maxPass = 0;
  for (const [rel, cur] of Object.entries(blobs)) {
    const checked = session?.files?.[rel]?.checked;
    // Вне корня или без git сравнивать не с чем: каждый проход полный, как у profile.mjs (`no_git`).
    if (!gitOk || isAbsolute(rel) || rel.startsWith('..')) {
      bases[rel] = 'HEAD';
      notes[rel] = 'no_git';
      continue;
    }
    if (cur === null) {
      bases[rel] = 'HEAD';
      notes[rel] = existsSync(join(root, rel)) ? 'no_git' : 'deleted';
      continue;
    }
    if (!checked?.blob) {
      bases[rel] = 'HEAD';
      if (lastPass?.blobs?.[rel] && lastPass.blobs[rel] === cur) notes[rel] = `unchanged:${lastPass.n}`;
      continue;
    }
    if (!blobExists(root, checked.blob)) {
      bases[rel] = 'HEAD';
      notes[rel] = 'base_missing';
      continue;
    }
    bases[rel] = { pass: checked.pass, blob: checked.blob };
    if (checked.blob === cur) notes[rel] = `unchanged:${checked.pass}`;
    if (checked.pass > maxPass) maxPass = checked.pass;
  }
  return { bases, notes, label: maxPass ? `pass:${maxPass}` : 'HEAD' };
}

export function startPass(session, now = new Date().toISOString(), extra = {}) {
  const c = cycleOf(session);
  const { label, ...rest } = extra;
  const pass = { n: c.passes.length + 1, startedAt: now, base: label ?? 'HEAD', ...rest };
  c.passes.push(pass);
  return pass;
}

export function lastAcceptedReport(session, { before = Infinity } = {}) {
  const passes = session?.cycle?.passes || [];
  for (let i = passes.length - 1; i >= 0; i--) {
    const p = passes[i];
    if (p.n < before && p.report && p.acceptedAt) return { n: p.n, report: p.report };
  }
  return null;
}

/**
 * Отметка «проверено» по снимку принятого прохода. Файл, чей blob разошёлся со снимком,
 * менялся во время прохода: отчёт его текущее содержимое не видел, отметки нет.
 */
export function markChecked(session, currentBlobs) {
  const out = { checked: [], changed: [] };
  const pass = session?.cycle?.passes?.at?.(-1);
  if (!pass?.blobs) return out;
  for (const [rel, blob] of Object.entries(pass.blobs)) {
    const entry = session.files?.[rel];
    if (!entry || pass.notes?.[rel] === 'no_git') continue;
    if (blob && currentBlobs[rel] === blob) {
      entry.checked = { blob, pass: pass.n };
      out.checked.push(rel);
    } else {
      out.changed.push(rel);
    }
  }
  return out;
}
```

Старое тело `startPass` удали (новое совместимо: без `extra` запись та же, что раньше).

- [ ] **Step 4: Запусти тесты — проходят**

Run: `node tests/gate-core.test.mjs && node tests/run-tests.mjs`
Expected: PASS, число провалов 0 (прежние тесты цикла v3.16 не сломаны: `startPass(session, now)` даёт ту же запись).

- [ ] **Step 5: Commit**

```bash
git add tools/gate-cycle.mjs tests/gate-core.test.mjs
git commit -m "feat(гейт): снимок файлов и база прохода в состоянии сессии"
```

---

### Task 2: Профиль от базы прохода (`tools/profile.mjs`)

**Files:**
- Modify: `tools/profile.mjs` (`diffFile` ~433–505, `analyzeChangedMethods` ~530–585, `computeProfile` ~680–880)
- Test: `tests/run-tests.mjs` (новый блок сразу после блока «Классификация «в правке / вне правки»», который начинается с `const tr = join(WORK, 'touched-root');`)

**Interfaces:**
- Consumes: `headVersion` из `tools/rename-check.mjs` (как сейчас).
- Produces:
  - `SCOPE_BASE` — `/^(HEAD|pass:[1-9]\d*)$/`, экспорт.
  - `baseLabel(bases)` → `'HEAD' | 'pass:<n>'` — та же логика, что `label` в `resolveBases` (Task 1): максимум `pass` среди blob-баз. Экспорт.
  - `computeProfile({ files, root, config, metrics, configState, bases = null })` — новый необязательный `bases` (`{ [rel]: 'HEAD' | { pass, blob } }`, ключи как в `files`). Результат дополняется полями `base` (метка), `unchangedSinceBase: rel[]`, `baseMissing: rel[]`; `scopeLine` получает `, base=<метка>` перед `, config=`.
  - Семантика: объём, `loc`, архетипы, `volumeReason`, `resolved` — по разнице от базы; `touched` — всегда от `HEAD`; `files=` в `scopeLine` — по-прежнему число файлов сессии.

- [ ] **Step 1: Напиши падающий тест**

```js
// Профиль от базы прохода (v3.17.0): объём и архетипы — по разнице со снимком, граница правки —
// от HEAD. Иначе метод, добавленный на проходе 1, держал бы C2 на каждом следующем проходе,
// а новый модуль требовал бы холодного читателя при каждой правке строки.
{
  const br = join(WORK, 'base-profile-root');
  rmSync(br, { recursive: true, force: true });
  mkdirSync(join(br, 'src', 'cf', 'CommonModules', 'М', 'Ext'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: br });
  writeFileSync(join(br, '.1c-quality-gate.json'), '{}', 'utf8');
  const bsl = 'src/cf/CommonModules/М/Ext/Module.bsl';
  writeFileSync(join(br, bsl), BOM + 'Процедура Старая() Экспорт\n\tА = 1;\nКонецПроцедуры\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: br });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: br });
  // Проход 1: добавлен новый метод и новый общий модуль.
  writeFileSync(join(br, bsl), BOM + 'Процедура Старая() Экспорт\n\tА = 1;\nКонецПроцедуры\n\nПроцедура Новая() Экспорт\n\tБ = 1;\nКонецПроцедуры\n', 'utf8');
  const fresh = 'src/cf/CommonModules/Н/Ext/Module.bsl';
  mkdirSync(join(br, 'src', 'cf', 'CommonModules', 'Н', 'Ext'), { recursive: true });
  writeFileSync(join(br, fresh), BOM + 'Процедура Н() Экспорт\nКонецПроцедуры\n', 'utf8');
  const { snapshotBlobs } = await import(pathToFileURL(join(ROOT, 'tools', 'gate-cycle.mjs')).href);
  const { computeProfile, touchedLine, SCOPE_BASE, baseLabel } = await import(pathToFileURL(join(ROOT, 'tools', 'profile.mjs')).href);
  const snap1 = snapshotBlobs(br, [bsl, fresh]);
  const p1 = computeProfile({ files: [bsl, fresh], root: br, config: {}, metrics: {}, configState: null });
  check('проход 1 от HEAD: новый метод держит C2 и выше', ['C2', 'C3'].includes(p1.volume) && p1.base === 'HEAD' && /, base=HEAD, config=/.test(p1.scopeLine), p1.scopeLine);

  // Исправление: одна строка внутри нового метода; новый модуль не менялся.
  writeFileSync(join(br, bsl), BOM + 'Процедура Старая() Экспорт\n\tА = 1;\nКонецПроцедуры\n\nПроцедура Новая() Экспорт\n\tБ = 2;\nКонецПроцедуры\n', 'utf8');
  const bases = { [bsl]: { pass: 1, blob: snap1[bsl] }, [fresh]: { pass: 1, blob: snap1[fresh] } };
  const p2 = computeProfile({ files: [bsl, fresh], root: br, config: {}, metrics: {}, configState: null, bases });
  check('проход 2: объём по разнице со снимком — C1', p2.volume === 'C1' && p2.loc.added === 1 && p2.loc.removed === 1, JSON.stringify({ v: p2.volume, r: p2.volumeReason, loc: p2.loc }));
  check('проход 2: новый модуль, не менявшийся со снимка, архетип не включает', !p2.archetypes.includes('new-common-module'), p2.archetypes.join(','));
  check('проход 2: неизменённый файл назван', p2.unchangedSinceBase.includes(fresh) && !p2.unchangedSinceBase.includes(bsl));
  check('проход 2: граница правки по-прежнему от HEAD', touchedLine(p2.touched, bsl, 6) && !touchedLine(p2.touched, bsl, 2) && p2.touched[fresh]?.kind === 'whole', JSON.stringify(p2.touched));
  check('проход 2: метка базы в scope', p2.base === 'pass:1' && /, base=pass:1, config=/.test(p2.scopeLine) && SCOPE_BASE.test(p2.base), p2.scopeLine);
  check('метка базы — максимум проходов', baseLabel({ a: 'HEAD', b: { pass: 2, blob: 'x' }, c: { pass: 1, blob: 'y' } }) === 'pass:2' && baseLabel({ a: 'HEAD' }) === 'HEAD');

  // Пропавший снимок: база HEAD с пометкой, профиль считается, ничего не падает.
  const lost = { [bsl]: { pass: 1, blob: '0123456789012345678901234567890123456789' }, [fresh]: 'HEAD' };
  const p3 = computeProfile({ files: [bsl, fresh], root: br, config: {}, metrics: {}, configState: null, bases: lost });
  check('пропавший снимок — HEAD и base_missing', p3.baseMissing.includes(bsl) && ['C2', 'C3'].includes(p3.volume), JSON.stringify({ m: p3.baseMissing, v: p3.volume }));

  // Ни один файл не менялся со снимка — объём C0, код не проверяется заново.
  const same = snapshotBlobs(br, [bsl, fresh]);
  const p4 = computeProfile({ files: [bsl, fresh], root: br, config: {}, metrics: {}, configState: null,
    bases: { [bsl]: { pass: 2, blob: same[bsl] }, [fresh]: { pass: 2, blob: same[fresh] } } });
  check('без изменений со снимка — C0 с причиной', p4.volume === 'C0' && p4.volumeReason === 'unchanged-since-base', JSON.stringify({ v: p4.volume, r: p4.volumeReason }));
}
```

- [ ] **Step 2: Запусти — падает**

Run: `node tests/run-tests.mjs`
Expected: FAIL на «проход 1 от HEAD … base=HEAD» (поля `base` в строке `scope` ещё нет) и далее.

- [ ] **Step 3: Реализуй**

1. Экспорты в начале `tools/profile.mjs` (после `BASE_CHECKLIST`):

```js
/** Метка базы прохода в записи scope. Валидатор импортирует шаблон отсюда — копии нет. */
export const SCOPE_BASE = /^(HEAD|pass:[1-9]\d*)$/;

export function baseLabel(bases) {
  let max = 0;
  for (const b of Object.values(bases || {})) if (b && typeof b === 'object' && b.pass > max) max = b.pass;
  return max ? `pass:${max}` : 'HEAD';
}
```

2. `diffFile(file, root, gitOk, base = 'HEAD')`. Ветка `no_git` (git недоступен либо файл вне корня) проверяется **первой при любой базе** — blob-база для такого файла игнорируется, проход по нему полный. Ветка «нет истории в HEAD» — только при `base === 'HEAD'`. Для blob-базы (после проверки `no_git`):

```js
  if (base && typeof base === 'object') {
    const exists = spawnSync('git', ['cat-file', '-e', base.blob], { cwd: root, encoding: 'utf8' });
    if (exists.error || exists.status !== 0) {
      return { ...diffFile(file, root, gitOk, 'HEAD'), baseMissing: true };
    }
    const cur = spawnSync('git', ['hash-object', '-w', rel], { cwd: root, encoding: 'utf8' });
    const curSha = String(cur.stdout || '').trim();
    if (cur.error || cur.status !== 0 || !curSha) return { ...diffFile(file, root, gitOk, 'HEAD'), baseMissing: true };
    if (curSha === base.blob) {
      return { rel, added: 0, removed: 0, addedLines: [], removedLines: [], isNew: false, changedLines: new Set(), baseBlob: base.blob, unchanged: true };
    }
    return { rel, ...diffOutput(root, ['diff', '--numstat', base.blob, curSha], ['diff', '-U0', base.blob, curSha]), isNew: false, baseBlob: base.blob };
  }
```

Вынеси разбор `--numstat` и `-U0` из текущего тела в `diffOutput(root, numstatArgs, unifiedArgs)` → `{ added, removed, addedLines, removedLines, changedLines }` и вызывай его же для `HEAD` с `['diff', '--numstat', 'HEAD', '--', rel]` и `['diff', '-U0', 'HEAD', '--', rel]`. Логику hunk'ов (включая стык чистого удаления) не меняй — она переезжает дословно.

3. `analyzeChangedMethods(diffs, root)`: вместо `headVersion(abs, root)` — текст базы:

```js
    const baseRaw = d.baseBlob
      ? (() => {
          const r = spawnSync('git', ['cat-file', '-p', d.baseBlob], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
          return r.error || r.status !== 0 ? null : String(r.stdout).replace(/^\uFEFF/, '');
        })()
      : headVersion(abs, root);
    if (baseRaw === null) continue;
```

Пропускай `d.unchanged` так же, как `d.isNew` (сравнивать нечего — методов не задето).

4. `computeProfile`: принимает `bases`. Две разницы:

```js
  const baseOf = (f) => (bases && bases[f] && typeof bases[f] === 'object' ? bases[f] : 'HEAD');
  const diffs = files.map((f) => ({ file: f, ...diffFile(f, root, gitOk, baseOf(f)) }));
  const fromBase = diffs.some((d) => d.baseBlob);
  const headDiffs = fromBase ? files.map((f) => ({ file: f, ...diffFile(f, root, gitOk, 'HEAD') })) : diffs;
  const effective = diffs.filter((d) => !d.unchanged);
```

   - `added`, `removed`, `allAddedLines`, `allRemovedLines`, маркеры архетипов (`byPath`, `byNewFile`, `dirsPresent`), порог `c1MaxFiles` (вместо `files.length` — `effective.length`) и `hasXmlChange` (по `effective`) — считаются по `effective`.
   - `methodAnalysis = analyzeChangedMethods(effective, root)` — для объёма и тел архетипов.
   - Граница правки — по `headDiffs`: `const touchedAnalysis = fromBase ? analyzeChangedMethods(headDiffs, root) : methodAnalysis;` и цикл заполнения `touched` идёт по `headDiffs` (там `isNew` и `no_git` относительно HEAD).
   - Первым условием объёма: `if (fromBase && effective.length === 0) { volume = 'C0'; volumeReason = 'unchanged-since-base'; }`, затем прежняя цепочка (`else if (cosmeticOnly) …`).
   - `const base = fromBase ? baseLabel(Object.fromEntries(diffs.filter((d) => d.baseBlob).map((d) => [d.rel, baseOf(d.file)]))) : 'HEAD';`
   - `scopeLine`: `` `resolved=…, base=${base}, config=${…}]` `` — поле вставляется между `resolved` и `config`.
   - Результат: `base`, `unchangedSinceBase: diffs.filter((d) => d.unchanged).map((d) => d.rel)`, `baseMissing: diffs.filter((d) => d.baseMissing).map((d) => d.rel)`.

5. Комментарий над `computeProfile` дополни абзацем: объём от базы, граница от HEAD, ссылка на спецификацию (раздел «Разница от базы»).

- [ ] **Step 4: Запусти — проходит; поправь точные сравнения строки scope**

Run: `node tests/run-tests.mjs`
Expected: новые проверки PASS. Если прежние тесты сравнивают строку `scope` целиком (поиск: `grep -n "config=default\]" tests/run-tests.mjs`), они падают из-за нового поля `base=HEAD` — обнови ожидание вставкой `, base=HEAD` перед `, config=`. Других изменений в старых тестах быть не должно.

- [ ] **Step 5: Commit**

```bash
git add tools/profile.mjs tests/run-tests.mjs
git commit -m "feat(профиль): объём и архетипы от базы прохода, граница правки от HEAD, поле base в scope"
```

---

### Task 3: `gate.mjs run` и `plan` ведут проход от снимка

**Files:**
- Modify: `tools/gate.mjs` (`planContext` ~1365, `cmdRun` ~1511, `cmdPlan` ~1248, `codeModelPasses` ~1089)
- Modify: `tools/evidence-validator.mjs` (`reportSections` ~397 — поле `ids` у каждой находки)
- Test: `tests/run-tests.mjs` (новый блок после блока Task 2)

**Interfaces:**
- Consumes: `snapshotBlobs`, `resolveBases`, `startPass(session, now, extra)`, `lastAcceptedReport` (Task 1); `computeProfile({ …, bases })` и поля `base`, `unchangedSinceBase`, `baseMissing` (Task 2); `reportSections` из `evidence-validator.mjs` (уже импортирован).
- Produces:
  - `prepareBases({ rootDir, files, sessionId, continueLast })` → `{ blobs, bases, notes, label, continued } | null` (внутренняя функция `gate.mjs`): без сессии — `null`; `continueLast` и у последнего прохода есть `bases` — берёт их (`continued: true`), иначе `snapshotBlobs` + `resolveBases` по свежему прочтению состояния.
  - `planContext(args, { analyzer, bases })` — `bases: (rootDir, files, sessionId) => bases | null`; результат передаётся в `computeProfile`.
  - Вывод `run` на проходе с базой ≠ `HEAD`: строка `Проход N из 3 · база pass:K`; раздел `## База прохода` (файлы от HEAD с причиной, файлы «не менялся с прохода K», `base_missing`); строка `Прошлый отчёт: <путь>`; раздел `## Находки прошлого отчёта` (заголовки открытых находок по разделам); файл `fix.diff` в каталоге прогона.
  - `buildBaseDiff(rootDir, files, bases)` → текст: для blob-базы `git diff <base> <cur>` с заменой заголовков на `diff --git a/<rel> b/<rel>`, `--- a/<rel>`, `+++ b/<rel>`; для `HEAD` — `git diff HEAD -- <rel>`.
  - `change.diff` не меняет смысла: разница от `HEAD`, её сверяет `catalog.mjs attest --diff` (там сравнение с `git diff HEAD`).
  - `reportSections(text)` — у каждой находки поле `ids: string[]` (идентификаторы из заголовка и тела по `FINDING_ID`, через `normId`, без повторов, по возрастанию). Нужно выводу `run` здесь и сверке переноса в Task 5: валидатор сопоставляет находки по идентификаторам, и субагент обязан видеть их в выводе `run`, а не восстанавливать по памяти.
  - Стенд `fixpass-root` (сессия `F1`) создаётся в этом блоке и переиспользуется блоками Task 4 и Task 5 — к концу блока в цикле три прохода, у файла нет отметки `checked`.

- [ ] **Step 1: Напиши падающий тест**

```js
// Проход по исправлению в run: снимок на старте, база от проверенного, прошлый отчёт и его
// находки в выводе, fix.diff для модельных слоёв. change.diff остаётся от HEAD — его сверяет attest.
{
  const fr = join(WORK, 'fixpass-root');
  rmSync(fr, { recursive: true, force: true });
  mkdirSync(join(fr, 'src', 'cf', 'CommonModules', 'М', 'Ext'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: fr });
  writeFileSync(join(fr, '.1c-quality-gate.json'), '{}', 'utf8');
  const bsl = 'src/cf/CommonModules/М/Ext/Module.bsl';
  writeFileSync(join(fr, bsl), BOM + 'Процедура П() Экспорт\n\tА = 1;\nКонецПроцедуры\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: fr });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: fr });
  writeFileSync(join(fr, bsl), BOM + 'Процедура П() Экспорт\n\tА = 2;\nКонецПроцедуры\n', 'utf8');
  const env = { CLAUDE_PROJECT_DIR: fr };
  execFileSync(process.execPath, [join(ROOT, 'hooks', 'gate-arm.mjs')], { input: JSON.stringify({ session_id: 'F1', cwd: fr, tool_input: { file_path: join(fr, bsl) } }), env: { ...process.env, CLAUDE_PROJECT_DIR: fr } });
  const p = join(fr, '.claude', '.state', 'qg-pending.json');
  const sess = () => JSON.parse(readFileSync(p, 'utf8')).sessions.F1;

  const r1 = run('tools/gate.mjs', ['run', '--session', 'F1', '--no-analyzer'], { env });
  check('проход 1 записывает снимок', r1.code === 0 && /^[0-9a-f]{40}$/.test(sess().cycle.passes[0].blobs?.[bsl] || ''), JSON.stringify(sess().cycle));

  // Приёмку отчёта имитируем записью состояния: валидатор (Task 4) делает то же.
  const report1 = join(WORK, 'fixpass-r1.md');
  writeFileSync(report1, '# Отчёт\n\n## Открыто в правке\n\n### 🟡 Магическое число\n\nФайл: ' + bsl + ':2, qg:MAGIC-NUMBER\n\n## Вне правки\n\n### 🟠 Запрос в цикле\n\nФайл: ' + bsl + ':9, qg:DB-READ-IN-LOOP\n', 'utf8');
  const st = JSON.parse(readFileSync(p, 'utf8'));
  const pass1 = st.sessions.F1.cycle.passes[0];
  pass1.report = report1;
  pass1.acceptedAt = new Date().toISOString();
  st.sessions.F1.files[bsl].checked = { blob: pass1.blobs[bsl], pass: 1 };
  writeFileSync(p, JSON.stringify(st, null, 2), 'utf8');

  writeFileSync(join(fr, bsl), BOM + 'Процедура П() Экспорт\n\tА = 3;\nКонецПроцедуры\n', 'utf8');
  execFileSync(process.execPath, [join(ROOT, 'hooks', 'gate-arm.mjs')], { input: JSON.stringify({ session_id: 'F1', cwd: fr, tool_input: { file_path: join(fr, bsl) } }), env: { ...process.env, CLAUDE_PROJECT_DIR: fr } });
  check('взвод не стирает отметку проверки', sess().files[bsl].checked?.pass === 1);
  const r2 = run('tools/gate.mjs', ['run', '--session', 'F1', '--no-analyzer'], { env });
  check('проход 2 идёт от снимка прохода 1', r2.code === 0 && /^Проход 2 из 3 · база pass:1/m.test(r2.out), r2.out.slice(0, 600));
  check('проход 2 называет прошлый отчёт', r2.out.includes(`Прошлый отчёт: ${report1}`));
  check('проход 2 перечисляет находки прошлого отчёта по разделам',
    /## Находки прошлого отчёта[\s\S]*Открыто в правке[\s\S]*Магическое число[\s\S]*Вне правки[\s\S]*Запрос в цикле/.test(r2.out), r2.out);
  check('находки прошлого отчёта печатаются с идентификаторами',
    /Магическое число \[qg:MAGIC-NUMBER\]/.test(r2.out) && /Запрос в цикле \[qg:DB-READ-IN-LOOP\]/.test(r2.out), r2.out);
  const runDir = join(fr, '.claude', '.state', 'qg-run-F1');
  const fix = readFileSync(join(runDir, 'fix.diff'), 'utf8');
  check('fix.diff — разница от снимка с путём файла', fix.includes(`+++ b/${bsl}`) && /-\tА = 2;/.test(fix) && /\+\tА = 3;/.test(fix), fix);
  check('строка scope в черновике несёт base=pass:1', /\[qg scope: [^\]]*base=pass:1/.test(r2.out));
  check('запись прохода 2 хранит базы', sess().cycle.passes[1].base === 'pass:1' && sess().cycle.passes[1].bases?.[bsl]?.pass === 1);

  // --only продолжает проход: те же базы, без нового снимка.
  const only = run('tools/gate.mjs', ['run', '--session', 'F1', '--no-analyzer', '--only', 'hygiene-check'], { env });
  check('run --only продолжает проход с теми же базами', only.code === 0 && sess().cycle.passes.length === 2 && /база pass:1/.test(only.out), only.out.slice(0, 400));

  // plan --session показывает базу предстоящего прохода, не записывая проход.
  const pl = run('tools/gate.mjs', ['plan', '--session', 'F1', '--no-analyzer'], { env });
  check('plan печатает scope с базой и не пишет проход', /base=pass:1/.test(pl.out) && sess().cycle.passes.length === 2, pl.out.slice(0, 600));

  // Прошлый проход без принятого отчёта — база HEAD у файлов без отметки, причина названа.
  const st2 = JSON.parse(readFileSync(p, 'utf8'));
  delete st2.sessions.F1.files[bsl].checked;
  writeFileSync(p, JSON.stringify(st2, null, 2), 'utf8');
  const r3 = run('tools/gate.mjs', ['run', '--session', 'F1', '--no-analyzer'], { env });
  check('без отметки проверки проход полный и причина названа', /^Проход 3 из 3 · база HEAD/m.test(r3.out) && /Module\.bsl: от HEAD — нет принятого отчёта/.test(r3.out), r3.out.slice(0, 800));
}
```

- [ ] **Step 2: Запусти — падает**

Run: `node tests/run-tests.mjs`
Expected: FAIL на «проход 1 записывает снимок».

- [ ] **Step 3: Реализуй**

1. Импорт: `import { MAX_PASSES, passCount, startPass, addDecision, updateSession, snapshotBlobs, resolveBases, lastAcceptedReport } from './gate-cycle.mjs';`.

   В `tools/evidence-validator.mjs` у `reportSections` добавь поле `ids`:

```js
export function reportSections(text) {
  const all = collectFindings(text).map((f) => ({
    sev: f.sev, title: f.title, line: f.line, section: f.section,
    ids: [...new Set(([f.title, ...f.body].join('\n').match(FINDING_ID) || []).map(normId))].sort(),
  }));
  return {
    inChange: all.filter((f) => f.section === 'change'),
    outside: all.filter((f) => f.section === 'outside'),
    needsDecision: all.filter((f) => f.section === 'decision'),
  };
}
```

   Прочие потребители (`cmdRelease` → `residual`) лишнее поле не замечают; если `residual` сериализует находку целиком, `ids` в журнале снятий — полезное дополнение, тест на точную форму записи поправь.

2. `prepareBases`:

```js
/**
 * Снимок и база прохода — до профиля: профиль прохода по исправлению считается от базы.
 * Перезапуск через --only продолжает проход и берёт его базы, а не снимает новый снимок:
 * иначе файл, исправленный между запуском и повтором, выпал бы из проверки молча.
 */
function prepareBases({ rootDir, files, sessionId, continueLast }) {
  if (!sessionId) return null;
  const state = readPending();
  const session = state?.sessions?.[sessionId];
  if (!session) return null;
  const last = session.cycle?.passes?.at?.(-1);
  if (continueLast && last?.bases) {
    return { blobs: last.blobs || {}, bases: last.bases, notes: last.notes || {}, label: last.base || 'HEAD', continued: true };
  }
  const blobs = snapshotBlobs(rootDir, files);
  return { blobs, ...resolveBases({ session, blobs, root: rootDir }), continued: false };
}
```

3. `planContext(args, { analyzer: provide = null, bases: provideBases = null } = {})`: после разбора `testPaths` и до `computeProfile` — `const bases = provideBases ? provideBases(rootDir, files, sessionId) : null;` и `computeProfile({ …, bases })`. Ошибка настройки возвращается до записи прохода, как сейчас.

4. `cmdRun`: 

```js
  let prepared = null;
  const ctx = planContext(args, {
    analyzer: /* без изменений */,
    bases: (rootDir, files, sessionId) => {
      prepared = prepareBases({ rootDir, files, sessionId, continueLast: Boolean(wanted) });
      return prepared?.bases || null;
    },
  });
```

   В `mutate` при новом проходе: `const pass = startPass(session, undefined, { blobs: prepared?.blobs, bases: prepared?.bases, notes: prepared?.notes, label: prepared?.label });`. Прошлый принятый отчёт вычисли в том же `mutate` до `startPass`: `const prev = lastAcceptedReport(session);` и верни `{ pass, prev }`; при `--only` — `lastAcceptedReport(session, { before: last.n })`.

5. Вывод после `## Профиль` и перед `## Задето правкой`, только если `prepared && (prepared.label !== 'HEAD' || outcome?.prev)`:

```js
  w('\n## База прохода\n');
  w('Объём и глубина посчитаны от базы; граница правки ниже — от HEAD.\n');
  for (const rel of files) {
    const b = prepared.bases[rel];
    const note = prepared.notes[rel] || '';
    if (note === 'deleted') w(`${rel}: файла нет в рабочем дереве\n`);
    else if (note === 'no_git') w(`${rel}: от HEAD — файл вне git или вне корня проекта, проверяется полностью на каждом проходе\n`);
    else if (note === 'base_missing') w(`${rel}: от HEAD — снимок прохода убран сборкой мусора git (base_missing), файл проверяется полностью\n`);
    else if (b === 'HEAD') w(`${rel}: от HEAD — нет принятого отчёта по этому файлу (добавлен после прохода, изменён во время него или отчёт не принят)${note.startsWith('unchanged:') ? `; не менялся с прохода ${note.slice(10)}` : ''}\n`);
    else if (note.startsWith('unchanged:')) w(`${rel}: не менялся с прохода ${b.pass} — слои по нему закрываются skipped reason=verified_earlier по отметкам verify\n`);
    else w(`${rel}: от снимка прохода ${b.pass}\n`);
  }
  if (outcome?.prev) {
    w(`Прошлый отчёт: ${outcome.prev.report}\n`);
    let text = null;
    try { text = readFileSync(outcome.prev.report, 'utf8'); } catch { /* отчёт удалён — сказано ниже */ }
    if (text === null) w('Прошлый отчёт не читается — проход по исправлению сверять не с чем; находки ищутся заново.\n');
    else {
      const s = reportSections(text);
      w('\n## Находки прошлого отчёта\n');
      w('Каждая обязана попасть в новый отчёт: в «Закрыто» (проверено по коду) либо остаться в своём разделе.\n');
      for (const [title, list] of [['Открыто в правке', s.inChange], ['Вне правки', s.outside], ['Нужно решение', s.needsDecision]]) {
        if (!list.length) continue;
        w(`${title}:\n`);
        for (const f of list) w(`  ${f.sev} ${f.title}${f.ids.length ? ` [${f.ids.join(', ')}]` : ''}\n`);
      }
    }
  }
```

   Строка прохода: `passLine = \`Проход ${outcome.pass.n} из ${MAX_PASSES} · база ${outcome.pass.base}\`` — уже есть, теперь `base` приходит из записи.

6. `fix.diff`: после записи `change.diff` (или сразу после создания `runDir`) при `prepared && prepared.label !== 'HEAD'`:

```js
function buildBaseDiff(rootDir, files, bases) {
  const parts = [];
  for (const rel of files) {
    const b = bases?.[rel];
    if (b && typeof b === 'object') {
      const cur = spawnSync('git', ['hash-object', '-w', rel], { cwd: rootDir, encoding: 'utf8' });
      const sha = String(cur.stdout || '').trim();
      if (!sha || sha === b.blob) continue;
      const d = spawnSync('git', ['diff', b.blob, sha], { cwd: rootDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      const body = String(d.stdout || '').split('\n').map((l) =>
        l.startsWith('diff --git ') ? `diff --git a/${rel} b/${rel}` : l.startsWith('--- ') ? `--- a/${rel}` : l.startsWith('+++ ') ? `+++ b/${rel}` : l
      ).join('\n');
      parts.push(body);
    } else {
      const d = spawnSync('git', ['diff', 'HEAD', '--', rel], { cwd: rootDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      parts.push(String(d.stdout || ''));
    }
  }
  return parts.filter((s) => s.trim()).join('\n');
}
```

   и `writeFileSync(join(runDir, 'fix.diff'), buildBaseDiff(rootDir, files, prepared.bases), 'utf8');` с выводом строки `fix.diff                сохранено: <relRun>/fix.diff — вход модельных слоёв прохода по исправлению`.

7. `codeModelPasses(…, fixPass)` — новый параметр `fixPass: { fixDiff, prevReport } | null`. При нём первой строкой списка: `` `проход по исправлению: субагентам слоёв — ${fixDiff} и прошлый отчёт ${prevReport}; файлы целиком не читать, кроме строк за пределами разницы, нужных для понимания` ``. Строку `attest --diff` оставь на `change.diff`.

8. `cmdPlan`: в вызове `planContext` передай `bases: (rootDir, files, sessionId) => prepareBases({ rootDir, files, sessionId, continueLast: false })?.bases || null`. Проход не записывается.

- [ ] **Step 4: Запусти — проходит**

Run: `node tests/run-tests.mjs`
Expected: PASS, включая тесты цикла v3.16 («Проход 1 из 3 · база HEAD»).

- [ ] **Step 5: Commit**

```bash
git add tools/gate.mjs tools/evidence-validator.mjs tests/run-tests.mjs
git commit -m "feat(гейт): проход по исправлению от снимка — база в выводе run, прошлый отчёт и его находки с идентификаторами, fix.diff"
```

---

### Task 4: Валидатор — приёмка ставит `checked`, сверка и пересчёт от базы

**Files:**
- Modify: `tools/evidence-validator.mjs` (`ownSession` ~276, сверка профиля ~826–875, проверки записи `scope` ~513, `main` ~1016–1060)
- Test: `tests/run-tests.mjs` (блок после Task 3; использует тот же стенд `fixpass-root`, поэтому ставь его сразу за блоком Task 3 внутри отдельных фигурных скобок)

**Interfaces:**
- Consumes: `SCOPE_BASE` (Task 2); `snapshotBlobs`, `markChecked`, `lastAcceptedReport`, `acceptPass`, `updateSession` (Task 1); `computeProfile({ …, bases })`.
- **Зависимость тестов:** блок стоит сразу после блока Task 3 и работает на его стенде `fixpass-root` (сессия `F1`, каталог `WORK`). Блок сам сбрасывает цикл (`cycle = { passes: [] }`) и отметку `checked`, поэтому от числа проходов Task 3 не зависит. К концу блока в цикле три прохода: проход 2 принят (отчёт `fixpass-full.md`, отметка `pass:2`), проход 3 принят (`fixpass-v3.md`, база `pass:2`), файл изменён после прохода 3. Это состояние — вход блока Task 5; меняя сценарий здесь, проверь Task 5.
- Produces:
  - `ownSession(root, sessionId)` дополнительно возвращает `pass` (последняя запись прохода или `null`) и `session` (объект сессии) — их читают Task 4 и Task 5.
  - Правила записи `scope`:
    - `base` есть и не подходит под `SCOPE_BASE` — ошибка;
    - есть запись прохода, `base` заявлен и не равен ни `HEAD`, ни `pass.base` — ошибка («заявлена база X, а проход N идёт от Y»);
    - сессии нет (`own` пуст) и `base` ≠ `HEAD` — предупреждение «базу сверить не по чему»;
    - пересчёт профиля: `bases = declared === 'HEAD' ? null : own.pass.bases`.
  - `main`: при `--gate --session` и коде 0 — `acceptPass` и `markChecked(s, snapshotBlobs(root, Object.keys(pass.blobs || {})))` в одном `updateSession`; при непустом `changed` печатает `ПРЕДУПРЕЖДЕНИЕ — файлы менялись во время прохода: …; отметка проверки им не поставлена, следующий проход посчитает их от прошлой базы`. Код возврата не меняется.
  - Текст ошибок понижения объёма и архетипов ссылается на «строку scope из вывода run (черновик следа) или gate.mjs plan» — `plan` теперь печатает ту же базу.

- [ ] **Step 1: Напиши падающий тест**

```js
// Валидатор и база прохода: приёмка ставит отметки, заявленная база сверяется с проходом,
// пересчёт объёма идёт от той же базы. Сквозная граница: строка scope из run → валидатор.
{
  const fr = join(WORK, 'fixpass-root');
  const env = { CLAUDE_PROJECT_DIR: fr };
  const bsl = 'src/cf/CommonModules/М/Ext/Module.bsl';
  const p = join(fr, '.claude', '.state', 'qg-pending.json');
  const sess = () => JSON.parse(readFileSync(p, 'utf8')).sessions.F1;
  // Новый цикл на том же стенде: проход 1 → приёмка валидатором → правка → проход 2.
  const st = JSON.parse(readFileSync(p, 'utf8'));
  st.sessions.F1.cycle = { passes: [], decisions: [] };
  delete st.sessions.F1.files[bsl].checked;
  writeFileSync(p, JSON.stringify(st, null, 2), 'utf8');
  const r1 = run('tools/gate.mjs', ['run', '--session', 'F1', '--no-analyzer'], { env });
  const scope1 = (r1.out.match(/^\[qg scope: .*\]$/m) || [''])[0];
  const draft = (scope) => readFileSync(ev('valid.md'), 'utf8').replace(/^\[qg scope: .*\]$/m, scope) +
    '[qg not_verified: dimension=static-analysis, reason=not_in_analyzer_report, files=1]\n';
  const rep1 = join(WORK, 'fixpass-v1.md');
  writeFileSync(rep1, draft(scope1), 'utf8');
  const v1 = run('tools/evidence-validator.mjs', [rep1, '--gate', '--session', 'F1'], { env });
  check('валидатор принимает след прохода 1 со строкой scope из run', v1.code === 0, v1.out.slice(0, 600));
  check('приёмка ставит отметку проверки по снимку', sess().files[bsl].checked?.pass === 1 && sess().files[bsl].checked.blob === sess().cycle.passes[0].blobs[bsl]);

  writeFileSync(join(fr, bsl), BOM + 'Процедура П() Экспорт\n\tА = 4;\nКонецПроцедуры\n', 'utf8');
  const r2 = run('tools/gate.mjs', ['run', '--session', 'F1', '--no-analyzer'], { env });
  const scope2 = (r2.out.match(/^\[qg scope: .*\]$/m) || [''])[0];
  check('строка scope прохода 2 несёт base=pass:1', /base=pass:1/.test(scope2), scope2);
  const rep2 = join(WORK, 'fixpass-v2.md');
  writeFileSync(rep2, draft(scope2), 'utf8');
  const v2 = run('tools/evidence-validator.mjs', [rep2, '--gate', '--session', 'F1'], { env });
  check('сквозная граница: scope с base=pass:1 из run принимается', v2.code === 0, v2.out.slice(0, 600));

  const wrong = join(WORK, 'fixpass-wrong.md');
  writeFileSync(wrong, draft(scope2.replace('base=pass:1', 'base=pass:7')), 'utf8');
  const vw = run('tools/evidence-validator.mjs', [wrong, '--gate', '--session', 'F1'], { env });
  check('чужая база отклоняется с названием прохода', vw.code !== 0 && /base=pass:7/.test(vw.out) && /pass:1/.test(vw.out), vw.out.slice(0, 600));
  const bad = join(WORK, 'fixpass-bad.md');
  writeFileSync(bad, draft(scope2.replace('base=pass:1', 'base=снимок')), 'utf8');
  check('метка базы вне шаблона — ошибка', run('tools/evidence-validator.mjs', [bad, '--gate', '--session', 'F1'], { env }).code !== 0);
  const full = join(WORK, 'fixpass-full.md');
  writeFileSync(full, draft(scope2.replace('base=pass:1', 'base=HEAD')), 'utf8');
  const vf = run('tools/evidence-validator.mjs', [full, '--gate', '--session', 'F1'], { env });
  check('заявленная база HEAD на проходе 2 допустима — проверка полнее', vf.code === 0, vf.out.slice(0, 600));
  const emptyRoot = join(WORK, 'fixpass-empty');
  rmSync(emptyRoot, { recursive: true, force: true });
  mkdirSync(emptyRoot, { recursive: true });
  const lint = run('tools/evidence-validator.mjs', [rep2, '--root', emptyRoot]);
  check('без сессии база pass:N — предупреждение, не ошибка', /ПРЕДУПРЕЖДЕНИЕ[^\n]*базу сверить не по чему/.test(lint.out), lint.out.slice(0, 600));

  // Файл изменён между run и валидатором — отчёт принят, отметки нет, предупреждение.
  const before = sess().files[bsl].checked;
  const r3 = run('tools/gate.mjs', ['run', '--session', 'F1', '--no-analyzer'], { env });
  writeFileSync(join(fr, bsl), BOM + 'Процедура П() Экспорт\n\tА = 5;\nКонецПроцедуры\n', 'utf8');
  const rep3 = join(WORK, 'fixpass-v3.md');
  writeFileSync(rep3, draft((r3.out.match(/^\[qg scope: .*\]$/m) || [''])[0]), 'utf8');
  const v3 = run('tools/evidence-validator.mjs', [rep3, '--gate', '--session', 'F1'], { env });
  check('изменённый во время прохода файл назван в предупреждении', /менялись во время прохода[^\n]*Module\.bsl/.test(v3.out), v3.out.slice(-600));
  check('отметка проверки осталась от прошлого прохода', JSON.stringify(sess().files[bsl].checked) === JSON.stringify(before));
}
```

Строка `scope` в фикстуре `valid.md` заменяется целиком — если в фикстуре её нет на отдельной строке, используй `extractRecords` для поиска и замени по номеру строки. Если валидатор потребует записей, которых требует профиль из `run` (например, `compilation` под иную глубину), допиши их в `draft`: предмет теста — база прохода, а не состав следа.

Порядок проверок важен: приёмка `full` (база `HEAD`) принимает проход 2 и ставит отметку `pass:2`; поэтому `before` для последней проверки снимается после неё, а проход 3 идёт от `pass:2`.

- [ ] **Step 2: Запусти — падает**

Run: `node tests/run-tests.mjs`
Expected: FAIL на «приёмка ставит отметку проверки по снимку».

- [ ] **Step 3: Реализуй**

1. Импорты: `import { acceptPass, updateSession, snapshotBlobs, markChecked, lastAcceptedReport } from './gate-cycle.mjs';`, `import { computeProfile, SCOPE_BASE } from './profile.mjs';`.

2. `ownSession`: в возвращаемый объект добавь `pass: s.cycle?.passes?.at?.(-1) || null, session: s`.

3. Рядом с проверками `rec.type === 'scope'` (~513):

```js
    if (rec.type === 'scope' && rec.fields.base !== undefined && !SCOPE_BASE.test(String(rec.fields.base))) {
      add('error', rec.line, `base="${rec.fields.base}" в записи scope: допустимо HEAD либо pass:<номер> — строку печатает gate.mjs run`);
    }
```

4. Перед сверкой профиля (~826):

```js
  const declaredBase = scopes.length === 1 ? String(scopes[0].fields.base || 'HEAD') : 'HEAD';
  const passBase = own?.pass?.base || 'HEAD';
  if (scopes.length === 1 && declaredBase !== 'HEAD') {
    if (!own?.pass) {
      add('warn', scopes[0].line, `base=${declaredBase}: базу сверить не по чему — сессия не названа (--session) либо прохода нет; объём сверен не будет`);
    } else if (declaredBase !== passBase) {
      add('error', scopes[0].line, `base=${declaredBase} в записи scope, а проход ${own.pass.n} идёт от ${passBase} — перенеси строку scope из вывода run`);
    }
  }
  const recomputeBases = declaredBase === 'HEAD' || !own?.pass ? null : own.pass.bases || null;
```

   и передай `bases: recomputeBases` в `computeProfile` внутри существующего блока сверки. Условие блока `own?.rawFiles?.length` не меняется. Если `declaredBase !== 'HEAD'` и `own?.pass` нет — блок пересчёта пропускается (сверять не с чем; предупреждение уже выдано).

5. Тексты двух ошибок понижения: «перенеси строку scope из вывода run (черновик следа) либо gate.mjs plan — файлы сессии менялись после них, напечатай заново».

6. `main`, блок приёмки:

```js
  if (gate && session && exitCode === 0) {
    try {
      const rootDir = root || projectRoot();
      const marked = updateSession({
        root: rootDir,
        sessionId: session,
        mutate: (s) => {
          acceptPass(s, { report: resolvePath(file) });
          const pass = s.cycle?.passes?.at?.(-1);
          return markChecked(s, snapshotBlobs(rootDir, Object.keys(pass?.blobs || {})));
        },
      });
      if (marked?.changed?.length) {
        process.stdout.write(
          `ПРЕДУПРЕЖДЕНИЕ — файлы менялись во время прохода: ${marked.changed.join(', ')}; отметка проверки им не поставлена, следующий проход посчитает их от прошлой базы.\n`
        );
      }
    } catch {
      /* запись прохода — удобство следующего прохода, не условие приёмки следа */
    }
  }
```

- [ ] **Step 4: Запусти — проходит**

Run: `node tests/run-tests.mjs`
Expected: PASS. Сквозной тест «строка из `gate.mjs plan` → `evidence-validator --gate`» по секциям `DEFAULTS` (поиск: `grep -n "evidence-validator --gate" tests/run-tests.mjs`) тоже зелёный — строка `scope` с `base=HEAD` принимается.

- [ ] **Step 5: Commit**

```bash
git add tools/evidence-validator.mjs tests/run-tests.mjs
git commit -m "feat(след): база прохода в записи scope — сверка с проходом, пересчёт профиля от неё, отметки проверки при приёмке"
```

---

### Task 5: Раздел «Закрыто» и перенос находок прошлого отчёта

**Files:**
- Modify: `tools/evidence-validator.mjs` (`collectFindings` ~421, `reportSections` ~397, `FINDING_SECTIONS` ~366, `validate` — новый блок после сверки профиля)
- Modify: `tools/gate.mjs` (`cmdRelease` ~371: сейчас `residual = reportSections(evidenceText)` — объект целиком; после этой задачи в нём появится `closed`, а остаток по спецификации — только три раздела)
- Test: `tests/run-tests.mjs`

**Interfaces:**
- Consumes: `ownSession(...).session`, `.pass` (Task 4); `lastAcceptedReport(session, { before })` (Task 1); `reportSections(...).ids` (Task 3).
- **Зависимость тестов:** блок стоит сразу после блока Task 4 и берёт его конечное состояние стенда `fixpass-root` (см. Task 4, «Зависимость тестов»): три прохода, последний — третий, от `pass:2`. Блок переназначает отчёт прохода 2 на `carry-prev.md` и снимает приёмку прохода 3; строка `scope` берётся из `fixpass-v3.md`.
- Produces:
  - `collectFindings`: заголовок раздела, совпадающий с `CLOSED_SECTION = /^закрыт/i` и не являющийся находкой, даёт раздел `closed` — находки под ним разбираются, но не блокируют (`severeFindings` берёт только `change`). Проверка `CLOSED_SECTION` идёт раньше `NOT_FINDINGS`.
  - `reportSections(text)` → дополнительно `closed: [...]` (поле `ids` у находок — из Task 3).
  - `findingKey(f)` → `ids` через запятую в порядке сортировки либо `title:<заголовок в нижнем регистре без пробелов по краям>`, если идентификаторов нет.
  - `carriedOver(prevText, text)` → `{ missing: f[], missingById: f[] }`: мультимножество ключей открытых находок прошлого отчёта (`inChange`, `outside`, `needsDecision`) минус мультимножество ключей нового (`closed`, `inChange`, `outside`, `needsDecision`). Экспорт.
  - Правило в `validate` при `gate` и известном прошлом принятом отчёте (`lastAcceptedReport(own.session, { before: own.pass.n })`): находка с идентификаторами, которой нет в новом отчёте, — ошибка с её заголовком; без идентификаторов — предупреждение. Прошлый отчёт не читается — предупреждение, сверка не идёт.
  - `FINDING_SECTIONS` получает `CLOSED_SECTION`: «Закрыто» списком без заголовков называется в предупреждении по имени.

- [ ] **Step 1: Напиши падающий тест**

```js
// Проход по исправлению не теряет находок: каждая открытая находка прошлого отчёта обязана
// быть в новом — закрытой либо в своём разделе. Иначе остаток release вышел бы урезанным.
{
  const { reportSections, carriedOver, severeFindings } = await import(pathToFileURL(join(ROOT, 'tools', 'evidence-validator.mjs')).href);
  // 🔴 под «Закрыто» — самый жёсткий случай: он не должен держать снятие и не должен попасть в остаток.
  const prev = [
    '# Отчёт', '', '## Открыто в правке', '', '### 🔴 Запрос в цикле', 'm.bsl:5, qg:DB-READ-IN-LOOP', '',
    '### 🟡 Магическое число', 'm.bsl:7, qg:MAGIC-NUMBER', '', '## Вне правки', '', '### 🟡 Длинный метод', 'm.bsl:40', '',
  ].join('\n');
  const closedOnly = [
    '# Отчёт', '', '## Закрыто', '', '### 🔴 Запрос в цикле', 'Исправлено: выборка вынесена из цикла, qg:DB-READ-IN-LOOP', '',
    '## Вне правки', '', '### 🟡 Длинный метод', 'm.bsl:41', '',
  ].join('\n');
  const s = reportSections(closedOnly);
  check('раздел «Закрыто» разбирается', s.closed?.length === 1 && s.closed[0].ids.includes('qg:DB-READ-IN-LOOP'), JSON.stringify(s.closed));
  check('находка под «Закрыто» не блокирует', severeFindings(closedOnly).length === 0);
  check('находка под «Закрыто» не входит в остаток', s.inChange.length === 0);
  const lost = carriedOver(prev, closedOnly);
  check('пропавшая находка с идентификатором названа', lost.missingById.length === 1 && /Магическое число/.test(lost.missingById[0].title), JSON.stringify(lost));
  const full = closedOnly.replace('## Вне правки', '## Открыто в правке\n\n### 🟡 Магическое число\nm.bsl:8, qg:MAGIC-NUMBER\n\n## Вне правки');
  check('все находки на месте — пропавших нет', carriedOver(prev, full).missingById.length === 0 && carriedOver(prev, full).missing.length === 0);
  const renamed = full.replace('Длинный метод', 'Метод на 120 строк');
  check('находка без идентификатора с новым заголовком — только предупреждение', carriedOver(prev, renamed).missing.length === 1 && carriedOver(prev, renamed).missingById.length === 0);

  // В режиме гейта по сессии: прошлый принятый отчёт берётся из записи прохода.
  const fr = join(WORK, 'fixpass-root');
  const env = { CLAUDE_PROJECT_DIR: fr };
  const p = join(fr, '.claude', '.state', 'qg-pending.json');
  const st = JSON.parse(readFileSync(p, 'utf8'));
  const passes = st.sessions.F1.cycle.passes;
  const prevPath = join(WORK, 'carry-prev.md');
  writeFileSync(prevPath, prev, 'utf8');
  passes[passes.length - 2].report = prevPath;
  passes[passes.length - 2].acceptedAt = new Date().toISOString();
  delete passes[passes.length - 1].report;
  delete passes[passes.length - 1].acceptedAt;
  writeFileSync(p, JSON.stringify(st, null, 2), 'utf8');
  // Последний проход стенда — третий, от pass:2: строка scope берётся из его отчёта (Task 4).
  const scope = (readFileSync(join(WORK, 'fixpass-v3.md'), 'utf8').match(/^\[qg scope: .*\]$/m) || [''])[0];
  const body = (prose) => prose + '\n\n' + readFileSync(ev('valid.md'), 'utf8').slice(readFileSync(ev('valid.md'), 'utf8').indexOf('## quality evidence')).replace(/^\[qg scope: .*\]$/m, scope) +
    '[qg not_verified: dimension=static-analysis, reason=not_in_analyzer_report, files=1]\n';
  const lostRep = join(WORK, 'carry-lost.md');
  writeFileSync(lostRep, body(closedOnly), 'utf8');
  const vl = run('tools/evidence-validator.mjs', [lostRep, '--gate', '--session', 'F1'], { env });
  check('валидатор отказывает, если находка прошлого отчёта пропала', vl.code !== 0 && /Магическое число/.test(vl.out) && /прошлого отчёта/.test(vl.out), vl.out.slice(0, 800));
  const okRep = join(WORK, 'carry-ok.md');
  writeFileSync(okRep, body(full), 'utf8');
  const vo = run('tools/evidence-validator.mjs', [okRep, '--gate', '--session', 'F1'], { env });
  check('все находки перенесены — отчёт принят', vo.code === 0, vo.out.slice(0, 800));

  // Снятие по отчёту прохода по исправлению: release вызывает validate с сессией, то есть та
  // же сверка базы и переноса работает и здесь; 🔴 под «Закрыто» снятие не держит.
  const rel = run('tools/gate.mjs', ['release', '--session', 'F1', '--evidence', okRep], { env });
  check('гейт снимается по отчёту прохода по исправлению', rel.code === 0, rel.out.slice(0, 800));
  const doneRec = JSON.parse(readFileSync(join(fr, '.claude', '.state', 'qg-done.json'), 'utf8')).sessions.F1;
  check('закрытые находки в остаток не входят',
    doneRec?.residual && !('closed' in doneRec.residual) && !JSON.stringify(doneRec.residual).includes('Запрос в цикле')
      && doneRec.residual.inChange.some((f) => /Магическое число/.test(f.title)), JSON.stringify(doneRec?.residual));
}
```

Если блок вывода `valid.md` в фикстуре начинается иначе, чем `## quality evidence`, возьми хвост по `SECTION` из `evidence-validator.mjs`.

- [ ] **Step 2: Запусти — падает**

Run: `node tests/run-tests.mjs`
Expected: FAIL на «раздел «Закрыто» разбирается» (`s.closed` нет).

- [ ] **Step 3: Реализуй**

1. Константа рядом с `OUTSIDE_SECTION`: `const CLOSED_SECTION = /^закрыт/i;` и в `FINDING_SECTIONS` добавь её третьей.

2. В `collectFindings` расчёт раздела:

```js
    const section = isFinding
      ? parentSection || 'change'
      : CLOSED_SECTION.test(title) ? 'closed'
      : OUTSIDE_SECTION.test(title) ? 'outside'
      : DECISION_SECTION.test(title) ? 'decision'
      : parentSection || 'change';
    const entry = {
      level,
      section,
      excluded: stack.some((s) => s.excluded) || (section === 'change' && !isFinding && NOT_FINDINGS.test(title)),
    };
```

   `parentSection` должен подхватывать и `closed`: условие фильтра `x && x !== 'change'` уже это делает.

3. `reportSections` (поле `ids` уже добавлено в Task 3; здесь появляется `closed`) и сверка переноса:

```js
export function reportSections(text) {
  const all = collectFindings(text).map((f) => ({
    sev: f.sev, title: f.title, line: f.line, section: f.section,
    ids: [...new Set(([f.title, ...f.body].join('\n').match(FINDING_ID) || []).map(normId))].sort(),
  }));
  return {
    inChange: all.filter((f) => f.section === 'change'),
    outside: all.filter((f) => f.section === 'outside'),
    needsDecision: all.filter((f) => f.section === 'decision'),
    closed: all.filter((f) => f.section === 'closed'),
  };
}

const findingKey = (f) => (f.ids.length ? f.ids.join(',') : `title:${f.title.trim().toLowerCase()}`);

/**
 * Находки прошлого отчёта, которых нет в новом. Ключ — идентификаторы без строки: строки
 * между проходами сдвигаются. Без идентификаторов ключ — заголовок, и пропажа по нему только
 * предупреждение: переименованная находка неотличима от исчезнувшей.
 */
export function carriedOver(prevText, text) {
  const prev = reportSections(prevText);
  const cur = reportSections(text);
  const pool = new Map();
  for (const f of [...cur.closed, ...cur.inChange, ...cur.outside, ...cur.needsDecision]) {
    const k = findingKey(f);
    pool.set(k, (pool.get(k) || 0) + 1);
  }
  const missing = [];
  const missingById = [];
  for (const f of [...prev.inChange, ...prev.outside, ...prev.needsDecision]) {
    const k = findingKey(f);
    if (pool.get(k)) pool.set(k, pool.get(k) - 1);
    else (f.ids.length ? missingById : missing).push(f);
  }
  return { missing, missingById };
}
```

4. В `validate` после блока сверки профиля:

```js
  if (gate && own?.pass && own.session) {
    const prev = lastAcceptedReport(own.session, { before: own.pass.n });
    if (prev) {
      let prevText = null;
      try { prevText = readFileSync(prev.report, 'utf8'); } catch { /* ниже */ }
      if (prevText === null) {
        add('warn', 0, `прошлый отчёт прохода ${prev.n} не читается (${prev.report}) — перенос его находок не сверен`);
      } else {
        const { missing, missingById } = carriedOver(prevText, text);
        for (const f of missingById) {
          add('error', 0, `находка прошлого отчёта (проход ${prev.n}) «${f.sev} ${f.title}» [${f.ids.join(', ')}] отсутствует: помести её в «Закрыто» с проверкой по коду либо оставь в её разделе`);
        }
        for (const f of missing) {
          add('warn', 0, `находка прошлого отчёта (проход ${prev.n}) «${f.sev} ${f.title}» не найдена по заголовку — проверь, что она перенесена`);
        }
      }
    }
  }
```

5. `cmdRelease` в `tools/gate.mjs` (~371): `const { inChange, outside, needsDecision } = reportSections(evidenceText); residual = { inChange, outside, needsDecision };` — закрытое за цикл в остаток не входит.

- [ ] **Step 4: Запусти — проходит**

Run: `node tests/run-tests.mjs`
Expected: PASS, включая тесты v3.16 о разделах «Вне правки» и «Нужно решение» и о `residual`.

- [ ] **Step 5: Commit**

```bash
git add tools/evidence-validator.mjs tools/gate.mjs tests/run-tests.mjs
git commit -m "feat(след): раздел «Закрыто» и перенос находок прошлого отчёта на проходе по исправлению"
```

---

### Task 6: Субагенты и навык: проход по исправлению, `--session` у валидатора, раздел «Закрыто»

**Files:**
- Modify: `agents/gate-runner.md` (шаг 3 «Порядок» ~70; раздел «Разделы отчёта» ~93; абзац «Изменённые файлы … читай `Read` целиком» ~144; блок «Ответ» ~150)
- Modify: `skills/quality-gate/SKILL.md` (вызов валидатора ~191; шаг 2 о повторе `run`; шаг 5 — разделы отчёта)
- Create: `skills/quality-gate/references/fix-pass.md`
- Modify: `agents/antipattern-reader.md` (~44), `agents/cold-reader.md` (~88)
- Modify: `tests/run-tests.mjs` (`BUDGET['quality-gate']` с комментарием; проверки полноты правил рядом с `gate-runner: …` ~3720)

**Interfaces:**
- Consumes: вывод `run` из Task 3 (`## База прохода`, `Прошлый отчёт:`, `## Находки прошлого отчёта`, `fix.diff`); правила валидатора из Task 4–5.
- Produces: тексты; тесты полноты правил.

- [ ] **Step 1: Напиши падающие проверки полноты правил**

В `tests/run-tests.mjs`, в массив пар `[метка, строка]` для `gate-runner` (~3715–3727), добавь:

```js
      ['--gate --session', 'валидатор с сессией — иначе проход не принимается и отметок проверки нет'],
      ['## Закрыто', 'раздел закрытых находок прошлого отчёта'],
      ['fix.diff', 'проход по исправлению читает разницу от базы'],
      ['Проход: N из 3, база:', 'строка ответа с базой прохода'],
      ['Закрыто: N из M', 'строка ответа о закрытии'],
      ['сохраняет идентификатор', 'запись под «Закрыто» несёт идентификатор находки — по нему валидатор сверяет перенос'],
```

И отдельные проверки:

```js
  {
    const skill = readFileSync(join(ROOT, 'skills', 'quality-gate', 'SKILL.md'), 'utf8');
    check('quality-gate: валидатор вызывается с --session', /evidence-validator\.mjs" <файл отчёта> --gate --session <id>/.test(skill));
    check('quality-gate: навык называет справочник прохода по исправлению', skill.includes('references/fix-pass.md'));
    for (const a of ['antipattern-reader', 'cold-reader']) {
      const t = readFileSync(join(ROOT, 'agents', `${a}.md`), 'utf8');
      check(`${a}: правило прохода по исправлению`, t.includes('fix.diff'));
    }
  }
```

- [ ] **Step 2: Запусти — падает**

Run: `node tests/run-tests.mjs`
Expected: FAIL на новых строках полноты.

- [ ] **Step 3: Тексты**

1. `agents/gate-runner.md`, шаг 3: `` `node "<Каталог плагина>/tools/evidence-validator.mjs" <отчёт> --gate --session <id>` `` и фраза: «Без `--session` проход не принимается: отметки проверки не ставятся, и следующий проход снова читает правку целиком».

2. `agents/gate-runner.md`, новый раздел после «Разделы отчёта»:

```markdown
## Проход по исправлению

`run` печатает `база pass:K` и раздел `## База прохода`, если прошлый проход принят. Тогда:

- Модельные слои читают `fix.diff` из каталога прогона — разницу со снимком проверенного — и
  прошлый отчёт (`Прошлый отчёт:` в выводе `run`). Файл целиком не перечитывается: старый код
  проверен, повторное чтение даёт случайные новые находки в нём, а не проверку исправления.
  Строки за пределами разницы читай точечно, если без них исправление непонятно.
- Субагентам слоёв передавай `fix.diff` и прошлый отчёт вместо списка файлов целиком. `change.diff`
  остаётся для `catalog.mjs attest --diff`.
- Каждая находка из `## Находки прошлого отчёта` попадает в новый отчёт: в `## Закрыто`, если
  закрытие проверено по коду (с оценкой причины, если автор находку отклонил), либо остаётся в
  своём разделе. Запись под `## Закрыто` — заголовок с уровнем, как у любой находки, и
  сохраняет идентификатор находки из квадратных скобок вывода `run`: по нему валидатор сверяет
  перенос, и пропавшую находку с идентификатором он отклоняет.
- Классификация «в правке / вне правки» — по-прежнему по таблице `Задето правкой` (от HEAD).
- Файлы, названные «от HEAD» в `## База прохода`, проверяются полностью, как на первом проходе.
```

3. Абзац ~144: «Изменённые файлы из состава правки читай `Read` целиком; на проходе по исправлению — только `fix.diff` и точечно (раздел «Проход по исправлению»)».

4. Блок «Ответ»: строку `Проход: N из 3` замени на `Проход: N из 3, база: HEAD | pass:K` и добавь после неё `Закрыто: N из M — находок прошлого отчёта` (только со второго прохода).

5. `agents/antipattern-reader.md` ~44 — вторым предложением пункта 1: «На проходе по исправлению вход — `fix.diff` и прошлый отчёт: читай изменённые строки и методы, которые они задевают; файл целиком — только если путь назван в задании как „от HEAD“». `agents/cold-reader.md` ~88 — аналогично: «На проходе по исправлению предмет чтения — `fix.diff`, а не файлы целиком».

6. `skills/quality-gate/SKILL.md`:
   - вызов валидатора: `node "$QG/tools/evidence-validator.mjs" <файл отчёта> --gate --session <id>`;
   - в шаг 2 после «После правки кода повтори `run`.»: «Повтор после принятого отчёта — проход по исправлению: `run` печатает базу, прошлый отчёт и его находки; слоям — `fix.diff` (`references/fix-pass.md`)»;
   - в шаг 5 к перечню разделов: «`## Закрыто` — со второго прохода: находки прошлого отчёта, закрытие которых проверено по коду».

7. `skills/quality-gate/references/fix-pass.md` — обоснование: зачем снимок и база (замер 27 проходов, повторное чтение, случайные находки в старом коде); что считается от базы и что от HEAD; почему `--only` продолжает проход; что значит `base_missing`; почему пропажа находки с идентификатором — ошибка, а без — предупреждение; граница «проход по исправлению не ищет пропущенное первым проходом — для этого состязательный аудит». Тексты стандартов не воспроизводить, проектных имён нет.

8. `BUDGET['quality-gate']`: измерь размер навыка после правки (`node -e "console.log(require('fs').statSync('skills/quality-gate/SKILL.md').size)"`). Если больше 15,5 КБ — подними до ближайшего полукилобайта сверху и допиши комментарий: «N вместо 15,5 КБ: проход по исправлению — команда валидатора с `--session` и правило чтения `fix.diff`; это исполняемое, обоснование вынесено в `references/fix-pass.md`. Фактический размер — X КБ.»

- [ ] **Step 4: Запусти**

Run: `node tests/run-tests.mjs && node tools/validate-package.mjs`
Expected: PASS; проверка «справочник, которого не называет ни навык, ни соседний справочник» видит `fix-pass.md` через ссылку из навыка.

- [ ] **Step 5: Commit**

```bash
git add agents/gate-runner.md agents/antipattern-reader.md agents/cold-reader.md skills/quality-gate/SKILL.md skills/quality-gate/references/fix-pass.md tests/run-tests.mjs
git commit -m "feat(гейт): проход по исправлению в субагентах и навыке — fix.diff, раздел «Закрыто», валидатор с --session"
```

---

### Task 7: Документация

**Files:**
- Modify: `README.md` (раздел о цикле проходов, добавленный в v3.16 — поиск: `grep -n "проход" README.md`; вызовы валидатора в режиме гейта ~556 и ~746 — добавить `--session <id>` с пояснением «без сессии проход не принимается»)
- Modify: `skills/quality-gate/references/evidence-format.md` (описание записи `scope` — поле `base`; раздел `verified_earlier` ~446 — связь с `## База прохода`; вызов `--gate` ~459 — добавить `--session <id>`)

Перед правкой перепроверь полноту перечня: `grep -rn "evidence-validator.mjs.*--gate" --include=*.md --include=*.js --include=*.mjs . | grep -v "^./tests/\|^./docs/superpowers/"` — каждый вызов в режиме гейта вне тестов получает `--session <id>` (агент и навык правит Task 6).
- Modify: `docs/OPENCODE.md` — только если в нём перечислены поля состояния или вывод `run`; иначе без изменений

- [ ] **Step 1: README** — абзац «Проход по исправлению»: второй и третий проход считаются от снимка прошлого принятого прохода; объём и глубина — по разнице, граница правки — от HEAD; находки прошлого отчёта переносятся в «Закрыто» или остаются в своём разделе; пропавший снимок даёт полный проход. Без счётчиков состава (правило памяти «Никаких счётчиков состава в документации»).

- [ ] **Step 2: evidence-format.md** — поле `base=HEAD|pass:<n>` записи `scope`: печатает `run`, необязательно (нет — значит `HEAD`), валидатор сверяет с записью прохода по `--session` и пересчитывает объём от той же базы; заявить `HEAD` на проходе по исправлению можно (проверка полнее), чужой номер — нельзя.

- [ ] **Step 3: Проверка**

Run: `node tools/validate-package.mjs && node tests/run-tests.mjs`
Expected: PASS (ссылки целы, утечек нет).

- [ ] **Step 4: Commit**

```bash
git add README.md skills/quality-gate/references/evidence-format.md docs/OPENCODE.md
git commit -m "docs(гейт): проход по исправлению — база прохода, поле base в scope, раздел «Закрыто»"
```

---

### Task 8: A/B агента и навыка, выпуск v3.17.0

**Files:**
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`, `README.md`, `docs/OPENCODE.md`, `opencode/opencode.json.example` — версия `3.17.0` (тот же набор, что в commit `b705145`).

- [ ] **Step 1: A/B до выпуска** (правило памяти «Бюджет A/B»: при правке агентов и навыков обязателен; способ — `--plugin-dir`; ловушки — «Ловушки headless A/B»: Stop в `-p` не останавливает, haiku переписывает команды, фоновые подпроцессы гибнут, один запуск не отделяет доллары от разброса). Стенд: копия малого 1С-проекта в каталоге scratchpad, одна правка с заведомой 🟡 в задетом методе. Сценарий на обеих сторонах (A — установленный 3.16.0, B — ветка через `--plugin-dir`): проход 1 → исправление 🟡 → проход 2. Сравнить по журналам: вызовы инструментов и `Read` на проходе 2, минуты, состав находок, наличие `## Закрыто`, приёмку валидатором с `--session` и появление `checked` в состоянии. Критерий: на стороне B проход 2 не читает модуль целиком, находка прохода 1 стоит в «Закрыто», отчёт принят с первого или второго захода. Регрессия (B теряет находку или валидатор отклоняет собственный вывод) — блокер выпуска.

- [ ] **Step 2: Версия** — `3.17.0` во всех файлах списка выше (поиск: `grep -rn "3\.16\.0" .claude-plugin package.json README.md docs/OPENCODE.md opencode/opencode.json.example`).

- [ ] **Step 3: Полная проверка**

```bash
node tests/run-tests.mjs
```

```bash
node tests/gate-core.test.mjs
```

```bash
node tools/validate-package.mjs
```

Expected: всё PASS.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin package.json README.md docs/OPENCODE.md opencode/opencode.json.example
git commit -m "chore(релиз): v3.17.0"
```

- [ ] **Step 5: Выпуск до пользователя** (правило памяти «Исправление доводится до пользователей самим»): PR в `main`, слияние после зелёного CI, тег `v3.17.0`, релиз, обновление установленного плагина, проверка на рабочем проекте — одна правка, два прохода, по журналам: число проходов на цикл, минуты на проход 2, прирост строк правки между проходами (спецификация, раздел «Проверка»).
