#!/usr/bin/env node
/**
 * Тесты V2-реализации плагина OpenCode (setup(ctx) из opencode/plugin/quality-gate.js):
 * регистрация навыков/команд/субагентов/MCP трансформами, окружение оболочки,
 * взвод гейта через tool-хуки, мягкий гейт на session.execution.succeeded.
 * Запуск: node tests/opencode-plugin-v2.test.mjs
 *
 * ctx здесь — мок ровно той формы, что читает плагин: трансформы с редактором,
 * доменные хуки, очередь событий. Это не проверка против живого OpenCode, а фиксация
 * контракта, на который плагин опирается, — смена контракта покраснеет здесь.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const PLUGIN_URL = pathToFileURL(join(import.meta.dirname, '..', 'opencode', 'plugin', 'quality-gate.js')).href;

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`ok — ${name}`); }
  else { failed++; console.error(`FAIL — ${name}`); }
}

/** Очередь событий для ctx.event.subscribe: emit() кормит поток, close() завершает. */
function makeEventBus() {
  const queue = [];
  const waiters = [];
  return {
    emit(event) {
      const w = waiters.shift();
      if (w) w({ value: event, done: false });
      else queue.push(event);
    },
    close() {
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    subscribe() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
              return new Promise((resolve) => waiters.push(resolve));
            },
          };
        },
      };
    },
  };
}

function makeCtx(root) {
  const prompts = [];
  const skills = new Map();
  const commands = new Map();
  const agents = new Map();
  const mcp = new Map();
  const toolHooks = { 'execute.before': [], 'execute.after': [] };
  const shellHooks = [];
  const bus = makeEventBus();

  const registration = { dispose: async () => {} };

  const ctx = {
    location: { directory: root, project: { id: 'p', directory: root, canonical: root } },
    prompts,
    skills,
    commands,
    agents,
    mcp,
    bus,
    skill: {
      transform: async (cb) => {
        cb({
          get: (id) => skills.get(id),
          add: (s) => skills.set(s.id, s),
          update: () => {},
          remove: (id) => skills.delete(id),
          list: () => [...skills.values()],
        });
        return registration;
      },
    },
    command: {
      list: async () => [...commands.values()],
      transform: async (cb) => {
        cb({ add: (d) => commands.set(d.name, d) });
        return registration;
      },
    },
    agent: {
      transform: async (cb) => {
        cb({
          // update на отсутствующей записи создаёт её — поведение редактора V2,
          // на которое опираются плагины, поставляющие свои агенты.
          update: (id, fn) => {
            const a = agents.get(id) || {};
            fn(a);
            agents.set(id, a);
          },
          get: (id) => agents.get(id),
          list: () => [...agents.values()],
          default: () => {},
          remove: (id) => agents.delete(id),
        });
        return registration;
      },
    },
    mcpDomain: null,
    shell: {
      hook: async (name, cb) => {
        if (name === 'create.before') shellHooks.push(cb);
        return registration;
      },
    },
    tool: {
      hook: async (name, cb) => {
        toolHooks[name].push(cb);
        return registration;
      },
    },
    event: { subscribe: () => bus.subscribe() },
    session: {
      prompt: async (req) => { prompts.push(req); return {}; },
    },
  };
  ctx.mcpDomain = {
    transform: async (cb) => {
      cb({
        get: (n) => mcp.get(n),
        set: (n, c) => mcp.set(n, c),
        update: () => {},
        remove: (n) => mcp.delete(n),
        list: () => [...mcp.entries()],
      });
      return registration;
    },
  };
  ctx.mcp = ctx.mcpDomain;
  ctx.mcpServers = mcp; // Map наружу: поле mcp занято доменом трансформов
  return ctx;
}

/**
 * Вызов инструмента через зарегистрированные хуки. Событие execute.after собирается в
 * форме типов V2: при status "completed" — result, при "error" — error без result.
 * Возвращается именно оно: плагин вправе подменить event.result, и проверять нужно его.
 */
