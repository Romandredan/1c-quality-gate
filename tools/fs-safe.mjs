/**
 * Надёжное удаление файлов и каталогов — с проверкой, что удаление состоялось.
 *
 * Зачем отдельный модуль. В Node 24.x на Windows `fs.rmSync` МОЛЧА не удаляет файл или
 * каталог, если в пути есть не-ASCII символы (кириллица в имени проекта — обычное дело
 * для 1С): ни исключения, ни удаления (nodejs/node#56049, nodejs/node#61067; исправления
 * в апстриме есть, но до установленных версий доходят не сразу). Для гейта это фатально:
 * `release` рапортовал «гейт снят», `qg-pending.json` оставался на месте — и Stop-хук
 * блокировал завершение навсегда. Ровно тот класс отказа, против которого написан весь
 * плагин: успех, не отличимый от невыполнения.
 *
 * Поэтому здесь два правила:
 *   1) файлы удаляются `unlinkSync` — он не поражён этим дефектом;
 *   2) после любого удаления результат ПРОВЕРЯЕТСЯ (`existsSync`), а для деревьев при
 *      живом остатке выполняется ручной обход `unlinkSync` + `rmdirSync` — оба здоровы
 *      на не-ASCII путях (проверено на Node 24.12.0 win32).
 *
 * Обе функции возвращают `true`, только если пути больше не существует. Вызывающий обязан
 * смотреть на результат там, где от удаления зависит смысл сообщения пользователю.
 */

import { existsSync, unlinkSync, rmSync, rmdirSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Удаляет ФАЙЛ и подтверждает удаление. Отсутствующий файл — успех (удалять нечего).
 */
export function removeFileSync(path) {
  try {
    unlinkSync(path);
  } catch (e) {
    if (e && e.code !== 'ENOENT') return !existsSync(path);
  }
  return !existsSync(path);
}

/** Ручной обход дерева: unlink для файлов, rmdir для опустевших каталогов. */
function removeTreeManual(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return; // уже нет — и хорошо
  }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    for (const entry of readdirSync(path)) removeTreeManual(join(path, entry));
    try {
      rmdirSync(path);
    } catch {
      /* итог проверит вызывающий */
    }
  } else {
    try {
      unlinkSync(path);
    } catch {
      /* итог проверит вызывающий */
    }
  }
}

/**
 * Удаляет дерево (файл или каталог) и подтверждает удаление.
 *
 * Сначала штатный `rmSync` — на здоровых путях он быстрее и переживает ситуации,
 * которые ручной обход не знает. Затем проверка; остаток добирается ручным обходом.
 */
export function removeTreeSync(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* добьём обходом ниже */
  }
  if (existsSync(path)) removeTreeManual(path);
  return !existsSync(path);
}
