/**
 * Сопоставление путей проекта с путями из настройки (`tests.paths`).
 *
 * Зачем свой разбор, а не `path.matchesGlob`. Инструменты плагина запускаются тем `node`,
 * что стоит у пользователя, а поддержанный диапазон начинается с 20, где `matchesGlob`
 * экспериментальный. Нужное подмножество масок мало: `*`, `**`, `?` и путь-каталог.
 *
 * Правила — в `docs/CONFIG.md`, раздел `tests`: пути от корня проекта, разделитель `/`,
 * сравнение без учёта регистра, путь без маски — файл или каталог целиком.
 */

const GLOB = /[*?]/;

/** Приводит путь настройки к виду сравнения: прямые слэши, без `./` в начале и `/` в конце. */
export function normalizePattern(pattern) {
  let p = String(pattern).split('\\').join('/').trim();
  while (p.startsWith('./')) p = p.slice(2);
  while (p.endsWith('/') && p.length > 1) p = p.slice(0, -1);
  return p;
}

/** Причина, по которой путь настройки недопустим, либо null. */
function problemOf(pattern) {
  if (typeof pattern !== 'string') return 'не строка';
  const p = normalizePattern(pattern);
  if (!p) return 'пустой путь';
  if (p.startsWith('/') || /^[a-z]:/i.test(p)) return 'абсолютный путь: нужен путь от корня проекта';
  if (p.split('/').includes('..')) return 'сегмент ".." выводит за корень проекта';
  return null;
}

/** Проверка списка целиком: `{ ok, errors }`, где каждая ошибка называет путь и причину. */
export function validatePatterns(patterns) {
  if (!Array.isArray(patterns)) return { ok: false, errors: ['ожидается массив путей'] };
  const errors = [];
  patterns.forEach((p, i) => {
    const why = problemOf(p);
    if (why) errors.push(`[${i}] ${JSON.stringify(p)}: ${why}`);
  });
  return { ok: errors.length === 0, errors };
}

function globToRegExp(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      // `**/` — ноль или больше сегментов целиком; `**` в конце — всё, что ниже.
      if (p[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'iu');
}

/**
 * Покрыт ли путь файла (от корня проекта, через `/`) хотя бы одним путём настройки.
 * Недопустимые пути настройки не участвуют: отказ по ним — дело плана, а не сопоставления.
 */
export function matchesAny(rel, patterns) {
  if (!Array.isArray(patterns) || !patterns.length) return false;
  const path = String(rel).split('\\').join('/');
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) return false;
  const lower = path.toLowerCase();
  for (const raw of patterns) {
    if (problemOf(raw)) continue;
    const p = normalizePattern(raw);
    if (GLOB.test(p)) {
      if (globToRegExp(p).test(path)) return true;
    } else {
      const base = p.toLowerCase();
      if (lower === base || lower.startsWith(base + '/')) return true;
    }
  }
  return false;
}