async function callTool(ctx, { id, tool, input, result, status = 'completed', sessionID = 's1' }) {
  for (const h of ctx.__toolHooks['execute.before']) await h({ tool, sessionID, id, input });
  const ev =
    status === 'error'
      ? { tool, sessionID, id, input, status, error: { message: 'сбой' } }
      : { tool, sessionID, id, input, status, result };
  for (const h of ctx.__toolHooks['execute.after']) await h(ev);
  return ev;
}

/** ctx с наружным доступом к хукам инструментов; плагин уже подключён. */
async function setupHooked(rootDir) {
  const c = makeCtx(rootDir);
  const hooks = { 'execute.before': [], 'execute.after': [] };
  c.tool.hook = async (name, cb) => { hooks[name].push(cb); return { dispose: async () => {} }; };
  c.__toolHooks = hooks;
  const cleanup = await mod.default.setup(c);
  return { c, cleanup };
}

/** Поток событий по массиву: новые элементы, добавленные в массив позже, тоже читаются. */
function feed(arr) {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise((resolve) => {
            const t = () => (i < arr.length ? resolve({ value: arr[i++], done: false }) : setTimeout(t, 5));
            t();
          }),
      };
    },
  };
}

const root = mkdtempSync(join(tmpdir(), 'qg-oc2-test-'));
const ctx = makeCtx(root);
// Прокси для удобства тестов: списки хуков наружу.
const mod = await import(PLUGIN_URL);

check('default-экспорт — определение V2 с id и setup', mod.default?.id === '1c-quality-gate' && typeof mod.default?.setup === 'function');
check('V1-совместимость сохранена: server и именованный экспорт', typeof mod.default?.server === 'function' && typeof mod.QualityGatePlugin === 'function');

const cleanup = await mod.default.setup(ctx);
check('setup вернул функцию выгрузки', typeof cleanup === 'function');

// Достаём зарегистрированные хуки через повторный setup-мок: проще — пробросим
// инструментальные хуки наружу через ctx, который мы же и собрали.
// (makeCtx хранит их в замыкании; для теста соберём ещё один ctx с наружным доступом.)
const ctx2raw = makeCtx(root);
const toolHooks2 = { 'execute.before': [], 'execute.after': [] };
ctx2raw.tool.hook = async (name, cb) => { toolHooks2[name].push(cb); return { dispose: async () => {} }; };
ctx2raw.__toolHooks = toolHooks2;
const shellHooks2 = [];
ctx2raw.shell.hook = async (name, cb) => { if (name === 'create.before') shellHooks2.push(cb); return { dispose: async () => {} }; };
await mod.default.setup(ctx2raw);

// ── Регистрация состава пакета ──
check('навыки зарегистрированы трансформом',
  ['quality-gate', 'bsl-code-review', 'bsl-architecture-review', 'xml-structure-review', 'file-hygiene']
    .every((n) => ctx2raw.skills.has(n)));
const qg = ctx2raw.skills.get('quality-gate');
check('навык едет с описанием, абсолютным путём и содержимым',
  typeof qg?.description === 'string' && qg.description.length > 10 && qg.path.endsWith('SKILL.md') && qg.content.includes('---'));

check('команды зарегистрированы', ctx2raw.commands.has('gate') && ctx2raw.commands.has('gate-status'));

check('субагенты зарегистрированы из общего каталога agents/',
  ['bsl-verifier', 'bsl-scout', 'xml-runner'].every((n) => typeof ctx2raw.agents.get(n)?.system === 'string'));
const scout = ctx2raw.agents.get('bsl-scout');
check('субагент — subagent с описанием', scout?.mode === 'subagent' && typeof scout?.description === 'string');
// Правила V2: last-match-wins, база allow первой, отказы после неё.
const rules = scout?.permissions || [];
const denyEdit = rules.find((r) => r.action === 'edit' && r.effect === 'deny');
const allowAll = rules.find((r) => r.action === '*' && r.effect === 'allow');
check('читатель закрыт от правки правилом deny edit', !!denyEdit);
check('разрешающая база стоит ПЕРЕД отказами (last-match-wins)',
  allowAll && denyEdit && rules.indexOf(allowAll) < rules.indexOf(denyEdit));

