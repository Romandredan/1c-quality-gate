/**
 * 1c-quality-gate — механика гейта качества 1С для OpenCode.
 *
 * Модуль поддерживает ОБЕ версии OpenCode из одной точки входа:
 *
 *   - V1 (>= 1.18.29): вызывает `server()` и получает объект хуков
 *     ("tool.execute.before/after", "config", "shell.env", "event").
 *   - V2: читает `id` и `setup(ctx)` и регистрацию ведёт через домены контекста
 *     (ctx.skill/command/agent/mcp.transform, ctx.tool.hook, ctx.shell.hook,
 *     ctx.event.subscribe). Хуки между версиями НЕ транслируются — у каждой своя
 *     реализация поверх общих помощников этого файла и ядра hooks/gate-core.mjs.
 *
 * Почему экспорт — голый объект, а не Plugin.define из "@opencode/plugin":
 * у пакета принципиально нет зависимостей, а define — функция-тождество, нужная
 * только для типизации. Загрузчик V2 читает из default-экспорта поля id и setup,
 * импорт пакета типов в рантайме не требуется.
 *
 * V1-реализация:
 *   - "tool.execute.before/after" — взвод гейта при правке .bsl/.os/XML метаданных
 *     инструментом правки и командой `bash` (аналог PostToolUse и хука gate-shell.mjs).
 *     Подсказка дописывается в результат инструмента, чтобы модель увидела взвод
 *     немедленно, а не при попытке завершить работу.
 *   - "event: session.idle" — возврат агента к работе, пока гейт не снят
 *     (аналог Stop-хука).
 *   - "config" — регистрация состава пакета в живой конфигурации: каталог навыков,
 *     команды, субагенты, MCP-сервер стандартов. Пакет лежит в кэше OpenCode, куда
 *     сканирование проектных каталогов не достаёт, поэтому состав объявляется кодом,
 *     а не раскладывается по проекту установочным скриптом.
 *   - "shell.env" — QG_ROOT, QG_PROJECT_DIR и QG_STATE_DIR в окружение КАЖДОГО запуска
 *     оболочки. Это несущая часть: инструменты пакета запускает агент из оболочки, и
 *     без этих переменных он ищет пакет угадыванием, а состояние — по умолчанию
 *     Claude Code. Тогда взвод шёл бы в один каталог, а снятие в другой.
 *
 * V2-реализация (соответствия V1):
 *   - ctx.tool.hook("execute.before/after")   ← tool.execute.before/after
 *   - ctx.event.subscribe() + session.execution.succeeded / session.idle
 *                                             ← хук event на session.idle
 *   - ctx.shell.hook("create.before")         ← shell.env
 *   - ctx.skill/command/agent/mcp.transform   ← хук config
 *   - ctx.session.prompt({sessionID, text})   ← client.session.prompt({path, body})
 *
 * ВАЖНОЕ ОТЛИЧИЕ ОТ ХУКОВ CLAUDE CODE (обе версии OpenCode). В Claude Code Stop-хук
 * жёстко отказывает в завершении сессии (exit 2). У OpenCode такого механизма нет:
 * плагин не может запретить завершение, он отправляет агенту новое сообщение, и тот
 * продолжает работу. Это настойчивый, но мягкий гейт: пользователь всегда может
 * прервать сессию вручную. Чтобы цикл «idle → возврат» не был бесконечным спамом, на
 * неизменный состав правок даётся не более MAX_REPROMPTS автоматических возвратов;
 * счётчик ведётся по сессии и сбрасывает её любая новая правка. Исчерпание лимита
 * фиксируется записью gate-surrendered в журнале прогонов (без поля scope — запись
 * наблюдаема, но не засчитывается валидатором охвата как проверка).
 *
 * Логика взвода, формат состояния и тексты — в hooks/gate-core.mjs (единый источник,
 * общий с stdin-обёртками хуков Claude Code). Снятие гейта — только через
 * `tools/gate.mjs release`, он требует машиночитаемый след прогона.
 *
 * Любая внутренняя ошибка плагина гасится: гейт качества не имеет права ломать работу.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { agentsFrom, agentsV2From, commandsFrom, skillsFrom } from './registry.js';

/**
 * MCP-сервер стандартов. Зависимость обязательная, а не удобство: без подтверждённого
 * часового источника стандартов гейт не снимается. Регистрируется, только если у
 * пользователя нет своей записи с этим именем.
 *
 * Поле enabled — из V1-схемы; в записи V2 его нет: нативный переключатель V2 —
 * `disabled`, а по умолчанию сервер включён.
 */
const V8STD_MCP = { type: 'remote', url: 'https://ai.v8std.ru/mcp', enabled: true };
const V8STD_MCP_V2 = { type: 'remote', url: 'https://ai.v8std.ru/mcp' };

