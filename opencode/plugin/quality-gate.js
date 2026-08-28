/**
 * 1c-quality-gate — механика гейта качества 1С для OpenCode.
 *
 * Адаптация двух хуков Claude Code (gate-arm/gate-check) на плагинный API OpenCode:
 *
 *   - "tool.execute.before/after" — взвод гейта при правке .bsl/.os/XML метаданных
 *     (аналог PostToolUse). Подсказка дописывается в результат инструмента, чтобы
 *     модель увидела взвод немедленно, а не при попытке завершить работу.
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
 * ВАЖНОЕ ОТЛИЧИЕ ОТ ХУКОВ CLAUDE CODE. В Claude Code Stop-хук жёстко отказывает
 * в завершении сессии (exit 2). У OpenCode такого механизма нет: плагин не может
 * запретить завершение, он отправляет агенту новое сообщение, и тот продолжает
 * работу. Это настойчивый, но мягкий гейт: пользователь всегда может прервать
 * сессию вручную. Чтобы цикл «idle → возврат» не был бесконечным спамом, на
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
import { agentsFrom, commandsFrom } from './registry.js';

/**
 * MCP-сервер стандартов. Зависимость обязательная, а не удобство: без подтверждённого
 * часового источника стандартов гейт не снимается. Регистрируется, только если у
 * пользователя нет своей записи с этим именем.
 */
const V8STD_MCP = { type: 'remote', url: 'https://ai.v8std.ru/mcp', enabled: true };

/** Максимум автоматических возвратов на неизменный состав правок. */
const MAX_REPROMPTS = 3;

/** Верхняя граница журнала прогонов (tools/run-journal.mjs). */
const JOURNAL_KEEP = 500;

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

  let core = null;
  let stateDir = null;
  let ensureConfig = null;
  try {
    // file-URL, а не путь: динамический import() по голому пути на Windows
    // падает с ERR_UNSUPPORTED_ESM_URL_SCHEME, и плагин молча не работал бы вообще.
    core = await import(pathToFileURL(join(packageRoot, 'hooks', 'gate-core.mjs')).href);
    stateDir = await import(pathToFileURL(join(packageRoot, 'tools', 'state-dir.mjs')).href);
    ({ ensureConfig } = await import(pathToFileURL(join(packageRoot, 'tools', 'config.mjs')).href));
  } catch {
    return {};
  }

  // Карта callID → путь файла: аргументы известны на before, взводим на after,
  // когда правка фактически состоялась.
  const pendingCalls = new Map();

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
        const file = fileOfArgs(output?.args);
        if (file) pendingCalls.set(input.callID, file);
      } catch {
        /* никогда не ломаем вызов инструмента */
      }
    },

    'tool.execute.after': async (input, output) => {
      try {
        const file = pendingCalls.get(input.callID) || fileOfArgs(output?.args);
        pendingCalls.delete(input.callID);
        if (!file) return;

        // Реагируем только на инструменты правки, как matcher исходного хука.
        const tool = String(input.tool || '').toLowerCase();
        if (!['write', 'edit', 'multiedit', 'patch', 'notebookedit'].includes(tool)) return;

        const abs = isAbsolute(file) ? file : resolve(root, file);
        const armed = core.armGate({
          root,
          filePath: abs,
          sessionId: String(input.sessionID || 'unknown-session'),
          ensureConfig,
          env: stateEnv,
        });
        if (!armed) return;

        const hint = core.gateHint({ ...armed, packageRoot, mode: 'opencode' });
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

        const state = core.readPendingState(root, stateEnv);
        if (!state) return;

        if (state.corrupt) {
          await client.session
            .prompt({
              path: { id: sessionId },
              body: {
                parts: [
                  {
                    type: 'text',
                    text:
                      `[ГЕЙТ КАЧЕСТВА 1С]\nМаркер ${stateEnv.QG_STATE_DIR}/qg-pending.json повреждён и не читается.\n` +
                      'Прогони skill quality-gate заново либо удали маркер вручную, если правки не требуют проверки.',
                  },
                ],
              },
            })
            .catch(() => {});
          return;
        }

        const mine = state.sessions?.[sessionId]?.files || {};
        const files = Object.entries(mine);
        if (files.length === 0) return;

        // Отпечаток состава правок: новая правка меняет его и сбрасывает счётчик
        // возвратов. На неизменный состав — не более MAX_REPROMPTS попыток.
        const fingerprint = JSON.stringify(
          files.map(([f, v]) => [f, v.edits, v.lastEdit]).sort()
        );
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

        await client.session
          .prompt({
            path: { id: sessionId },
            body: {
              parts: [
                {
                  type: 'text',
                  text: core.blockMessage({
                    sessionId,
                    files,
                    foreign,
                    packageRoot,
                    mode: 'opencode',
                    repeated: entry.count,
                    maxReprompts: MAX_REPROMPTS,
                  }),
                },
              ],
            },
          })
          .catch(() => {});
      } catch {
        /* сбой плагина не должен запирать пользователя в сессии */
      }
    },
  };
};

export default QualityGatePlugin;
