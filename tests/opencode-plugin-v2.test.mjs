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

async function callTool(ctx, { id, tool, input, result, status = 'completed' }) {
  for (const h of ctx.__toolHooks['execute.before']) await h({ tool, sessionID: 's1', id, input });
  for (const h of ctx.__toolHooks['execute.after']) await h({ tool, sessionID: 's1', id, input, status, result });
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
const verifier = ctx2raw.agents.get('bsl-verifier');
check('верификатору разрешён shell (execute), закрыта правка',
  rules.length > 0 &&
  !!verifier?.permissions?.find((r) => r.action === 'execute' && r.effect === 'allow') &&
  !!verifier?.permissions?.find((r) => r.action === 'edit' && r.effect === 'deny'));

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
  const preset = { QG_ROOT: '/своё', QG_PROJECT_DIR: '/своё', QG_STATE_DIR: 'своё' };
  for (const h of shellHooks2) await h({ env: preset });
  check('заданное пользователем окружение не перекрывается', preset.QG_ROOT === '/своё' && preset.QG_STATE_DIR === 'своё');
}

// ── Взвод гейта ──
const bslPath = join(root, 'CommonModules', 'Модуль', 'Module.bsl');
mkdirSync(join(root, 'CommonModules', 'Модуль'), { recursive: true });
writeFileSync(bslPath, 'Процедура Тест() КонецПроцедуры\n', 'utf8');

const result = { content: 'файл записан' };
await callTool(ctx2raw, { id: 'c1', tool: 'write', input: { filePath: bslPath }, result });

const pendingPath = join(root, '.opencode', '.state', 'qg-pending.json');
check('правка .bsl взвела гейт в .opencode/.state', existsSync(pendingPath));
check('подсказка дописана в строковый content', typeof result.content === 'string' && result.content.includes('QUALITY GATE'));

// Результат частями: подсказка уходит в последнюю текстовую часть, прочее не трогается.
const img = { type: 'image', data: '…' };
const partsResult = { content: [{ type: 'text', text: 'часть 1' }, img] };
writeFileSync(bslPath, 'Процедура Тест2() КонецПроцедуры\n', 'utf8');
await callTool(ctx2raw, { id: 'c2', tool: 'edit', input: { filePath: bslPath }, result: partsResult });
check('подсказка в текстовой части, нетекстовые части целы',
  partsResult.content[0].text.includes('QUALITY GATE') && partsResult.content[1] === img);

// Провалившийся вызов гейт не взводит.
const markerBefore = readFileSync(pendingPath, 'utf8');
await callTool(ctx2raw, { id: 'c3', tool: 'write', input: { filePath: join(root, 'CommonModules', 'Модуль', 'Module.bsl') }, result: {}, status: 'error' });
check('error-статус гейт не взводит', readFileSync(pendingPath, 'utf8') === markerBefore);

// Чтение и нецелевые файлы гейт не трогают.
await callTool(ctx2raw, { id: 'c4', tool: 'read', input: { filePath: bslPath }, result: { content: 'ok' } });
writeFileSync(join(root, 'README.md'), '# t\n', 'utf8');
await callTool(ctx2raw, { id: 'c5', tool: 'write', input: { filePath: join(root, 'README.md') }, result: { content: 'ok' } });
check('read и не-1С файлы гейт не взводят', readFileSync(pendingPath, 'utf8') === markerBefore);

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

  // Событие с устаревшим написанием payload (properties) тоже принимается.
  busEvents.push({ type: 'session.idle', properties: { sessionID: 's1' } });
  await new Promise((r) => setTimeout(r, 100));
  check('session.idle с properties-payload принимается', ctx4.prompts.length === 2);

  // Прерванный прогон — не пауза: пользователь сам остановил работу.
  busEvents.push({ type: 'session.execution.interrupted', data: { sessionID: 's1' } });
  await new Promise((r) => setTimeout(r, 100));
  check('interrupted возврата не даёт', ctx4.prompts.length === 2);

  // Лимит возвратов на неизменный состав правок.
  busEvents.push({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
  busEvents.push({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
  busEvents.push({ type: 'session.execution.succeeded', data: { sessionID: 's1' } });
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
