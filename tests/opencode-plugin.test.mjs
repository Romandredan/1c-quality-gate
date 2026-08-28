#!/usr/bin/env node
/**
 * Тесты плагина OpenCode (opencode/plugin/quality-gate.js): взвод гейта на правку,
 * подсказка в результате инструмента, мягкий гейт на session.idle с пределом возвратов.
 * Запуск: node tests/opencode-plugin.test.mjs
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

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'qg-oc-test-'));
  return root;
}

function makeClient() {
  const prompts = [];
  return {
    prompts,
    session: {
      prompt: async (req) => { prompts.push(req); return {}; },
    },
  };
}

async function makePlugin(root, client) {
  const mod = await import(PLUGIN_URL);
  const factory = mod.QualityGatePlugin || mod.default;
  return await factory({ project: {}, client, directory: root, worktree: root });
}

const root = makeProject();
const client = makeClient();
const plugin = await makePlugin(root, client);

check('плагин возвращает обработчики', typeof plugin['tool.execute.after'] === 'function' && typeof plugin.event === 'function');
check('плагин объявляет config и shell.env', typeof plugin.config === 'function' && typeof plugin['shell.env'] === 'function');
// Окружение процесса OpenCode плагин НЕ правит: значения уходят в оболочку хуком
// shell.env. Мутация process.env держалась на допущении, что дочерний процесс
// инструмента её унаследует, — а на нём стояла вся схема двух харнессов.
check('плагин не правит окружение процесса', process.env.QG_PROJECT_DIR === undefined && process.env.QG_STATE_DIR === undefined);

// Правка .bsl взводит гейт и дописывает подсказку в результат инструмента.
const bslPath = join(root, 'CommonModules', 'Модуль', 'Module.bsl');
mkdirSync(join(root, 'CommonModules', 'Модуль'), { recursive: true });
writeFileSync(bslPath, 'Процедура Тест() КонецПроцедуры\n', 'utf8');

const out = { output: 'файл записан' };
await plugin['tool.execute.before']({ callID: 'c1', sessionID: 's1' }, { args: { filePath: bslPath } });
await plugin['tool.execute.after']({ callID: 'c1', sessionID: 's1', tool: 'write' }, out);

const pendingPath = join(root, '.opencode', '.state', 'qg-pending.json');
check('правка .bsl взвела гейт в .opencode/.state', existsSync(pendingPath));
check('подсказка дописана в результат инструмента', out.output.includes('файл записан') && out.output.length > 'файл записан'.length + 10);

// Правка нецелевого файла гейт не трогает: нового взвода не происходит.
const mdPath = join(root, 'README.md');
writeFileSync(mdPath, '# test\n', 'utf8');
const before = readFileSync(pendingPath, 'utf8');
await plugin['tool.execute.after']({ callID: 'c2', sessionID: 's1', tool: 'write' }, { args: { filePath: mdPath }, output: 'ok' });
check('правка .md не меняет маркер', readFileSync(pendingPath, 'utf8') === before);

// Инструмент чтения не взводит гейт даже на .bsl.
const before2 = readFileSync(pendingPath, 'utf8');
await plugin['tool.execute.after']({ callID: 'c3', sessionID: 's1', tool: 'read' }, { args: { filePath: bslPath }, output: 'ok' });
check('read на .bsl не взводит гейт', readFileSync(pendingPath, 'utf8') === before2);

// session.idle: плагин возвращает агента к работе.
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
check('session.idle отправляет возврат агенту', client.prompts.length === 1);
check('возврат уходит в нужную сессию', client.prompts[0]?.path?.id === 's1');
check('текст возврата честный для мягкого гейта', /качеств/i.test(client.prompts[0]?.body?.parts?.[0]?.text || ''));

// Предел возвратов: на неизменный состав правок — не более MAX_REPROMPTS.
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
check('возвратов не более MAX_REPROMPTS на неизменный состав', client.prompts.length === 3);

// Исчерпание лимита фиксируется в журнале прогонов записью без scope — наблюдаемой,
// но не засчитываемой валидатором охвата.
const journalPath = join(root, '.opencode', '.state', 'qg-runs.jsonl');
check('сдача мягкого гейта записана в журнал', existsSync(journalPath));
const surrender = existsSync(journalPath)
  ? readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.event === 'gate-surrendered')
  : null;
check('запись сдачи без scope (инертна для валидатора)', surrender && !('scope' in surrender) && surrender.sessionId === 's1');

// Новая правка сбрасывает счётчик возвратов.
writeFileSync(bslPath, 'Процедура Тест2() КонецПроцедуры\n', 'utf8');
await plugin['tool.execute.after']({ callID: 'c4', sessionID: 's1', tool: 'edit' }, { args: { filePath: bslPath }, output: 'ok' });
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
check('новая правка сбрасывает счётчик возвратов', client.prompts.length === 4);

// Чужая сессия без своих правок не получает возвратов.
await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's2' } } });
check('чужая сессия без правок не получает возврат', client.prompts.length === 4);

// События других типов игнорируются.
await plugin.event({ event: { type: 'session.error', properties: { sessionID: 's1' } } });
check('прочие события игнорируются', client.prompts.length === 4);

// Повреждённый маркер: сообщение о повреждении, без падения.
writeFileSync(pendingPath, '{не json', 'utf8');
const plugin2 = await makePlugin(root, client);
await plugin2.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
check('повреждённый маркер даёт сообщение, а не сбой', client.prompts.length === 5 && /поврежд/i.test(client.prompts[4]?.body?.parts?.[0]?.text || ''));

// Ошибки клиента гасятся.
const badClient = { session: { prompt: async () => { throw new Error('network'); } } };
rmSync(pendingPath, { force: true });
const plugin3 = await makePlugin(root, badClient);
await plugin3['tool.execute.after']({ callID: 'c9', sessionID: 's9', tool: 'write' }, { args: { filePath: bslPath }, output: 'ok' });
let survived = true;
try {
  await plugin3.event({ event: { type: 'session.idle', properties: { sessionID: 's9' } } });
} catch { survived = false; }
check('ошибка клиента гасится', survived);

// ---------------------------------------------------------------------------
// shell.env: инструменты пакета запускает агент из оболочки, а не плагин. Корень
// пакета, корень проекта и каталог состояния он обязан получить готовыми — иначе
// ищет пакет угадыванием, а состояние берёт по умолчанию Claude Code.
{
  const env = {};
  await plugin['shell.env']({ cwd: root }, { env });
  check('shell.env отдаёт QG_ROOT на корень пакета', existsSync(join(env.QG_ROOT || '', 'hooks', 'gate-core.mjs')));
  check('shell.env отдаёт QG_PROJECT_DIR', env.QG_PROJECT_DIR === root);
  check('shell.env отдаёт QG_STATE_DIR', env.QG_STATE_DIR === '.opencode/.state');
  // Взвод и снятие обязаны попадать в один каталог: значение одно на весь плагин.
  check('каталог состояния тот же, в котором лежит маркер', existsSync(join(root, ...env.QG_STATE_DIR.split('/'), 'qg-pending.json')));

  const preset = { QG_ROOT: '/своё', QG_PROJECT_DIR: '/своё', QG_STATE_DIR: 'своё' };
  await plugin['shell.env']({ cwd: root }, { env: preset });
  check('shell.env не перекрывает заданное пользователем', preset.QG_ROOT === '/своё' && preset.QG_STATE_DIR === 'своё');

  let survivedEnv = true;
  try {
    await plugin['shell.env']({ cwd: root }, {});
    await plugin['shell.env']({ cwd: root }, { env: null });
  } catch { survivedEnv = false; }
  check('shell.env не падает на неожиданном вводе', survivedEnv);
}

// ---------------------------------------------------------------------------
// config: пакет лежит в кэше OpenCode, куда сканирование проектных каталогов не
// достаёт. Состав объявляется кодом — иначе /gate загрузится, а контуры, субагенты
// и источник стандартов окажутся недоступны.
{
  const cfg = {};
  await plugin.config(cfg);
  const skillsDir = (cfg.skills?.paths || [])[0];
  check('config регистрирует каталог навыков', !!skillsDir && existsSync(join(skillsDir, 'quality-gate', 'SKILL.md')));
  check('регистрируются все пять навыков контура',
    ['quality-gate', 'bsl-code-review', 'bsl-architecture-review', 'xml-structure-review', 'file-hygiene']
      .every((n) => existsSync(join(skillsDir, n, 'SKILL.md'))));
  check('config регистрирует команды', !!cfg.command?.gate?.template && !!cfg.command?.['gate-status']?.template);
  check('config регистрирует субагентов', ['bsl-verifier', 'bsl-scout', 'xml-runner'].every((n) => !!cfg.agent?.[n]?.prompt));
  check('субагент едет с картой инструментов и режимом', cfg.agent?.['bsl-verifier']?.mode === 'subagent' && cfg.agent?.['bsl-verifier']?.tools?.bash === true);

  // Источник субагентов один — agents/. Файл, который разбор не признал, молча не
  // зарегистрируется, и контур примет это за законное отсутствие субагента в среде.
  // Поэтому сверяем состав каталога, а не фиксированный список имён.
  const agentsDir = join(import.meta.dirname, '..', 'agents');
  const onDisk = readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  check('каждый файл agents/ доехал до конфигурации', onDisk.length > 0 && onDisk.every((n) => !!cfg.agent?.[n]?.prompt));
  check('второго каталога субагентов нет', !existsSync(join(import.meta.dirname, '..', 'opencode', 'agents')));

  // Перевод frontmatter: у харнессов разные схемы. Ключи Claude Code не переносятся —
  // model: haiku в OpenCode не разрешается, color: cyan не проходит проверку формата.
  const scout = cfg.agent?.['bsl-scout'];
  check('перевод: список инструментов стал картой булевых',
    scout?.tools?.skill === true && scout?.tools?.read === true && scout?.tools?.bash === false);
  check('перевод: неразрешённая правка закрыта и картой, и разрешением',
    scout?.tools?.write === false && scout?.tools?.edit === false && scout?.permission?.edit === 'deny');
  check('перевод: ключи Claude Code не протекают в конфигурацию',
    scout?.model === undefined && scout?.color === undefined && scout?.name === undefined);
  check('config регистрирует MCP стандартов', cfg.mcp?.v8std?.type === 'remote');

  // Повторный вызов не должен дублировать путь: конфигурация читается не один раз.
  await plugin.config(cfg);
  check('повторный config не дублирует каталог навыков', cfg.skills.paths.filter((p) => p === skillsDir).length === 1);

  // Своё имя сильнее нашего: пользователь не должен молча терять свою запись.
  const mine = {
    skills: { paths: [] },
    command: { gate: { template: 'моя команда' } },
    agent: { 'bsl-verifier': { prompt: 'мой агент' } },
    mcp: { v8std: { type: 'local', command: ['своё'] } },
  };
  await plugin.config(mine);
  check('config не перекрывает записи пользователя',
    mine.command.gate.template === 'моя команда' &&
    mine.agent['bsl-verifier'].prompt === 'мой агент' &&
    mine.mcp.v8std.type === 'local');

  let survivedCfg = true;
  try {
    await plugin.config({ skills: { paths: 'не массив' } });
  } catch { survivedCfg = false; }
  check('config не падает на испорченной конфигурации', survivedCfg);
}

// ---------------------------------------------------------------------------
// Разбор frontmatter: узкий по замыслу. Всё, что за пределами признаваемой формы,
// обязано вернуть null и не зарегистрироваться — субагент с потерянной картой
// инструментов опаснее незарегистрированного.
{
  const reg = await import(pathToFileURL(join(import.meta.dirname, '..', 'opencode', 'plugin', 'registry.js')).href);
  check('разбор: нет frontmatter — null', reg.parseFrontmatter('просто текст') === null);
  check('разбор: незакрытый frontmatter — null', reg.parseFrontmatter('---\nname: x\n') === null);
  check('разбор: непризнанная конструкция — null', reg.parseFrontmatter('---\n- список\n---\nтело') === null);
  const p = reg.parseFrontmatter('---\nmode: subagent\ntools:\n  bash: false\n---\nтело');
  check('разбор: булево во вложенной карте — булево', p?.data.tools.bash === false && p.body === 'тело');
  const folded = reg.parseFrontmatter('---\ndescription: >-\n  первая\n  вторая\n---\nтело');
  check('разбор: свёрнутый блок собирается целиком', folded?.data.description === 'первая\nвторая');
}

rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
