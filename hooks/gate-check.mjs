#!/usr/bin/env node
/**
 * Stop-хук: блокирует завершение, пока взведённый гейт качества не снят.
 *
 * exit 2 + сообщение в stderr — единственный механизм, который делает пропуск проверки
 * ОТЛИЧИМЫМ от её выполнения. Без него весь остальной плагин остаётся рекомендацией.
 *
 * Снять гейт может только `tools/gate.mjs release` — он требует непустой evidence,
 * поэтому «снял и забыл» не проходит.
 *
 * Логика — в hooks/gate-core.mjs (общая с PostToolUse-хуком и плагином OpenCode),
 * здесь только ввод-вывод харнесса.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPayload, projectRoot } from './_shared.mjs';
import { readPendingState, blockMessage, residualNote } from './gate-core.mjs';
import { passCount } from '../tools/gate-cycle.mjs';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function main() {
  const payload = readPayload();

  // stop_hook_active НЕ является основанием пропустить блок. Иначе гейт обходится второй
  // попыткой завершения: первый Stop блокирует, второй проходит с непроверенным кодом —
  // и весь механизм вырождается в разовое предупреждение. Зацикливания здесь нет по
  // построению: выход из блока всегда доступен (прогон навыка либо явное снятие с
  // указанием причины), а на повторной попытке сообщение дополняется прямым путём.
  const repeated = Boolean(payload?.stop_hook_active);
  const root = projectRoot(payload);
  const sessionId = String(payload?.session_id || 'unknown-session');

  // Итог снятого гейта — один раз, независимо от того, что написала модель. Считается до
  // чтения состояния: после снятия последней сессии файла состояния может уже не быть.
  const note = residualNote({ root, sessionId });
  const relay = () => {
    if (note) process.stdout.write(JSON.stringify({ systemMessage: note }) + '\n');
    return 0;
  };

  const state = readPendingState(root);
  if (!state) return relay();

  if (state.corrupt) {
    // Повреждённый маркер — блокируем: неизвестное состояние безопаснее считать непроверенным.
    process.stderr.write(
      '[ГЕЙТ КАЧЕСТВА 1С — ЗАВЕРШЕНИЕ ЗАБЛОКИРОВАНО]\n' +
        'Маркер .claude/.state/qg-pending.json повреждён и не читается.\n' +
        'Прогони Skill: quality-gate заново либо удали маркер вручную, если правки не требуют проверки.\n'
    );
    return 2;
  }

  // Блокируем ТОЛЬКО за правки этой сессии. Чужие остаются в состоянии нетронутыми:
  // параллельная сессия отвечает за свой гейт сама, а перехватывать её работу нельзя.
  const sessions = state.sessions || {};
  const mine = sessions[sessionId]?.files || {};
  const files = Object.entries(mine);

  const foreign = Object.entries(sessions)
    .filter(([id]) => id !== sessionId)
    .reduce((sum, [, s]) => sum + Object.keys(s.files || {}).length, 0);

  if (files.length === 0) {
    if (foreign > 0) {
      // Не блокируем, но и не скрываем: пусть видно, что в проекте есть непроверенные
      // правки другой сессии — их владелец разберётся с ними сам.
      process.stderr.write(
        `[гейт качества] В проекте есть непроверенные правки другой сессии (${foreign}). ` +
          'Эта сессия их не касалась — завершение не блокируется.\n'
      );
    }
    return relay();
  }

  process.stderr.write(
    blockMessage({ sessionId, files, foreign, packageRoot: PACKAGE_ROOT, mode: 'claude', repeated, passes: passCount(sessions[sessionId]) }) + '\n'
  );
  return 2;
}

let code = 0;
try {
  code = main();
} catch {
  // Сбой самого хука не должен запирать пользователя в сессии.
  code = 0;
}
process.exit(code);