// Действие правила в V2 равно имени инструмента (shell, subagent, skill, grep, glob, read),
// а write, edit и patch запрашивают одно действие `edit` (packages/core/src/tool/plugin/*.ts
// в OpenCode). Проверяем итог по last-match-wins, а не наличие отдельных строк: именно он
// решает, откроет ли OpenCode инструмент агенту.
const effective = (agent, action) => {
  let verdict = null;
  for (const r of agent?.permissions || []) if (r.action === '*' || r.action === action) verdict = r.effect;
  return verdict;
};
const verifier = ctx2raw.agents.get('bsl-verifier');
check('верификатору разрешён shell, закрыты правка и запуск субагентов',
  effective(verifier, 'shell') === 'allow' && effective(verifier, 'edit') === 'deny' && effective(verifier, 'subagent') === 'deny');
check('читатель закрыт от shell и субагентов (запреты Bash и Agent действуют)',
  effective(scout, 'shell') === 'deny' && effective(scout, 'subagent') === 'deny');
const gateRunner = ctx2raw.agents.get('gate-runner');
check('исполнитель гейта может писать отчёт: Write открыт, значит действие edit открыто',
  effective(gateRunner, 'edit') === 'allow');
check('исполнитель гейта запускает субагентов контуров и оболочку',
  effective(gateRunner, 'subagent') === 'allow' && effective(gateRunner, 'shell') === 'allow');
const xmlRunner = ctx2raw.agents.get('xml-runner');
check('закрытый список tools: неперечисленное закрыто, перечисленное открыто',
  effective(xmlRunner, 'edit') === 'deny' && effective(xmlRunner, 'subagent') === 'deny' && effective(xmlRunner, 'shell') === 'allow');

check('MCP v8std зарегистрирован как remote', ctx2raw.mcpServers.get('v8std')?.type === 'remote' && ctx2raw.mcpServers.get('v8std')?.url?.includes('v8std'));

// Своё имя сильнее: существующие записи пользователя не перекрываются.
const ctx3 = makeCtx(root);
ctx3.mcpServers.set('v8std', { type: 'local', command: ['своё'] });
ctx3.skills.set('quality-gate', { id: 'quality-gate', name: 'мой', description: 'свой навык', path: '/своё', content: 'своё' });
ctx3.agents.set('bsl-scout', { id: 'bsl-scout', name: 'мой агент' });
await mod.default.setup(ctx3);
check('записи пользователя не перекрываются',
  ctx3.mcpServers.get('v8std').type === 'local' &&
  ctx3.skills.get('quality-gate').name === 'мой' &&
  ctx3.agents.get('bsl-scout').name === 'мой агент');

// ── Окружение оболочки ──
{
  const env = {};
  for (const h of shellHooks2) await h({ env, command: 'x', cwd: root, timeout: 1, shell: 'sh' });
  check('create.before отдаёт QG_ROOT на корень пакета', existsSync(join(env.QG_ROOT || '', 'hooks', 'gate-core.mjs')));
  check('create.before отдаёт QG_PROJECT_DIR и QG_STATE_DIR', env.QG_PROJECT_DIR === root && env.QG_STATE_DIR === '.opencode/.state');
  check('create.before сообщает имя инструмента запуска субагентов V2', env.QG_SUBAGENT_TOOL === 'subagent');
  const preset = { QG_ROOT: '/своё', QG_PROJECT_DIR: '/своё', QG_STATE_DIR: 'своё' };
  for (const h of shellHooks2) await h({ env: preset });
  check('заданное пользователем окружение не перекрывается', preset.QG_ROOT === '/своё' && preset.QG_STATE_DIR === 'своё');
}

// ── Взвод гейта ──
const bslPath = join(root, 'CommonModules', 'Модуль', 'Module.bsl');
mkdirSync(join(root, 'CommonModules', 'Модуль'), { recursive: true });
writeFileSync(bslPath, 'Процедура Тест() КонецПроцедуры\n', 'utf8');

const ev1 = await callTool(ctx2raw, { id: 'c1', tool: 'write', input: { path: bslPath }, result: { content: 'файл записан' } });

const pendingPath = join(root, '.opencode', '.state', 'qg-pending.json');
check('правка .bsl взвела гейт в .opencode/.state', existsSync(pendingPath));
check('подсказка дописана в строковый content новым result (документированный способ V2)',
  typeof ev1.result.content === 'string' && ev1.result.content.includes('QUALITY GATE') && ev1.result.content.startsWith('файл записан'));

