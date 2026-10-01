/**
 * Цикл гейта: проходы, решения, сообщение пользователя.
 *
 * Зачем. По журналам рабочего проекта сессия запускала проверку до девяти раз подряд: после
 * каждого прохода исправляла найденное, правка взводила гейт заново, и следующий проход был
 * полным. Потолок в три прохода на цикл делает это наблюдаемым и конечным; четвёртый проход
 * возможен только с записанным решением. Сообщение пользователя сбрасывает счёт: вмешавшись,
 * он начинает отсчёт заново, а записи проходов остаются — они нужны следующему выпуску как
 * база прохода по исправлению.
 *
 * Цикл — от взвода до снятия: `release` переносит `cycle` в журнал снятий, новый взвод после
 * снятия начинает запись заново. Спецификация:
 * docs/superpowers/specs/2026-10-01-gate-passes-convergence-design.md.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirSegments } from './state-dir.mjs';
import { withStateLock } from './state-lock.mjs';

const PENDING = 'qg-pending.json';

export const MAX_PASSES = 3;

function cycleOf(session) {
  if (!session.cycle) session.cycle = { passes: [], decisions: [] };
  session.cycle.passes = session.cycle.passes || [];
  session.cycle.decisions = session.cycle.decisions || [];
  return session.cycle;
}

/** Проходы после последнего сообщения пользователя — именно они идут в счёт потолка. */
export function passCount(session) {
  const c = session?.cycle;
  if (!c?.passes?.length) return 0;
  const since = c.userPromptAt ? Date.parse(c.userPromptAt) : -Infinity;
  return c.passes.filter((p) => Date.parse(p.startedAt) > since).length;
}

export function startPass(session, now = new Date().toISOString()) {
  const c = cycleOf(session);
  const pass = { n: c.passes.length + 1, startedAt: now, base: 'HEAD' };
  c.passes.push(pass);
  return pass;
}

export function notePrompt(session, now = new Date().toISOString()) {
  cycleOf(session).userPromptAt = now;
}

export function acceptPass(session, { report, now = new Date().toISOString() }) {
  const c = session?.cycle;
  if (!c?.passes?.length) return false;
  const last = c.passes[c.passes.length - 1];
  last.report = report;
  last.acceptedAt = now;
  return true;
}

export function addDecision(session, { text, pass, now = new Date().toISOString() }) {
  cycleOf(session).decisions.push({ at: now, pass, text });
}

/**
 * Чтение-изменение-запись одной сессии под замком состояния. Сессии нет — null без записи:
 * цикл есть только у взведённой сессии, создавать её здесь значило бы взводить гейт мимо хука.
 */
export function updateSession({ root, sessionId, env = process.env, mutate }) {
  const stateDir = join(root, ...stateDirSegments(env));
  const pendingPath = join(stateDir, PENDING);
  if (!existsSync(pendingPath)) return null;
  return withStateLock(stateDir, () => {
    let state;
    try {
      state = JSON.parse(readFileSync(pendingPath, 'utf8'));
    } catch {
      return null;
    }
    const session = state?.sessions?.[sessionId];
    if (!session) return null;
    const result = mutate(session, state);
    writeFileSync(pendingPath, JSON.stringify(state, null, 2), 'utf8');
    return result;
  });
}