/** Максимум автоматических возвратов на неизменный состав правок. */
const MAX_REPROMPTS = 3;

// Окно, в котором повторное событие конца прогона той же сессии считается дублем (V2).
const DUPLICATE_WINDOW_MS = 2000;

/** Верхняя граница журнала прогонов (tools/run-journal.mjs). */
const JOURNAL_KEEP = 500;

/** Инструменты правки — аналог matcher исходного PostToolUse-хука. */
const EDIT_TOOLS = new Set(['write', 'edit', 'multiedit', 'patch', 'notebookedit']);

// Встроенный инструмент оболочки: в V1 он называется bash, в V2 — shell (packages/core/src/tool/
// plugin/shell.ts в OpenCode). Не распознав имя, плагин не снимал бы снимок до команды, и правки
// генератором или скриптом не взводили бы гейт — молча.
const V2_SHELL_TOOLS = new Set(['shell', 'bash']);

// Инструмент запуска субагентов: в V1 — task, в V2 — subagent. Имя попадает в текст передачи
// проверки, который модель исполняет буквально.
const V2_SUBAGENT_TOOL = 'subagent';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Корень пакета. При штатной установке OpenCode пакет разворачивается целиком, плагин
 * лежит в <корень>/opencode/plugin/ — значит корень двумя уровнями выше. Второй кандидат
 * оставлен для раскладки «плагин положили рядом с распакованным пакетом» и стоит первым:
 * если она есть, она задана человеком осознанно. Опознаём по hooks/gate-core.mjs.
 */
function resolvePackageRoot() {
  for (const candidate of [
    resolve(PLUGIN_DIR, '..', '1c-quality-gate'),
    resolve(PLUGIN_DIR, '..', '..'),
  ]) {
    if (existsSync(join(candidate, 'hooks', 'gate-core.mjs'))) return candidate;
  }
  return null;
}

/** Файл, который правил инструмент: из аргументов вызова. */
function fileOfArgs(args) {
  if (!args || typeof args !== 'object') return null;
  const p = args.filePath ?? args.file_path ?? args.path ?? args.file;
  return typeof p === 'string' && p ? p : null;
}

/**
 * Ядро механики гейта и его зависимости. Если импорт не удался (пакет установлен
 * частично), возвращается null, и плагин молчит — ложный гейт хуже отсутствующего.
 * file-URL, а не путь: динамический import() по голому пути на Windows падает с
 * ERR_UNSUPPORTED_ESM_URL_SCHEME, и плагин молча не работал бы вообще.
 *
 * Взвод по командам оболочки (shell-core) — отдельным импортом: его сбой не должен
 * выключать взвод по правкам и мягкий гейт, которые работают без него.
 */
async function loadGateDeps(packageRoot) {
  try {
    const core = await import(pathToFileURL(join(packageRoot, 'hooks', 'gate-core.mjs')).href);
    const stateDir = await import(pathToFileURL(join(packageRoot, 'tools', 'state-dir.mjs')).href);
    const { ensureConfig, readConfig } = await import(pathToFileURL(join(packageRoot, 'tools', 'config.mjs')).href);
    let shell = null;
    try {
      shell = await import(pathToFileURL(join(packageRoot, 'hooks', 'shell-core.mjs')).href);
    } catch {
      shell = null;
    }
    return { core, stateDir, ensureConfig, readConfig, shell };
  } catch {
    return null;
  }
}

/**
 * Общая для обеих версий OpenCode механика мягкого гейта на паузе сессии.
 *
 * Возвращает handleIdle(sessionId, send), где send(text, opts) — способ доставки
 * сообщения агенту конкретной версии (у V1 и V2 разные сигнатуры; opts.note помечает
 * уведомление, которое не должно провоцировать ход модели). Вся логика — итог снятого
 * гейта, чтение маркера, отпечаток состава правок, лимит возвратов, журнал сдачи —
 * здесь, чтобы две копии не разъезжались при первой же правке.
 */