// Результат частями: подсказка уходит в последнюю текстовую часть, прочее не трогается.
const img = { type: 'image', data: '…' };
const frozenParts = Object.freeze([Object.freeze({ type: 'text', text: 'часть 1' }), img]);
writeFileSync(bslPath, 'Процедура Тест2() КонецПроцедуры\n', 'utf8');
// Результат и его части заморожены (в типах V2 они readonly): правка на месте упала бы,
// подмена event.result — документированный способ — нет.
const ev2 = await callTool(ctx2raw, { id: 'c2', tool: 'edit', input: { path: bslPath }, result: Object.freeze({ content: frozenParts }) });
check('подсказка в текстовой части, нетекстовые части целы, исходный результат не тронут',
  ev2.result.content[0].text.includes('QUALITY GATE') && ev2.result.content[1] === img && frozenParts[0].text === 'часть 1');

// Провалившийся вызов гейт не взводит.
const markerBefore = readFileSync(pendingPath, 'utf8');
await callTool(ctx2raw, { id: 'c3', tool: 'write', input: { path: join(root, 'CommonModules', 'Модуль', 'Module.bsl') }, result: {}, status: 'error' });
check('error-статус гейт не взводит', readFileSync(pendingPath, 'utf8') === markerBefore);

// Чтение и нецелевые файлы гейт не трогают.
await callTool(ctx2raw, { id: 'c4', tool: 'read', input: { path: bslPath }, result: { content: 'ok' } });
writeFileSync(join(root, 'README.md'), '# t\n', 'utf8');
await callTool(ctx2raw, { id: 'c5', tool: 'write', input: { path: join(root, 'README.md') }, result: { content: 'ok' } });
check('read и не-1С файлы гейт не взводят', readFileSync(pendingPath, 'utf8') === markerBefore);

// ── Инструмент patch ──
// У patch нет аргумента-пути: файлы лежат в тексте патча (Add File / Update File / Move to).
{
  const pRoot = mkdtempSync(join(tmpdir(), 'qg-oc2-patch-'));
  const { c } = await setupHooked(pRoot);
  mkdirSync(join(pRoot, 'CommonModules', 'Патч', 'Ext'), { recursive: true });
  writeFileSync(join(pRoot, 'CommonModules', 'Патч', 'Ext', 'Module.bsl'), 'Процедура П() КонецПроцедуры\n', 'utf8');
  writeFileSync(join(pRoot, 'README.md'), 'x\n', 'utf8');
  const patchText = [
    '*** Begin Patch',
    '*** Add File: CommonModules/Патч/Ext/Module.bsl',
    '+Процедура П() КонецПроцедуры',
    '*** Update File: README.md',
    '@@',
    '-x',
    '+y',
    '*** End Patch',
  ].join('\n');
  const evP = await callTool(c, { id: 'p1', tool: 'patch', input: { patchText }, result: { content: 'применён' } });
  const pend = join(pRoot, '.opencode', '.state', 'qg-pending.json');
  const files = existsSync(pend) ? Object.keys(JSON.parse(readFileSync(pend, 'utf8')).sessions?.s1?.files || {}) : [];
  check('patch: модуль из текста патча взводит гейт', files.includes('CommonModules/Патч/Ext/Module.bsl'));
  check('patch: не-1С файл патча гейт не взводит', !files.includes('README.md'));
  check('patch: подсказка дописана в результат', typeof evP.result.content === 'string' && evP.result.content.includes('QUALITY GATE'));
  rmSync(pRoot, { recursive: true, force: true });
}

