#!/usr/bin/env node
/**
 * UserPromptSubmit-хук: сообщение пользователя начинает счёт проходов цикла заново.
 *
 * Потолок в три прохода (tools/gate-cycle.mjs) ограничивает автономный цикл «проход →
 * исправить → проход». Вмешавшийся пользователь — другой случай: он сам решил продолжать, и
 * отсчёт идёт с его сообщения. Записи проходов не стираются: следующий выпуск берёт из них базу
 * прохода по исправлению.
 *
 * Хук срабатывает на каждое сообщение в любом проекте, где включён плагин, поэтому работает
 * только с уже существующим состоянием и уже взведённой сессией; иначе — ничего, молча.
 */

import { readPayload, projectRoot } from './_shared.mjs';
import { notePrompt, updateSession } from '../tools/gate-cycle.mjs';

try {
  const payload = readPayload();
  if (payload?.session_id) {
    updateSession({ root: projectRoot(payload), sessionId: String(payload.session_id), mutate: (s) => notePrompt(s) });
  }
} catch {
  /* хук качества никогда не ломает работу пользователя */
}
process.exit(0);