function createIdleGate({ root, core, stateDir, stateEnv, packageRoot, subagentTool = null }) {
  // Защита от бесконечного цикла возвратов. Счётчик — ПО СЕССИИ: sessionId →
  // { fingerprint, count }. Глобальный лимит (как у первой редакции, ключ = сессия +
  // отпечаток) при переполнении карты стирал счётчики ВСЕХ сессий, включая текущую, —
  // и после очистки та же непроверенная правка получала новые MAX_REPROMPTS возвратов.
  // Здесь при переполнении вытесняются только ЧУЖИЕ сессии, своя сессия свой счётчик
  // никогда не теряет.
  const reprompts = new Map();

  /**
   * Фиксирует сдачу мягкого гейта в журнал прогонов. Запись БЕЗ поля scope:
   * валидатор охвата (tools/evidence-validator.mjs) признаёт только записи со строковым
   * scope, поэтому событие сдачи не может быть засчитано как прогон проверки — журнал
   * читают оба харнесса, и подмена смысла недопустима. Смысл записи — оставить
   * наблюдаемый след: мягкий гейт сдался, правки остались непроверенными.
   */
  const journalSurrender = (sessionId, files) => {
    try {
      const dir = join(root, ...stateDir.stateDirSegments(stateEnv));
      mkdirSync(dir, { recursive: true });
      const journal = join(dir, 'qg-runs.jsonl');
      const lines = existsSync(journal)
        ? readFileSync(journal, 'utf8').split('\n').filter(Boolean)
        : [];
      lines.push(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'gate-surrendered',
          tool: 'opencode-plugin',
          sessionId,
          files: files.map(([f]) => f),
        })
      );
      writeFileSync(journal, lines.slice(-JOURNAL_KEEP).join('\n') + '\n', 'utf8');
    } catch {
      /* журнал не обязан мешать работе */
    }
  };

  return async function handleIdle(sessionId, send) {
    // Итог снятого гейта — один раз: аналог systemMessage Stop-хука Claude Code.
    const note = core.residualNote({ root, sessionId, env: stateEnv });
    if (note) {
      // note: это уведомление, а не задание — без noReply модель отвечает ходом и может
      // взяться за остаток, включая находки вне правки.
      await send(`[ГЕЙТ КАЧЕСТВА 1С] ${note}`, { note: true }).catch(() => {});
      return;
    }

    const state = core.readPendingState(root, stateEnv);
    if (!state) return;

    if (state.corrupt) {
      await send(
        `[ГЕЙТ КАЧЕСТВА 1С]\nМаркер ${stateEnv.QG_STATE_DIR}/qg-pending.json повреждён и не читается.\n` +
          'Прогони skill quality-gate заново либо удали маркер вручную, если правки не требуют проверки.'
      ).catch(() => {});
      return;
    }

    const mine = state.sessions?.[sessionId]?.files || {};
    const files = Object.entries(mine);
    if (files.length === 0) return;

    // Отпечаток состава правок: новая правка меняет его и сбрасывает счётчик
    // возвратов. На неизменный состав — не более MAX_REPROMPTS попыток.
    const fingerprint = JSON.stringify(files.map(([f, v]) => [f, v.edits, v.lastEdit]).sort());
    let entry = reprompts.get(sessionId);
    if (!entry || entry.fingerprint !== fingerprint) entry = { fingerprint, count: 0 };
    entry.count += 1;
    reprompts.set(sessionId, entry);
    if (reprompts.size > 200) {
      // Долгоживущий процесс, карта не должна расти. Вытесняем чужие сессии —
      // счётчик ТЕКУЩЕЙ сессии сбрасывать нельзя, иначе лимит возвратов обнулялся бы
      // самой же уборкой.
      for (const id of reprompts.keys()) {
        if (reprompts.size <= 200) break;
        if (id !== sessionId) reprompts.delete(id);
      }
    }

    if (entry.count > MAX_REPROMPTS) {
      // Первое превышение лимита — момент сдачи гейта: фиксируем в журнале,
      // чтобы отказ от проверки был наблюдаемым фактом, а не тихим умолчанием.
      if (entry.count === MAX_REPROMPTS + 1) journalSurrender(sessionId, files);
      return;
    }

    const foreign = Object.entries(state.sessions || {})
      .filter(([id]) => id !== sessionId)
      .reduce((sum, [, s]) => sum + Object.keys(s.files || {}).length, 0);

    await send(
      core.blockMessage({
        sessionId,
        subagentTool,
        files,
        foreign,
        packageRoot,
        mode: 'opencode',
        repeated: entry.count,
        maxReprompts: MAX_REPROMPTS,
        passes: core.passesOf({ root, sessionId, env: stateEnv }),
      })
    ).catch(() => {});
  };
}

/**
 * Снимок состояния до команды оболочки. Общий для V1 (tool.execute.before) и V2
 * (ctx.tool.hook("execute.before")): у версий различаются только формы события.
 */
function shellTrackBefore({ shell, root, shellCalls, callId, sessionId, args }) {
  // Файла у команды нет: что она изменила, ядро (hooks/shell-core.mjs) выясняет
  // по снимку до и после, как хук Claude Code gate-shell.mjs.
  const command = String(args?.command || '');
  const cwd = args?.workdir || root;
  const key = shell.callKey({ id: callId, sessionId, command });
  shellCalls.set(callId, { command, cwd, key });
  shell.shellBefore({ root, cwd, command, key });
}

/**
 * Взвод гейта по завершённой команде оболочки. Возвращает массив заметок для модели
 * либо null, если вызов не отслеживался или взводить нечего.
 */