// ── Взвод по командам оболочки ──
// Встроенный инструмент оболочки V2 называется `shell` (в V1 — `bash`), вход — { command, workdir }.
{
  const shRoot = mkdtempSync(join(tmpdir(), 'qg-oc2-sh-'));
  const { c } = await setupHooked(shRoot);
  const modDir = join(shRoot, 'CommonModules', 'Модуль');
  const input = { command: 'gen.sh', workdir: shRoot };
  const pending = join(shRoot, '.opencode', '.state', 'qg-pending.json');

  for (const h of c.__toolHooks['execute.before']) await h({ tool: 'shell', sessionID: 's-sh', id: 'sh1', input });
  await new Promise((r) => setTimeout(r, 30));
  mkdirSync(modDir, { recursive: true });
  writeFileSync(join(modDir, 'Module.bsl'), 'Процедура Т() КонецПроцедуры\n', 'utf8');
  const evSh = { tool: 'shell', sessionID: 's-sh', id: 'sh1', input, status: 'completed', result: { content: 'готово' } };
  for (const h of c.__toolHooks['execute.after']) await h(evSh);
  check('shell: модуль, записанный командой, взводит гейт', existsSync(pending));
  check('shell: подсказка о правке оболочкой дописана в результат',
    typeof evSh.result.content === 'string' && evSh.result.content.includes('изменено командой оболочки'));

  // Команда, упавшая после записи файла, правку всё равно оставила: взвод не зависит от статуса.
  const shRoot2 = mkdtempSync(join(tmpdir(), 'qg-oc2-sh2-'));
  const { c: c2 } = await setupHooked(shRoot2);
  const pending2 = join(shRoot2, '.opencode', '.state', 'qg-pending.json');
  for (const h of c2.__toolHooks['execute.before']) await h({ tool: 'shell', sessionID: 's-sh2', id: 'sh2', input: { command: 'build.sh', workdir: shRoot2 } });
  await new Promise((r) => setTimeout(r, 30));
  mkdirSync(join(shRoot2, 'CommonModules', 'Модуль'), { recursive: true });
  writeFileSync(join(shRoot2, 'CommonModules', 'Модуль', 'Module.bsl'), 'Процедура Т() КонецПроцедуры\n', 'utf8');
  for (const h of c2.__toolHooks['execute.after']) {
    await h({ tool: 'shell', sessionID: 's-sh2', id: 'sh2', input: { command: 'build.sh', workdir: shRoot2 }, status: 'error', error: { message: 'exit 1' } });
  }
  check('shell: упавшая команда с записанным модулем тоже взводит гейт', existsSync(pending2));

  // Команда без записи ничего не взводит и ничего не дописывает.
  const shRoot3 = mkdtempSync(join(tmpdir(), 'qg-oc2-sh3-'));
  const { c: c3 } = await setupHooked(shRoot3);
  const evRo = { tool: 'shell', sessionID: 's-sh3', id: 'sh3', input: { command: 'ls' }, status: 'completed', result: { content: 'список' } };
  for (const h of c3.__toolHooks['execute.before']) await h({ tool: 'shell', sessionID: 's-sh3', id: 'sh3', input: evRo.input });
  for (const h of c3.__toolHooks['execute.after']) await h(evRo);
  check('shell: команда без записи ничего не дописывает', evRo.result.content === 'список' && !existsSync(join(shRoot3, '.opencode', '.state', 'qg-pending.json')));

  for (const d of [shRoot, shRoot2, shRoot3]) rmSync(d, { recursive: true, force: true });
}

// ── Корень проекта ──
// V1 брал worktree (корень репозитория), V2 даёт его в location.project.directory; location.directory —
// каталог, из которого запущен OpenCode, и может быть вложенным.
{
  const repo = mkdtempSync(join(tmpdir(), 'qg-oc2-root-'));
  const sub = join(repo, 'sub', 'dir');
  mkdirSync(sub, { recursive: true });
  const bsl = join(repo, 'CommonModules', 'Модуль', 'Module.bsl');
  mkdirSync(join(repo, 'CommonModules', 'Модуль'), { recursive: true });
  writeFileSync(bsl, 'Процедура Т() КонецПроцедуры\n', 'utf8');
  const c = makeCtx(sub);
  c.location = { directory: sub, project: { id: 'p', directory: repo, canonical: repo } };
  const hooks = { 'execute.before': [], 'execute.after': [] };
  c.tool.hook = async (name, cb) => { hooks[name].push(cb); return { dispose: async () => {} }; };
  c.__toolHooks = hooks;
  await mod.default.setup(c);
  await callTool(c, { id: 'r1', tool: 'write', input: { path: bsl }, result: { content: 'ok' } });
  check('корень проекта — каталог репозитория, а не подкаталог запуска',
    existsSync(join(repo, '.opencode', '.state', 'qg-pending.json')) && !existsSync(join(sub, '.opencode')));
  rmSync(repo, { recursive: true, force: true });
}

