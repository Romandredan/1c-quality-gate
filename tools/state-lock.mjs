/**
 * Исключительный замок на файлы состояния гейта (`qg-pending.json`, `qg-done.json`).
 *
 * Зачем. Каждый писатель состояния делает «прочитать — изменить — записать». Хуки взвода,
 * запущенные параллельно (несколько правок в одном ответе модели, команда оболочки рядом
 * с правкой, соседняя сессия в том же проекте), без замка теряют записи друг друга: побеждает
 * последний пишущий, и взвод пропадает молча. Под замок обязан идти каждый писатель —
 * взвод, снятие файла по `tests.paths`, `gate.mjs verify` и `gate.mjs release`.
 *
 * Как. Файл замка создаётся флагом `wx` (только если его нет), внутри — метка владельца;
 * снимает замок только тот, чья метка в нём лежит. Замок старше LOCK_STALE_MS считается
 * брошенным упавшим процессом и снимается. Ожидание дольше срока брошенности: за
 * LOCK_WAIT_MS замок либо освободится, либо станет брошенным.
 *
 * Не взяли и тогда (устойчивая ошибка файловой системы) — работаем без замка: гейт качества
 * не имеет права вешать работу, а отказ от записи потерял бы взвод молча.
 *
 * Остаточная гонка: между чтением метки брошенного замка и его снятием другой процесс может
 * снять его и поставить свой. Окно — микросекунды; без атомарного «снять, если метка та»
 * на файловой системе оно не закрывается.
 *
 * Внутри замка держат только чтение-изменение-запись: долгая работа под ним (проверка следа,
 * запуск инструментов) превысила бы срок брошенности, и замок сняли бы из-под владельца.
 */

import { readFileSync, writeFileSync, openSync, closeSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const STATE_LOCK = 'qg-state.lock';

const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 12000;
const RETRY_MS = 25;

function lockToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function removeIfOwner(lock, token) {
  try {
    if (readFileSync(lock, 'utf8') === token) unlinkSync(lock);
  } catch {
    /* замка уже нет или он чужой */
  }
}

/**
 * Синхронная пауза. `Atomics.wait` в главном потоке разрешён в Node; среда, где он запрещён
 * (плагин OpenCode исполняется внутри чужого процесса), получает короткое активное ожидание.
 */
function pause(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* активное ожидание — только при конкуренции за замок */
    }
  }
}

/**
 * Выполняет fn под замком каталога состояния и возвращает её результат.
 * Каталог обязан существовать: создавать его ради замка значило бы сорить в чужих проектах.
 */
export function withStateLock(stateDir, fn) {
  const lock = join(stateDir, STATE_LOCK);
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = lockToken();
  let held = false;
  while (Date.now() <= deadline) {
    try {
      const fd = openSync(lock, 'wx');
      try {
        writeFileSync(fd, token, 'utf8');
      } finally {
        closeSync(fd);
      }
      held = true;
      break;
    } catch (e) {
      if (e?.code !== 'EEXIST') break;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        removeIfOwner(lock, readFileSync(lock, 'utf8'));
        continue;
      }
    } catch {
      /* замок сняли между попытками — пробуем снова */
    }
    pause(RETRY_MS);
  }
  try {
    return fn();
  } finally {
    if (held) removeIfOwner(lock, token);
  }
}