function shellTrackAfter({ shell, core, root, shellCalls, callId, sessionId, ensureConfig, readConfig, stateEnv, packageRoot }) {
  const call = shellCalls.get(callId);
  if (!call) return null;
  shellCalls.delete(callId);
  const { armed, blind } = shell.shellAfter({ root, ...call, sessionId, ensureConfig, readConfig, env: stateEnv });
  const notes = [];
  if (armed.length) {
    notes.push(
      '[изменено командой оболочки]\n' +
        core.gateHint({
          ...armed[0],
          sessionId,
          packageRoot,
          mode: 'opencode',
          passes: core.passesOf({ root, sessionId, env: stateEnv }),
        })
    );
    if (armed.length > 1) notes.push('Также взведены:\n' + armed.slice(1).map((a) => `Файл: ${a.rel}`).join('\n'));
    notes.push(core.disownLines({ sessionId, packageRoot }).join('\n'));
  }
  if (blind.length) notes.push('Гейт не смог посмотреть правки оболочки: ' + blind.join('; '));
  return notes.length ? notes : null;
}

/**
 * Взвод гейта по завершённой правке. Общий для V1 (tool.execute.after) и V2
 * (ctx.tool.hook("execute.after")): у версий различаются только формы события.
 * Возвращает подсказку для модели либо null, если правка не относится к 1С.
 */
function armAfterEdit({ core, ensureConfig, readConfig, stateEnv, root, packageRoot, pendingCalls, callId, sessionId, tool, args }) {
  const file = pendingCalls.get(callId) || fileOfArgs(args);
  pendingCalls.delete(callId);
  if (!file) return null;

  // Реагируем только на инструменты правки, как matcher исходного хука.
  if (!EDIT_TOOLS.has(String(tool || '').toLowerCase())) return null;

  const abs = isAbsolute(file) ? file : resolve(root, file);
  const sid = String(sessionId || 'unknown-session');
  const armed = core.armGate({
    root,
    filePath: abs,
    sessionId: sid,
    ensureConfig,
    readConfig,
    env: stateEnv,
  });
  if (!armed) return null;

  return core.gateHint({
    ...armed,
    sessionId: sid,
    packageRoot,
    mode: 'opencode',
    passes: core.passesOf({ root, sessionId: sid, env: stateEnv }),
  });
}

/**
 * Файлы, затронутые патчем инструмента patch (V2): у него нет аргумента-пути, весь состав
 * правок лежит в тексте патча заголовками «*** Add File», «*** Update File», «*** Move to».
 * Без разбора этого текста правка модуля патчем не взводила бы гейт — молча.
 */
function filesOfPatch(text) {
  if (typeof text !== 'string') return [];
  const found = new Set();
  for (const m of text.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+?)\s*$/gm)) found.add(m[1]);
  return [...found];
}

/** Взвод гейта по завершённому патчу: каждый затронутый файл — отдельным armAfterEdit. */
function armAfterPatch({ core, ensureConfig, readConfig, stateEnv, root, packageRoot, callId, sessionId, input }) {
  const armed = [];
  for (const file of filesOfPatch(input?.patchText)) {
    const hint = armAfterEdit({
      core,
      ensureConfig,
      readConfig,
      stateEnv,
      root,
      packageRoot,
      pendingCalls: new Map([[callId, file]]),
      callId,
      sessionId,
      tool: 'patch',
      args: input,
    });
    if (hint) armed.push({ file, hint });
  }
  if (!armed.length) return null;
  const rest = armed.slice(1);
  return armed[0].hint + (rest.length ? '\nТакже взведены:\n' + rest.map((a) => `Файл: ${a.file}`).join('\n') : '');
}

// ---------------------------------------------------------------------------
// OpenCode V1: функция плагина, возвращающая объект хуков.
// ---------------------------------------------------------------------------