// ── Мягкий гейт на завершении прогона ──
const sessEvents = [];
{
  // Отдельный ctx с перехватом событий и промптов.
  const ctx4 = makeCtx(root);
  const busEvents = [];
  ctx4.event.subscribe = () => {
    const q = busEvents;
    let i = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise((resolve) => {
              const tryRead = () => {
                if (i < q.length) resolve({ value: q[i++], done: false });
                else setTimeout(tryRead, 5);
              };
              tryRead();
            }),
        };
      },
    };
  };
  await mod.default.setup(ctx4);

  // У сессии s1 есть взведённый гейт (правки выше). Завершение прогона обязано
  // вернуть агента к работе.
  busEvents.push({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
  await new Promise((r) => setTimeout(r, 100));
  check('session.execution.succeeded возвращает агента к работе', ctx4.prompts.length === 1);
  check('возврат уходит в нужную сессию с текстом мягкого гейта',
    ctx4.prompts[0]?.sessionID === 's1' && /качеств/i.test(ctx4.prompts[0]?.text || ''));
  check('передача проверки называет инструмент subagent, а не task из V1',
    /инструментом subagent/.test(ctx4.prompts[0]?.text || '') && !/инструментом task/.test(ctx4.prompts[0]?.text || ''));

  // Событие с устаревшим написанием payload (properties) тоже принимается.
  busEvents.push({ type: 'session.execution.started', data: { sessionID: 's1' } });
  busEvents.push({ type: 'session.idle', properties: { sessionID: 's1' } });
  await new Promise((r) => setTimeout(r, 100));
  check('session.idle с properties-payload принимается', ctx4.prompts.length === 2);

  // Прерванный прогон — не пауза: пользователь сам остановил работу.
  busEvents.push({ type: 'session.execution.started', data: { sessionID: 's1' } });
  busEvents.push({ type: 'session.execution.interrupted', data: { sessionID: 's1' } });
  await new Promise((r) => setTimeout(r, 100));
  check('interrupted возврата не даёт', ctx4.prompts.length === 2);

  // Лимит возвратов на неизменный состав правок.
  for (let i = 0; i < 3; i++) {
    busEvents.push({ type: 'session.execution.started', data: { sessionID: 's1' } });
    busEvents.push({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
  }
  await new Promise((r) => setTimeout(r, 200));
  check('возвратов не более MAX_REPROMPTS на неизменный состав', ctx4.prompts.length === 3);

  const journalPath = join(root, '.opencode', '.state', 'qg-runs.jsonl');
  const surrender = existsSync(journalPath)
    ? readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.event === 'gate-surrendered')
    : null;
  check('сдача мягкого гейта записана в журнал без scope', !!surrender && !('scope' in surrender));

  // Чужая сессия без своих правок возврата не получает.
  busEvents.push({ type: 'session.execution.succeeded', data: { sessionID: 's-chuzhaya' } });
  await new Promise((r) => setTimeout(r, 100));
  check('чужая сессия без правок не получает возврат', ctx4.prompts.length === 3);

  // Один конец прогона может прийти двумя событиями: durable succeeded и устаревший idle.
  // Возврат — один; следующий конец прогона считается после нового started.
  const dedupRoot = mkdtempSync(join(tmpdir(), 'qg-oc2-dedup-'));
  mkdirSync(join(dedupRoot, 'CommonModules', 'Модуль'), { recursive: true });
  const dedupBsl = join(dedupRoot, 'CommonModules', 'Модуль', 'Module.bsl');
  writeFileSync(dedupBsl, 'Процедура Т() КонецПроцедуры\n', 'utf8');
  const ctx5 = makeCtx(dedupRoot);
  const ev5 = [];
  ctx5.event.subscribe = () => feed(ev5);
  const hk5 = { 'execute.before': [], 'execute.after': [] };
  ctx5.tool.hook = async (name, cb) => { hk5[name].push(cb); return { dispose: async () => {} }; };
  ctx5.__toolHooks = hk5;
  await mod.default.setup(ctx5);
  await callTool(ctx5, { id: 'd1', tool: 'write', input: { path: dedupBsl }, result: { content: 'ok' }, sessionID: 's-dd' });
  ev5.push({ type: 'session.execution.succeeded', data: { sessionID: 's-dd' } });
  ev5.push({ type: 'session.idle', data: { sessionID: 's-dd' } });
  await new Promise((r) => setTimeout(r, 120));
  check('succeeded и idle одного прогона дают один возврат', ctx5.prompts.length === 1);
  ev5.push({ type: 'session.execution.started', data: { sessionID: 's-dd' } });
  ev5.push({ type: 'session.execution.succeeded', data: { sessionID: 's-dd' } });
  await new Promise((r) => setTimeout(r, 120));
  check('после нового started конец прогона снова возвращает агента', ctx5.prompts.length === 2);
  check('возвраты идут без поля noReply, которого в V2 нет', ctx5.prompts.every((p) => !('noReply' in p)));
  rmSync(dedupRoot, { recursive: true, force: true });

  // Итог снятого гейта — уведомление, а не задание: в V2 ход модели отключает resume: false.
  const noteRoot = mkdtempSync(join(tmpdir(), 'qg-oc2-note-'));
  mkdirSync(join(noteRoot, '.opencode', '.state'), { recursive: true });
  writeFileSync(join(noteRoot, '.opencode', '.state', 'qg-done.json'), JSON.stringify({ version: 2, sessions: { s7: { releasedAt: 'now', files: {}, mode: 'evidence', evidenceFile: 'C:/t/r.md', evidenceArchive: null,
    residual: { inChange: [{ sev: '🟡', title: 'Шапка' }], outside: [], needsDecision: [] } } } }), 'utf8');
  const ctx6 = makeCtx(noteRoot);
  const ev6 = [{ type: 'session.execution.succeeded', data: { sessionID: 's7' } }];
  ctx6.event.subscribe = () => feed(ev6);
  await mod.default.setup(ctx6);
  await new Promise((r) => setTimeout(r, 120));
  check('итог после снятия отправлен один раз текстом остатка', ctx6.prompts.length === 1 && /в правке: 🔴 0, 🟠 0, 🟡 1/.test(ctx6.prompts[0]?.text || ''));
  check('итог отправлен с resume: false и без noReply', ctx6.prompts[0]?.resume === false && !('noReply' in (ctx6.prompts[0] || {})));
  rmSync(noteRoot, { recursive: true, force: true });

  // Поток событий, закончившийся сам (не выгрузкой плагина), — это потерянный мягкий гейт: след обязателен.
  const ctx7 = makeCtx(root);
  ctx7.event.subscribe = () => ({ [Symbol.asyncIterator]() { return { next: async () => ({ value: undefined, done: true }) }; } });
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    await mod.default.setup(ctx7);
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    console.error = origErr;
  }
  check('обрыв потока событий оставляет предупреждение, а не тишину', errs.some((m) => /поток событий/.test(m)));

  sessEvents.push(ctx4);
}

// ── Команды V2: execute отправляет шаблон в сессию ──
{
  const gateCmd = ctx2raw.commands.get('gate');
  const before = ctx2raw.prompts.length;
  await gateCmd.execute({ sessionID: 's-cmd', prompt: { text: '--quick' }, delivery: 'steer' });
  const sent = ctx2raw.prompts[before];
  check('execute команды отправляет шаблон промптом',
    sent?.sessionID === 's-cmd' && typeof sent?.text === 'string' && sent.text.includes('quality-gate'));
  check('$ARGUMENTS подставлены аргументами', sent?.text.includes('--quick') && !sent.text.includes('$ARGUMENTS'));
  check('режим доставки проброшен', sent?.delivery === 'steer');
}

// ── Выгрузка и гашение ошибок ──
let survived = true;
try {
  await cleanup();
  // setup на битом ctx обязан молча деградировать, а не падать.
  await mod.default.setup(null);
  await mod.default.setup({});
} catch {
  survived = false;
}
check('выгрузка и битый контекст не роняют плагин', survived);

rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
