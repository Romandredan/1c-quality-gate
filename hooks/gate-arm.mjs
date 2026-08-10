#!/usr/bin/env node
/**
 * PostToolUse-хук: взводит гейт качества при правке файлов 1С.
 *
 * Гейт взводится ВСЕГДА, когда затронут файл 1С, — хук видит одну правку и не может
 * оценить её масштаб. Градация работает не здесь, а на снятии: прогон класса C0/C1
 * занимает секунды и снимает маркер так же законно, как полный. Тем самым молчаливый
 * пропуск невозможен, но дешёвый честный путь есть.
 *
 * Любая внутренняя ошибка — молча exit 0: хук качества не имеет права ломать работу.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPayload, projectRoot, toProjectRelative } from './_shared.mjs';
import { ensureConfig } from '../tools/config.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const STATE_DIR = ['.claude', '.state'];
const PENDING = 'qg-pending.json';
const DONE = 'qg-done.json';

/**
 * Определяет, файл какого рода затронут.
 * Возвращает null для всего, что не относится к 1С, — в не-1С проектах плагин молчит.
 */
function classifyFile(filePath) {
  const p = filePath.replace(/\\/g, '/');
  const lower = p.toLowerCase();

  if (lower.endsWith('.bsl') || lower.endsWith('.os')) return 'bsl';

  if (lower.endsWith('.xml')) {
    // Configuration.xml — корень выгрузки конфигурации, однозначный маркер 1С.
    if (/(^|\/)configuration\.xml$/.test(lower)) return 'metadata-xml';

    // Каталоги выгрузки: cf (конфигурация) и cfe (расширения), в корне либо внутри src.
    // Одного «src/» НЕДОСТАТОЧНО — это стандартный каталог исходников в Java, .NET,
    // Android и почти везде; плагин обязан молчать в чужих проектах, а не взводить
    // гейт на каждый их XML.
    if (/(^|\/)(cf|cfe)\//.test(lower)) return 'metadata-xml';

    // Выгрузка EDT/конфигуратора внутри src: src/<Имя>/... с типовыми каталогами объектов.
    if (/(^|\/)src\/.*\/(catalogs|documents|informationregisters|accumulationregisters|commonmodules|dataprocessors|reports|enums|chartsofcharacteristictypes|businessprocesses|tasks|exchangeplans|roles|subsystems)\//.test(lower)) {
      return 'metadata-xml';
    }

    return null;
  }

  return null;
}

const HINTS = {
  'bsl': [
    '[1C QUALITY GATE — взведён: BSL]',
    'Файл: %FILE%',
    '',
    'Перед завершением работы прогони Skill: quality-gate.',
    'Он сам определит глубину по трём осям (объём правки, архетипы кода, сложность)',
    'и запустит только нужные контуры. Мелкая правка проверяется за секунды.',
    '',
    'Завершение сессии заблокировано, пока гейт не снят.',
  ],
  'metadata-xml': [
    '[1C QUALITY GATE — взведён: XML метаданных]',
    'Файл: %FILE%',
    '',
    'Перед завершением работы прогони Skill: quality-gate.',
    'Для нового объекта критична проверка регистрации в Configuration.xml:',
    'файл-сирота вне <ChildObjects> не попадает в сборку, при этом конфигуратор',
    'её не диагностирует — ошибка всплывает только в рантайме.',
    '',
    'Завершение сессии заблокировано, пока гейт не снят.',
  ],
};

function main() {
  const payload = readPayload();
  if (!payload) return;

  const filePath = payload?.tool_input?.file_path;
  if (!filePath || typeof filePath !== 'string') return;

  const kind = classifyFile(filePath);
  if (!kind) return;

  const root = projectRoot(payload);
  const stateDir = join(root, ...STATE_DIR);
  const pendingPath = join(stateDir, PENDING);
  const donePath = join(stateDir, DONE);

  // Состояние разделено по сессиям. Один маркер на проект ломается при параллельной
  // работе: сессия, правившая свои файлы, упирается в гейт, взведённый чужой сессией,
  // и либо снимает чужой маркер, либо не может завершиться. Каждая сессия отвечает
  // только за свои правки.
  const sessionId = String(payload?.session_id || 'unknown-session');

  mkdirSync(stateDir, { recursive: true });

  let state = { version: 2, sessions: {} };
  if (existsSync(pendingPath)) {
    try {
      const prev = JSON.parse(readFileSync(pendingPath, 'utf8'));
      if (prev?.sessions) state = prev;
      else if (prev?.files) state.sessions['legacy'] = { armedAt: prev.armedAt, files: prev.files };
    } catch {
      /* повреждённый маркер перезаписываем свежим */
    }
  }

  const now = new Date().toISOString();
  const session = state.sessions[sessionId] || { armedAt: now, files: {} };
  const rel = toProjectRelative(root, filePath);
  const entry = session.files[rel] || { kind, edits: 0 };
  entry.kind = kind;
  entry.edits += 1;
  entry.lastEdit = now;

  // Правка обесценивает все доказательства по этому файлу. Гейт — требование к ТЕКУЩЕМУ
  // состоянию артефакта, а не отметка «инструмент когда-то запускался»: проверки, сделанные
  // до правки, относятся к другому содержимому и переиспользованы быть не могут.
  delete entry.verified;

  session.files[rel] = entry;
  session.updatedAt = now;
  state.sessions[sessionId] = session;

  writeFileSync(pendingPath, JSON.stringify(state, null, 2), 'utf8');

  // Новая правка обесценивает прошлый прогон ЭТОЙ сессии; чужие отметки не трогаем.
  if (existsSync(donePath)) {
    try {
      const done = JSON.parse(readFileSync(donePath, 'utf8'));
      if (done?.sessions) {
        delete done.sessions[sessionId];
        if (Object.keys(done.sessions).length) writeFileSync(donePath, JSON.stringify(done, null, 2), 'utf8');
        else rmSync(donePath, { force: true });
      } else {
        rmSync(donePath, { force: true });
      }
    } catch {
      rmSync(donePath, { force: true });
    }
  }

  // Настройка проекта создаётся здесь и только здесь: это единственное место, где уже
  // известно, что проект на 1С. Заводить её при старте сессии значило бы сорить файлом в
  // чужих проектах, а оставлять на пользователя — прятать настройку в документацию.
  let created = null;
  try {
    const r = ensureConfig(root);
    if (r.created) created = toProjectRelative(root, r.path);
  } catch {
    /* создание настройки не обязано мешать взводу гейта */
  }

  // Вывод обязан быть JSON с hookSpecificOutput: простой текст из PostToolUse до модели
  // НЕ доходит — маркер при этом пишется, и получается гейт, о котором модель узнаёт только
  // при попытке завершить работу. Проверено на живой сессии.
  let hint = HINTS[kind].join('\n').replace('%FILE%', rel);
  // Только на прогоне, который файл создал: сообщение на каждой правке — шум, который
  // перестают читать вместе со всем остальным текстом подсказки.
  if (created) {
    hint +=
      `\n\nСоздан файл настройки проекта: ${created}\n` +
      'В нём пороги осей профиля, движок анализатора, проектные архетипы и номер часового.\n' +
      'Секции пустые — действуют умолчания; описание ключей лежит в самом файле.\n' +
      `Что действует сейчас: node "${PLUGIN_ROOT.replace(/\\/g, '/')}/tools/config.mjs" show`;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: hint,
      },
      systemMessage:
        `Гейт качества 1С взведён: ${rel}` + (created ? ` · создана настройка проекта ${created}` : ''),
    }) + '\n'
  );
}

try {
  main();
} catch {
  /* хук качества никогда не ломает работу пользователя */
}
process.exit(0);