export const QualityGatePlugin = async ({ project, client, directory, worktree }) => {
  // Корень проекта: рабочее дерево точнее (git worktree), иначе каталог запуска.
  const root = worktree || directory || process.cwd();

  // Каталог состояния: OpenCode держит его отдельно от Claude Code — .opencode/.state
  // вместо .claude/.state (tools/state-dir.mjs). Значение вычисляется ОДИН раз и отсюда
  // же уходит в оболочку агента хуком shell.env. Разойтись эти два пути не должны:
  // взвод пошёл бы в один каталог, а снятие через gate.mjs — в другой, и гейт не
  // снимался бы никогда. Значение пользователя уважается, если он задал его сам.
  const stateEnv = { QG_STATE_DIR: process.env.QG_STATE_DIR || '.opencode/.state' };

  // Корень пакета и ядро механики гейта. Если импорт не удался (пакет установлен
  // частично), плагин молчит — ложный гейт хуже отсутствующего.
  const packageRoot = resolvePackageRoot();
  if (!packageRoot) return {};

  const deps = await loadGateDeps(packageRoot);
  if (!deps) return {};
  const { core, stateDir, ensureConfig, readConfig, shell } = deps;

  // Карта callID → путь файла: аргументы известны на before, взводим на after,
  // когда правка фактически состоялась.
  const pendingCalls = new Map();

  // Карта callID → команда оболочки.
  const shellCalls = new Map();

  const handleIdle = createIdleGate({ root, core, stateDir, stateEnv, packageRoot });

  return {
    /**
     * Состав пакета — в живую конфигурацию. Пользовательские записи не перекрываются:
     * своё имя команды, субагента или MCP-сервера всегда сильнее нашего.
     */
    config: async (cfg) => {
      try {
        cfg.skills = cfg.skills || {};
        cfg.skills.paths = Array.isArray(cfg.skills.paths) ? cfg.skills.paths : [];
        const skillsDir = join(packageRoot, 'skills');
        if (!cfg.skills.paths.includes(skillsDir)) cfg.skills.paths.push(skillsDir);

        cfg.command = cfg.command || {};
        for (const [name, def] of commandsFrom(join(packageRoot, 'opencode', 'commands'))) {
          if (cfg.command[name] === undefined) cfg.command[name] = def;
        }

        // Субагенты читаются из общего каталога agents/ — того же, что у Claude Code.
        // Отдельной копии под OpenCode нет: frontmatter переводится в registry.js.
        cfg.agent = cfg.agent || {};
        for (const [name, def] of agentsFrom(join(packageRoot, 'agents'))) {
          if (cfg.agent[name] === undefined) cfg.agent[name] = def;
        }

        // Исполнитель гейта запускает субагентов контуров, то есть работает на втором уровне
        // вложенности, а умолчание OpenCode — один. Свою, более глубокую настройку не понижаем.
        cfg.subagent_depth = Math.max(Number(cfg.subagent_depth) || 1, 2);

        cfg.mcp = cfg.mcp || {};
        if (cfg.mcp.v8std === undefined) cfg.mcp.v8std = { ...V8STD_MCP };
      } catch {
        /* неполная регистрация лучше сломанной конфигурации */
      }
    },

    /**
     * Окружение оболочки. Инструменты пакета запускает агент, а не плагин, поэтому
     * корень пакета, корень проекта и каталог состояния он обязан получить готовыми.
     * Уже заданное значение не перекрываем: осознанная переменная пользователя сильнее.
     */
    'shell.env': async (_input, output) => {
      try {
        if (!output || typeof output.env !== 'object' || output.env === null) return;
        if (!output.env.QG_ROOT) output.env.QG_ROOT = packageRoot;
        if (!output.env.QG_PROJECT_DIR) output.env.QG_PROJECT_DIR = root;
        if (!output.env.QG_STATE_DIR) output.env.QG_STATE_DIR = stateEnv.QG_STATE_DIR;
      } catch {
        /* окружение не обязано ломать запуск оболочки */
      }
    },

    'tool.execute.before': async (input, output) => {
      try {
        if (String(input.tool || '').toLowerCase() === 'bash') {
          if (!shell) return;
          shellTrackBefore({ shell, root, shellCalls, callId: input.callID, sessionId: input.sessionID, args: output?.args });
          return;
        }
        const file = fileOfArgs(output?.args);
        if (file) pendingCalls.set(input.callID, file);
      } catch {
        /* никогда не ломаем вызов инструмента */
      }
    },

    'tool.execute.after': async (input, output) => {
      try {
        const notes = shell
          ? shellTrackAfter({
              shell,
              core,
              root,
              shellCalls,
              callId: input.callID,
              sessionId: String(input.sessionID || 'unknown-session'),
              ensureConfig,
              readConfig,
              stateEnv,
              packageRoot,
            })
          : null;
        if (notes) {
          if (output && typeof output.output === 'string') output.output += '\n\n' + notes.join('\n');
          return;
        }

        const hint = armAfterEdit({
          core,
          ensureConfig,
          readConfig,
          stateEnv,
          root,
          packageRoot,
          pendingCalls,
          callId: input.callID,
          sessionId: input.sessionID,
          tool: input.tool,
          args: output?.args,
        });
        if (!hint) return;

        // Аналог additionalContext хука Claude Code: подсказка уходит модели вместе
        // с результатом инструмента — о взводе узнают немедленно, а не на паузе.
        if (output && typeof output.output === 'string') {
          output.output += '\n\n' + hint;
        }
      } catch {
        /* гейт качества никогда не ломает работу пользователя */
      }
    },

    event: async ({ event }) => {
      try {
        if (event?.type !== 'session.idle') return;
        const sessionId = String(event?.properties?.sessionID || '');
        if (!sessionId) return;

        await handleIdle(sessionId, (text, opts) =>
          client.session.prompt({
            path: { id: sessionId },
            body: { ...(opts?.note ? { noReply: true } : {}), parts: [{ type: 'text', text }] },
          })
        );
      } catch {
        /* сбой плагина не должен запирать пользователя в сессии */
      }
    },
  };
};

