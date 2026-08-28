/**
 * Корень проекта — единственное место, где он определяется.
 *
 * Зачем отдельный модуль. Раньше эту строку копировали четыре раза (`config.mjs`,
 * `analyzer-run.mjs`, `gate.mjs`, `hooks/_shared.mjs`), и все копии сводились к
 * `process.env.CLAUDE_PROJECT_DIR || process.cwd()`. Измерено: **в оболочке эта переменная
 * пуста** — ровно как `CLAUDE_PLUGIN_ROOT`, о котором предупреждает навык оркестратора.
 * Значит рабочим был не запасной путь, а единственный, и корнем проекта становился тот
 * каталог, из которого запустили команду.
 *
 * Чем это плохо, если каталог оказался подкаталогом:
 *   - `.1c-quality-gate.json` не находится, настройка молча выглядит отсутствующей, и в след
 *     уходит `config=default` в проекте с переопределёнными порогами. Валидатор такой след
 *     принимает: он сверяет отметку с настройкой, прочитанной так же — из подкаталога;
 *   - `gate.mjs status` не видит взведённого гейта и отвечает «изменений не зафиксировано».
 *     Состав правки читается по этому выводу, поэтому профиль считается по пустому множеству,
 *     класс выходит C0, а контуры пропускаются законным образом;
 *   - `gate.mjs release` рапортует «снимать нечего» с кодом возврата 0, не сняв ничего.
 *
 * Общее у всех трёх — сменой рабочего каталога проверка не падает, а тихо становится
 * пустой. Это тот же класс отказа, против которого написан весь формат следа.
 *
 * Порядок разрешения:
 *   1. `QG_PROJECT_DIR` / `OPENCODE_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` — если харнесс
 *      задал корень явно, он знает точнее нас;
 *   2. подъём до `.1c-quality-gate.json` — настройка гейта лежит в корне по определению;
 *   3. подъём до `.git`;
 *   4. исходный каталог — сказать больше нечего, но об этом можно сообщить (`via: 'start'`).
 *
 * Маркеры проверяются по очереди, каждый — полным подъёмом. Настройка важнее `.git`: в
 * репозитории с несколькими конфигурациями 1С корнем гейта может быть подкаталог, и тогда
 * настройка лежит там, а `.git` — выше.
 *
 * `.claude` маркером НЕ является намеренно: такой каталог есть и в домашнем, и подъём из
 * проекта без git объявил бы корнем проекта домашний каталог пользователя.
 */

import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

/** Маркеры корня в порядке убывания точности. */
export const ROOT_MARKERS = ['.1c-quality-gate.json', '.git'];

/**
 * Разрешает корень проекта и сообщает, чем он опознан.
 *
 * Возвращает `{ root, via, marker }`, где `via` — `env` | `marker` | `start`. Способ нужен
 * не для красоты: «настройки нет» и «мы смотрели не туда» выглядят одинаково, пока не сказано,
 * откуда взялся корень.
 */
export function resolveProjectRoot(start = process.cwd(), env = process.env) {
  // QG_PROJECT_DIR выставляет плагин OpenCode (opencode/plugin/quality-gate.js) —
  // аналог CLAUDE_PROJECT_DIR для харнесса без собственной переменной корня.
  const fromEnv = env.QG_PROJECT_DIR || env.OPENCODE_PROJECT_DIR || env.CLAUDE_PROJECT_DIR;
  if (fromEnv) return { root: fromEnv, via: 'env', marker: null };

  const from = resolve(start || process.cwd());
  for (const marker of ROOT_MARKERS) {
    let dir = from;
    for (;;) {
      if (existsSync(join(dir, marker))) return { root: dir, via: 'marker', marker };
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { root: from, via: 'start', marker: null };
}

/** Только путь — для тех, кому способ опознания не нужен. */
export function projectRoot(start = process.cwd(), env = process.env) {
  return resolveProjectRoot(start, env).root;
}
