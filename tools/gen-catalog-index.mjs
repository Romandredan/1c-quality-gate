#!/usr/bin/env node
/**
 * Индекс триггеров каталога антипаттернов — производный файл из карточек.
 *
 * Зачем: для обнаружения нужны только триггеры (2–4 строки на признак), разбор нужен
 * только при попадании. Два прежних справочника грузили в контекст 131 КБ при каждом
 * прогоне, из них триггеров — меньше десятой части. Индекс генерируется, потому что
 * вручную поддерживаемая копия расходится с карточками при первой правке.
 *
 * Использование:
 *   node tools/gen-catalog-index.mjs            # перезаписать INDEX.md
 *   node tools/gen-catalog-index.mjs --check    # выйти с кодом 1, если INDEX.md устарел
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const CATALOG_DIR = join(here, '..', 'skills', 'bsl-code-review', 'references', 'catalog');
export const INDEX_FILE = join(CATALOG_DIR, 'INDEX.md');

const SEVERITY_MARK = { critical: '🔴', major: '🟠', minor: '🟡' };

/** Frontmatter карточки: плоские скаляры и списки в квадратных скобках. */
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error('нет frontmatter');
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const v = raw.trim();
    if (v === 'null') data[key] = null;
    else if (v.startsWith('[')) data[key] = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    else data[key] = v;
  }
  return { data, body: text.slice(m[0].length) };
}

/** Текст секции «## Триггер» до следующего H2, схлопнутый в один абзац. */
function triggerOf(body) {
  const m = body.match(/^## Триггер\n([\s\S]*?)(?=^## )/m);
  return (m ? m[1] : '').trim().replace(/\s*\n\s*/g, ' ');
}

export function readCatalog(dir = CATALOG_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
    .sort()
    .map((f) => {
      const file = join(dir, f);
      const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));
      for (const k of ['id', 'title', 'severity', 'group', 'archetypes']) {
        if (data[k] === undefined) throw new Error(`${f}: в frontmatter нет поля ${k}`);
      }
      return {
        id: data.id,
        title: data.title,
        severity: data.severity,
        group: data.group,
        tool: data.tool ?? null,
        archetypes: data.archetypes,
        std: data.std || [],
        // Чем карточку нельзя проверить по одному лишь коду. Сейчас единственное известное
        // значение — `diff`: триггер виден только при сравнении версий (что исчезло), а не
        // в теле метода как он есть сейчас. Список, а не флаг — открыт для будущих причин.
        needs: data.needs || [],
        trigger: triggerOf(body),
        file,
      };
    });
}

export function renderIndex(cards) {
  const head = [
    '# Индекс триггеров каталога антипаттернов',
    '',
    'Производный файл — источник истины карточки `catalog/<ID>.md`. Правки вносить в карточки,',
    'индекс перегенерировать: `node tools/gen-catalog-index.mjs`.',
    '',
    'Здесь только то, что нужно для обнаружения: идентификатор, важность и триггер. Разбор,',
    'способ исправления и законные формы — в карточке; она читается по попаданию, а не заранее.',
    'Карточки с инструментом перечислены ради «как чинить»: их находки печатает инструмент,',
    'своих находок этого класса не добавляй. `*` — нужен `git diff`.',
    '',
    'Уроки об устройстве программы ведёт `bsl-architecture-review`: доверие результату своей',
    'функции, одна граница проверки, общий механизм вместо копии на каждый вариант входа,',
    'подготовка данных отдельным методом, поле под будущий признак, конструктор внешней',
    'структуры. Регистрацию объекта в составе конфигурации — `xml-structure-review`. Здесь их',
    'не отмечай.',
    '',
    '| Признак | Важность | Группа | Архетипы | Инструмент | Триггер |',
    '|---|---|---|---|---|---|',
  ];
  const rows = cards.map((c) =>
    `| \`${c.id}\`${c.needs.includes('diff') ? '*' : ''} | ${SEVERITY_MARK[c.severity] || c.severity} | ${c.group} | ${c.archetypes.join(', ')} | ${c.tool ? `\`${c.tool.replace(/^tools\//, '')}\`` : 'чтение'} | ${c.trigger.replace(/\|/g, '\\|')} |`
  );
  return [...head, ...rows, ''].join('\n');
}

function main(argv) {
  const cards = readCatalog();
  const md = renderIndex(cards);
  if (argv.includes('--check')) {
    const current = existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, 'utf8') : '';
    if (current !== md) {
      process.stderr.write('INDEX.md устарел, перегенерируй: node tools/gen-catalog-index.mjs\n');
      return 1;
    }
    return 0;
  }
  writeFileSync(INDEX_FILE, md, 'utf8');
  process.stdout.write(`Записано карточек: ${cards.length} → ${INDEX_FILE}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