// ---------------------------------------------------------------------------
// OpenCode V2: setup(ctx) с регистрацией через домены контекста.
// ---------------------------------------------------------------------------

/**
 * Результат инструмента с дописанной подсказкой — НОВЫЙ объект. Поля результата в типах V2
 * помечены readonly, а документация подменяет `event.result` целиком, поэтому исходный
 * результат и его части не правим: правка на замороженном объекте падает, а исключение
 * тут гасится, и подсказка пропала бы молча.
 */
function resultWithHint(result, hint) {
  const base = result && typeof result === 'object' ? result : {};
  const content = base.content;
  if (typeof content === 'string') return { ...base, content: content + '\n\n' + hint };
  if (Array.isArray(content)) {
    const parts = content.slice();
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part && part.type === 'text' && typeof part.text === 'string') {
        parts[i] = { ...part, text: part.text + '\n\n' + hint };
        return { ...base, content: parts };
      }
    }
    parts.push({ type: 'text', text: hint });
    return { ...base, content: parts };
  }
  // После нормализации в рантайме V2 content есть всегда; запасной путь — машиночитаемое output.
  if (typeof base.output === 'string') return { ...base, content: base.output + '\n\n' + hint };
  return { ...base, content: hint };
}

/**
 * Регистрация с гашением ошибок и сбором disposer'ов. Каждый домен V2 регистрируется
 * независимо: отказ одного (например, усечённый контекст TUI-процесса) не обязан
 * выключать остальные.
 */
async function register(disposers, promise) {
  try {
    const reg = await promise;
    if (reg && typeof reg.dispose === 'function') disposers.push(() => reg.dispose());
  } catch {
    /* неполная регистрация лучше сломанной конфигурации */
  }
}

