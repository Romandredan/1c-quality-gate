/**
 * Разбор поставляемых пакетом команд и субагентов в записи конфигурации OpenCode.
 *
 * Зачем это нужно. Пакет, установленный OpenCode из репозитория, лежит в кэше
 * (`~/.cache/opencode/packages/.../node_modules/1c-quality-gate`), а каталоги
 * `.opencode/commands/` и `.opencode/agents/` сканируются только в проекте и в
 * конфигурационном каталоге пользователя. До кэша сканирование не достаёт, поэтому
 * команды и субагенты регистрируются программно — хуком `config`, который правит живую
 * конфигурацию. Навыкам проще: у них есть `config.skills.paths`, туда достаточно
 * добавить каталог.
 *
 * Разбор намеренно узкий. Это не разборщик YAML, а признание конкретной формы, в которой
 * frontmatter написан в этом репозитории: ключ верхнего уровня, свёрнутый блок `>-` и
 * вложенная карта в один уровень. Всё, что в эту форму не укладывается, возвращает `null`,
 * и запись не регистрируется вовсе — зарегистрировать субагента с потерянным списком
 * инструментов хуже, чем не зарегистрировать его совсем. Тест `opencode-plugin.test.mjs`
 * проверяет, что все поставляемые файлы разбираются, — новая конструкция во frontmatter
 * покраснеет в CI, а не молча выключит субагента у пользователя.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** `true` / `false` — булево, всё остальное — строка как есть. */
function scalar(raw) {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/**
 * Frontmatter между парой строк `---` в начале файла.
 *
 * Возвращает `{ data, body }` либо `null`, если блока нет или встретилась конструкция
 * за пределами признаваемой формы.
 */
export function parseFrontmatter(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;

  const data = {};
  let i = 1;
  while (i < end) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      // Пустая строка и комментарий. Комментарии в frontmatter несут причину выбора —
      // почему субагенту дан именно этот набор инструментов, — и их отбрасывание
      // обрушило бы разбор всего файла.
      i += 1;
      continue;
    }
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    // Строка вне формы «ключ: значение» на верхнем уровне: разбор не признаётся.
    if (!m) return null;

    const key = m[1];
    const rest = m[2].trim();

    if (rest === '>-' || rest === '>' || rest === '|' || rest === '|-') {
      // Свёрнутый или буквальный блок: все последующие строки с отступом.
      const block = [];
      i += 1;
      while (i < end && (lines[i].startsWith('  ') || !lines[i].trim())) {
        block.push(lines[i].replace(/^ {2}/, ''));
        i += 1;
      }
      data[key] = block.join('\n').trim();
      continue;
    }

    if (rest === '') {
      // Вложенная карта в один уровень: `ключ:` и строки с отступом под ним.
      const nested = {};
      i += 1;
      while (i < end && lines[i].startsWith('  ')) {
        const sub = /^ {2}([A-Za-z_][\w-]*):(.*)$/.exec(lines[i]);
        if (!sub) return null;
        nested[sub[1]] = scalar(sub[2]);
        i += 1;
      }
      data[key] = nested;
      continue;
    }

    data[key] = scalar(rest);
    i += 1;
  }

  return { data, body: lines.slice(end + 1).join('\n').trim() };
}

/** Читает `*.md` каталога и отдаёт пары `[имя, разбор]`; неразобранные — пропускает. */
function entries(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    let parsed = null;
    try {
      parsed = parseFrontmatter(readFileSync(join(dir, file), 'utf8'));
    } catch {
      parsed = null;
    }
    if (parsed) out.push([basename(file, '.md'), parsed]);
  }
  return out;
}

/**
 * Команды пакета в форме `config.command`: тело файла становится `template`.
 */
export function commandsFrom(dir) {
  return entries(dir)
    .filter(([, p]) => p.body)
    .map(([name, p]) => {
      const def = { template: p.body };
      for (const k of ['description', 'agent', 'model', 'subtask']) {
        if (p.data[k] !== undefined) def[k] = p.data[k];
      }
      return [name, def];
    });
}

/**
 * Соответствие имён инструментов: слева — как их называет Claude Code в поле `tools`
 * субагента, справа — ключ карты инструментов OpenCode. `ToolSearch` эквивалента не имеет:
 * в OpenCode инструменты MCP доступны по имени сервера, догружать нечего.
 */
const TOOL_NAMES = {
  skill: 'skill',
  read: 'read',
  grep: 'grep',
  glob: 'glob',
  bash: 'bash',
  write: 'write',
  edit: 'edit',
};

/** Карта выдаётся целиком: неупомянутый инструмент в OpenCode остаётся разрешённым. */
const TOOL_KEYS = ['skill', 'read', 'grep', 'glob', 'bash', 'write', 'edit'];

/**
 * Субагенты пакета в форме `config.agent`: тело файла становится `prompt`.
 *
 * Источник один — `agents/` в корне пакета, те же файлы, что читает Claude Code. Второй
 * копии под OpenCode нет намеренно: копии расходятся при первой правке одной из них, и
 * расходятся молча. Frontmatter переводится здесь, потому что схемы у харнессов разные:
 * у Claude Code `tools` — перечисление через запятую, у OpenCode — карта булевых.
 *
 * Ключи, специфичные для Claude Code, не переносятся: `model: haiku` в OpenCode не
 * разрешается (там имя модели идёт с префиксом провайдера), `color: cyan` не проходит
 * проверку формата (ожидается шестнадцатеричный код). Оба ключа тише пропустить, чем
 * отдать конфигурации значение, которого она не поймёт.
 */
export function agentsFrom(dir) {
  return entries(dir)
    .filter(([, p]) => p.body)
    .map(([name, p]) => {
      const granted = new Set(
        String(p.data.tools || '')
          .split(',')
          .map((t) => TOOL_NAMES[t.trim().toLowerCase()])
          .filter(Boolean)
      );
      const tools = {};
      for (const k of TOOL_KEYS) tools[k] = granted.has(k);

      const def = { mode: 'subagent', prompt: p.body, tools };
      if (p.data.description !== undefined) def.description = p.data.description;
      // Право на правку — отдельный контур: карта инструментов и разрешение проверяются
      // независимо, и субагент-читатель обязан быть закрыт в обоих.
      if (!tools.edit && !tools.write) def.permission = { edit: 'deny' };
      return [name, def];
    });
}
