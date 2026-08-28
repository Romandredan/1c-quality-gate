#!/usr/bin/env node
/**
 * PostToolUse-хук: взводит гейт качества при правке файлов 1С.
 *
 * Логика — в hooks/gate-core.mjs (общая с Stop-хуком и плагином OpenCode),
 * здесь только ввод-вывод харнесса.
 *
 * Любая внутренняя ошибка — молча exit 0: хук качества не имеет права ломать работу.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPayload, projectRoot } from './_shared.mjs';
import { armGate, gateHint } from './gate-core.mjs';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let ensureConfig = null;
try {
  ({ ensureConfig } = await import('../tools/config.mjs'));
} catch {
  /* настройка не обязана мешать взводу гейта */
}

function main() {
  const payload = readPayload();
  if (!payload) return;

  const filePath = payload?.tool_input?.file_path;
  if (!filePath || typeof filePath !== 'string') return;

  const root = projectRoot(payload);
  const sessionId = String(payload?.session_id || 'unknown-session');

  const armed = armGate({ root, filePath, sessionId, ensureConfig });
  if (!armed) return;

  // Вывод обязан быть JSON с hookSpecificOutput: простой текст из PostToolUse до модели
  // НЕ доходит — маркер при этом пишется, и получается гейт, о котором модель узнаёт только
  // при попытке завершить работу. Проверено на живой сессии.
  const hint = gateHint({ ...armed, packageRoot: PACKAGE_ROOT, mode: 'claude' });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: hint,
      },
      systemMessage:
        `Гейт качества 1С взведён: ${armed.rel}` +
        (armed.created ? ` · создана настройка проекта ${armed.created}` : ''),
    }) + '\n'
  );
}

try {
  main();
} catch {
  /* хук качества никогда не ломает работу пользователя */
}
process.exit(0);