async function setup(ctx) {
  // Корень проекта. V1 брал worktree — корень репозитория; в V2 ему соответствует
  // location.project.directory (OpenCode ищет его вверх от каталога запуска по .git).
  // location.directory — каталог запуска, он может быть вложенным, и состояние гейта
  // тогда оказалось бы в подкаталоге, а правки вне него не взводили бы гейт.
  const root =
    ctx?.location?.project?.directory ||
    ctx?.location?.directory ||
    ctx?.location?.project?.canonical ||
    process.cwd();

  const stateEnv = { QG_STATE_DIR: process.env.QG_STATE_DIR || '.opencode/.state' };

  const packageRoot = resolvePackageRoot();
  if (!packageRoot) return;

  const deps = await loadGateDeps(packageRoot);
  if (!deps) return;
  const { core, stateDir, ensureConfig, readConfig, shell } = deps;

  const pendingCalls = new Map();
  const shellCalls = new Map();
  const handleIdle = createIdleGate({ root, core, stateDir, stateEnv, packageRoot, subagentTool: V2_SUBAGENT_TOOL });
  const disposers = [];

  // ── Навыки ──
  // Снимок состава читается ДО регистрации трансформа: колбэк синхронный, а трансформы
  // переигрываются при каждой перестройке реестра. Своё имя сильнее нашего.
  await register(
    disposers,
    (async () => {
      if (typeof ctx.skill?.transform !== 'function') return undefined;
      const skills = skillsFrom(join(packageRoot, 'skills'));
      if (!skills.length) return undefined;
      return ctx.skill.transform((editor) => {
        if (typeof editor.add !== 'function') return;
        for (const info of skills) {
          if (editor.get?.(info.id) !== undefined) continue;
          editor.add(info);
        }
      });
    })()
  );

  // ── Команды /gate, /gate-status ──
  // В V2 у команды нет template: editor.add принимает { name, description, execute },
  // а execute сам отправляет промпт в сессию. Шаблоном остаётся тело markdown-файла
  // из opencode/commands/ — тот же источник, что у V1.
  await register(
    disposers,
    (async () => {
      if (typeof ctx.command?.transform !== 'function') return undefined;
      const defs = commandsFrom(join(packageRoot, 'opencode', 'commands'));
      if (!defs.length) return undefined;
      let known = new Set();
      try {
        const listed = await ctx.command.list();
        const arr = Array.isArray(listed) ? listed : listed?.data;
        if (Array.isArray(arr)) known = new Set(arr.map((c) => c?.name).filter(Boolean));
      } catch {
        /* недоступный список — не повод не регистрироваться */
      }
      return ctx.command.transform((editor) => {
        if (typeof editor.add !== 'function') return;
        for (const [name, def] of defs) {
          if (known.has(name)) continue;
          try {
            editor.add({
              name,
              ...(typeof def.description === 'string' ? { description: def.description } : {}),
              execute: async ({ sessionID, prompt, delivery }) => {
                // Тело команды использует $ARGUMENTS; в V2 аргументы приходят в prompt.text.
                const args = typeof prompt?.text === 'string' ? prompt.text.trim() : '';
                const text = String(def.template).split('$ARGUMENTS').join(args);
                await ctx.session.prompt({ sessionID, text, ...(delivery ? { delivery } : {}) });
              },
            });
          } catch {
            /* одна битая команда не отменяет остальные */
          }
        }
      });
    })()
  );

  // ── Субагенты ──
  // Источник один — agents/ в корне пакета (тот же, что у Claude Code). У редактора
  // агентов V2 нет add: запись создаётся через update(name, fn) — так же, как это
  // делают другие плагины, поставляющие свои агенты. Своё имя сильнее нашего.
  await register(
    disposers,
    (async () => {
      if (typeof ctx.agent?.transform !== 'function') return undefined;
      const defs = agentsV2From(join(packageRoot, 'agents'));
      if (!defs.length) return undefined;
      return ctx.agent.transform((editor) => {
        for (const [name, def] of defs) {
          if (editor.get?.(name) !== undefined) continue;
          editor.update(name, (agent) => {
            agent.id = name;
            agent.name = name;
            agent.mode = def.mode;
            agent.hidden = false;
            if (def.description !== undefined) agent.description = def.description;
            agent.system = def.system;
            agent.permissions = def.permissions.map((r) => ({ ...r }));
          });
        }
      });
    })()
  );

  // ── MCP-сервер стандартов v8std ──
  await register(
    disposers,
    (async () => {
      if (typeof ctx.mcp?.transform !== 'function') return undefined;
      return ctx.mcp.transform((editor) => {
        if (editor.get?.('v8std') !== undefined) return;
        editor.set('v8std', { ...V8STD_MCP_V2 });
      });
    })()
  );

  // ── Окружение оболочки ──
  // V1-хук shell.env в V2 — shell.hook("create.before") с изменяемым event.env.
  // Смысл тот же: инструменты пакета запускает агент из оболочки, и корень пакета,
  // корень проекта и каталог состояния он обязан получить готовыми. Заданное
  // пользователем не перекрываем.
  await register(
    disposers,
    (async () => {
      if (typeof ctx.shell?.hook !== 'function') return undefined;
      return ctx.shell.hook('create.before', (event) => {
        try {
          if (!event || typeof event.env !== 'object' || event.env === null) return;
          if (!event.env.QG_ROOT) event.env.QG_ROOT = packageRoot;
          if (!event.env.QG_PROJECT_DIR) event.env.QG_PROJECT_DIR = root;
          if (!event.env.QG_STATE_DIR) event.env.QG_STATE_DIR = stateEnv.QG_STATE_DIR;
          if (!event.env.QG_SUBAGENT_TOOL) event.env.QG_SUBAGENT_TOOL = V2_SUBAGENT_TOOL;
        } catch {
          /* окружение не обязано ломать запуск оболочки */
        }
      });
    })()
  );

  // ── Взвод гейта ──
  await register(
    disposers,
    (async () => {
      if (typeof ctx.tool?.hook !== 'function') return undefined;
      return ctx.tool.hook('execute.before', (event) => {
        try {
          // Аргументы вызова в V2 — event.input (одно изменяемое событие вместо
          // пары input/output из V1); идентификатор вызова — event.id.
          if (V2_SHELL_TOOLS.has(String(event?.tool || '').toLowerCase())) {
            if (!shell) return;
            shellTrackBefore({ shell, root, shellCalls, callId: event.id, sessionId: event.sessionID, args: event.input });
            return;
          }
          const file = fileOfArgs(event?.input);
          if (file) pendingCalls.set(event.id, file);
        } catch {
          /* никогда не ломаем вызов инструмента */
        }
      });
    })()
  );

  await register(
    disposers,
    (async () => {
      if (typeof ctx.tool?.hook !== 'function') return undefined;
      return ctx.tool.hook('execute.after', (event) => {
        try {
          const sessionId = String(event.sessionID || 'unknown-session');
          const completed = event?.status === 'completed';

          // Оболочка: команда, упавшая после записи файла, правку всё равно оставила, поэтому
          // снимок сверяется при любом статусе (это же освобождает запись shellCalls).
          if (shell) {
            const notes = shellTrackAfter({
              shell,
              core,
              root,
              shellCalls,
              callId: event.id,
              sessionId,
              ensureConfig,
              readConfig,
              stateEnv,
              packageRoot,
            });
            if (notes) {
              // У упавшего вызова результата нет: гейт взведён, а напомнит о нём возврат на паузе.
              if (completed) event.result = resultWithHint(event.result, notes.join('\n'));
              return;
            }
          }

          // Правка инструментом: у провалившегося вызова правки не было, взводить нечего.
          if (!completed) {
            pendingCalls.delete(event.id);
            return;
          }

          const hint =
            String(event.tool || '').toLowerCase() === 'patch'
              ? armAfterPatch({
                  core,
                  ensureConfig,
                  readConfig,
                  stateEnv,
                  root,
                  packageRoot,
                  callId: event.id,
                  sessionId,
                  input: event.input,
                })
              : armAfterEdit({
                  core,
                  ensureConfig,
                  readConfig,
                  stateEnv,
                  root,
                  packageRoot,
                  pendingCalls,
                  callId: event.id,
                  sessionId,
                  tool: event.tool,
                  args: event.input,
                });
          if (!hint) return;
          event.result = resultWithHint(event.result, hint);
        } catch {
          /* гейт качества никогда не ломает работу пользователя */
        }
      });
    })()
  );

  // ── Мягкий гейт на паузе сессии ──
  // В V2 жизненный цикл приходит durable-событиями session.execution.*, и завершение
  // прогона — session.execution.succeeded (payload под ключом data; properties — устаревшее
  // написание). failed/interrupted паузой не считаем: прерванный прогон — это пользователь
  // сам остановил работу, а не агент собрался завершать. session.idle в схеме V2 помечен
  // устаревшим, но принимается: старый клиент мог бы прислать только его.
  //
  // Один конец прогона может прийти двумя событиями, и без защиты агент получил бы два
  // одинаковых возврата, а счётчик MAX_REPROMPTS расходовался бы вдвое быстрее. Повтор
  // отбрасывается, если после обработки не началось нового прогона (started) и прошло меньше
  // DUPLICATE_WINDOW_MS. Привязка только к started опасна: сборка OpenCode без этого события
  // отключила бы гейт насовсем и тихо, поэтому окно по времени ограничивает отсечение.
  if (typeof ctx?.event?.subscribe === 'function' && typeof ctx?.session?.prompt === 'function') {
    const controller = new AbortController();
    disposers.push(() => controller.abort());
    const handledAt = new Map();
    const warnLost = (why) => {
      if (controller.signal.aborted) return;
      console.error(
        `[1c-quality-gate] ВНИМАНИЕ: поток событий OpenCode оборвался (${why}). ` +
          'Возврат к работе на паузе сессии отключён до перезапуска; взвод по правкам работает.'
      );
    };
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            const type = event?.type;
            const sessionId = event?.data?.sessionID ?? event?.properties?.sessionID;
            if (!sessionId) continue;
            const id = String(sessionId);
            if (type === 'session.execution.started') {
              handledAt.delete(id);
              continue;
            }
            if (type !== 'session.idle' && type !== 'session.execution.succeeded') continue;
            const last = handledAt.get(id);
            if (last !== undefined && Date.now() - last < DUPLICATE_WINDOW_MS) continue;
            try {
              // note — уведомление, а не задание: resume: false кладёт сообщение во входящие
              // и не запускает ход модели (в V2 нет noReply; тело prompt не допускает лишних полей).
              await handleIdle(id, (text, opts) =>
                ctx.session.prompt({ sessionID: id, text, ...(opts?.note ? { resume: false } : {}) })
              );
            } finally {
              handledAt.set(id, Date.now());
              if (handledAt.size > 500) handledAt.delete(handledAt.keys().next().value);
            }
          } catch {
            /* одно битое событие не останавливает поток */
          }
        }
        warnLost('поток закрыт хостом');
      } catch (error) {
        warnLost(String(error?.message || error).slice(0, 120));
      }
    })();
  }

  // Загрузка, не зарегистрировавшая НИЧЕГО, неотличима от успешной снаружи —
  // оставляем наблюдаемый след, как это делает journalSurrender для гейта.
  if (disposers.length === 0) {
    console.error(
      '[1c-quality-gate] ВНИМАНИЕ: плагин загрузился, но не зарегистрировал ни одного ' +
        'расширения (усечённый контекст хоста?). Гейт не работает.'
    );
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* выгрузка не обязана падать из-за одного disposer'а */
      }
    }
  };
}

/**
 * Точка входа для обеих версий. V2 читает id и setup; V1 (>= 1.18.29) вызывает
 * server(). Именованный экспорт QualityGatePlugin оставлен для старых загрузчиков
 * и тестов V1.
 */
export default {
  id: '1c-quality-gate',
  server: QualityGatePlugin,
  setup,
};
