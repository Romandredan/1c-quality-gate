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
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
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

export function startPass(session, now = new Date().toISOString(), extra = {}) {
  const c = cycleOf(session);
  const { label, ...rest } = extra;
  const pass = { n: c.passes.length + 1, startedAt: now, base: label ?? 'HEAD', ...rest };
  c.passes.push(pass);
  return pass;
}

/**
 * Снимок файлов сессии на старте прохода: blob каждого файла, записанный в хранилище объектов
 * (`hash-object -w`), — по нему следующий проход считает разницу. Недостижимый blob живёт до
 * сборки мусора; пропажу ловит `resolveBases`, и проход становится полным, а не падает.
 */
export function snapshotBlobs(root, files) {
  const out = {};
  for (const rel of files) {
    const r = spawnSync('git', ['hash-object', '-w', rel], { cwd: root, encoding: 'utf8' });
    const sha = String(r.stdout || '').trim();
    out[rel] = !r.error && r.status === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  }
  return out;
}

export function blobExists(root, sha) {
  if (!sha) return false;
  const r = spawnSync('git', ['cat-file', '-e', sha], { cwd: root, encoding: 'utf8' });
  return !r.error && r.status === 0;
}

/**
 * База каждого файла: blob, проверенный последним принятым проходом (`checked`), либо HEAD.
 * Отметку ставит валидатор при приёмке отчёта, поэтому файл, добавленный после прохода или
 * изменённый во время него, идёт от HEAD либо от своей прежней отметки — проверенное раньше
 * не теряется, непроверенное не выдаётся за проверенное. Файл вне корня или без git идёт от
 * HEAD всегда (`no_git`): сравнивать не с чем, как и в `profile.mjs`.
 */
export function resolveBases({ session, blobs, root }) {
  const bases = {};
  const notes = {};
  const lastPass = session?.cycle?.passes?.at?.(-1) || null;
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  const gitOk = !git.error && git.status === 0;
  let maxPass = 0;
  for (const [rel, cur] of Object.entries(blobs)) {
    const checked = session?.files?.[rel]?.checked;
    if (!gitOk || isAbsolute(rel) || rel.startsWith('..')) {
      bases[rel] = 'HEAD';
      notes[rel] = 'no_git';
      continue;
    }
    if (cur === null) {
      bases[rel] = 'HEAD';
      notes[rel] = existsSync(join(root, rel)) ? 'no_git' : 'deleted';
      continue;
    }
    if (!checked?.blob) {
      bases[rel] = 'HEAD';
      if (lastPass?.blobs?.[rel] && lastPass.blobs[rel] === cur) notes[rel] = `unchanged:${lastPass.n}`;
      continue;
    }
    if (!blobExists(root, checked.blob)) {
      bases[rel] = 'HEAD';
      notes[rel] = 'base_missing';
      continue;
    }
    bases[rel] = { pass: checked.pass, blob: checked.blob };
    if (checked.blob === cur) notes[rel] = `unchanged:${checked.pass}`;
    if (checked.pass > maxPass) maxPass = checked.pass;
  }
  return { bases, notes, label: maxPass ? `pass:${maxPass}` : 'HEAD' };
}

/** Последний принятый проход с номером меньше `before` — источник прошлого отчёта. */
export function lastAcceptedReport(session, { before = Infinity } = {}) {
  const passes = session?.cycle?.passes || [];
  for (let i = passes.length - 1; i >= 0; i--) {
    const p = passes[i];
    if (p.n < before && p.report && p.acceptedAt) return { n: p.n, report: p.report };
  }
  return null;
}

/**
 * Отметка «проверено» по снимку принятого прохода. Файл, чей blob разошёлся со снимком,
 * менялся во время прохода: отчёт его текущее содержимое не видел, отметки нет.
 */
export function markChecked(session, currentBlobs) {
  const out = { checked: [], changed: [] };
  const pass = session?.cycle?.passes?.at?.(-1);
  if (!pass?.blobs) return out;
  for (const [rel, blob] of Object.entries(pass.blobs)) {
    const entry = session.files?.[rel];
    if (!entry || pass.notes?.[rel] === 'no_git') continue;
    if (blob && currentBlobs[rel] === blob) {
      entry.checked = { blob, pass: pass.n };
      out.checked.push(rel);
    } else {
      out.changed.push(rel);
    }
  }
  return out;
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
