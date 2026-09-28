#!/usr/bin/env node
/**
 * PreToolUse / PostToolUse / PostToolUseFailure-хук на Bash|PowerShell: взводит гейт качества,
 * если команда оболочки изменила файлы 1С.
 *
 * Логика — в hooks/shell-core.mjs (общая с плагином OpenCode), здесь только ввод-вывод
 * харнесса. Команда с ненулевым кодом приходит событием PostToolUseFailure: запись до сбоя —
 * тоже правка.
 *
 * Любая внутренняя ошибка — молча exit 0: хук качества не имеет права ломать работу.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPayload, projectRoot } from './_shared.mjs';
import { gateHint } from './gate-core.mjs';
import { shellBefore, shellAfter, callKey } from './shell-core.mjs';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LIST_MAX = 50;

let ensureConfig = null;
let readConfig = null;
try {
  ({ ensureConfig, readConfig } = await import('../tools/config.mjs'));
} catch {
  /* настройка не обязана мешать взводу гейта */
}

function report({ armed, blind, sessionId, eventName }) {
  if (!armed.length && !blind.length) return;
  const out = {};
  if (armed.length) {
    // Вывод обязан быть JSON с hookSpecificOutput: простой текст из PostToolUse до модели
    // не доходит (см. gate-arm.mjs).
    const first = gateHint({ ...armed[0], sessionId, packageRoot: PACKAGE_ROOT, mode: 'claude' });
    const rest = armed.slice(1, LIST_MAX + 1).map((a) => `Файл: ${a.rel}`);
    if (armed.length > LIST_MAX + 1) rest.push(`… и ещё ${armed.length - LIST_MAX - 1} — полный список: gate.mjs status`);
    out.hookSpecificOutput = {
      hookEventName: eventName,
      additionalContext: '[изменено командой оболочки]\n' + first + (rest.length ? '\nТакже взведены:\n' + rest.join('\n') : ''),
    };
    const names = armed.slice(0, 10).map((a) => a.rel).join(', ') + (armed.length > 10 ? ` и ещё ${armed.length - 10}` : '');
    const created = armed.find((a) => a.created)?.created;
    out.systemMessage =
      `Гейт качества 1С взведён командой оболочки: ${names}` + (created ? ` · создана настройка проекта ${created}` : '');
  }
  if (blind.length) {
    out.systemMessage = (out.systemMessage ? out.systemMessage + ' · ' : '') + 'Гейт не смог посмотреть правки оболочки: ' + blind.join('; ');
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}

try {
  const payload = readPayload();
  if (payload) {
    const sessionId = String(payload?.session_id || 'unknown-session');
    const command = payload?.tool_input?.command;
    const args = {
      root: projectRoot(payload),
      cwd: payload?.cwd,
      command,
      key: callKey({ id: payload?.tool_use_id, sessionId, command }),
    };
    if (process.argv[2] === 'pre') {
      shellBefore(args);
    } else if (process.argv[2] === 'post') {
      const eventName = payload?.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse';
      report({ ...shellAfter({ ...args, sessionId, ensureConfig, readConfig }), sessionId, eventName });
    }
  }
} catch {
  /* хук качества никогда не ломает работу пользователя */
}
process.exit(0);
