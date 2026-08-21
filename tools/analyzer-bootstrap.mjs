#!/usr/bin/env node
/**
 * Установка статического анализатора в кэш плагина.
 *
 * Зачем не «поставьте сами». Плагин публичный: шаг «скачайте бинарник и пропишите путь»
 * отсекает тех, кто мог бы им пользоваться, а без анализатора контур кода вырождается.
 *
 * Зачем не через лаунчер автора. Распространяемый им `bsl-analyzer.exe` — тонкая обёртка,
 * которая скачивает рабочий бинарник и дальше ОБНОВЛЯЕТ ЕГО САМА. Для гейта это
 * недопустимо: движок, меняющийся между прогонами, делает вердикт невоспроизводимым.
 * Поэтому качаем конкретный релиз сами и сверяем SHA-256 до первого запуска — закрепление
 * версии становится фактом, а не проверкой постфактум.
 *
 * Зеркала нет: файл берётся с релизов автора, ровно как это делает его собственный лаунчер.
 *
 * Использование:
 *   node analyzer-bootstrap.mjs [--force] [--verify]
 */

import { createWriteStream, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, chmodSync, statSync, copyFileSync } from 'node:fs';
import { removeFileSync } from './fs-safe.mjs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = dirname(HERE);
export const MANIFEST_PATH = join(PLUGIN_ROOT, 'assets', 'analyzer', 'runtime-manifest.json');

/** Имя каталога данных совпадает с тем, что заводит хост: `<плагин>-<marketplace>`. */
const DATA_DIR_NAME = '1c-quality-gate-1c-quality-gate';

export function readManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Ключ платформы в манифесте. Неподдержанная связка — не ошибка, а отсутствие бутстрапа. */
export function targetKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/**
 * Каталог данных плагина. Он переживает обновление плагина — в отличие от каталога кэша,
 * где версии плагина лежат порознь и шестидесятимегабайтный бинарник копировался бы заново.
 */
export function dataRoot() {
  return process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'plugins', 'data', DATA_DIR_NAME);
}

export function installDir(manifest, root = dataRoot()) {
  return join(root, 'analyzer', manifest.engine, manifest.version);
}

export function binaryPath(manifest, root = dataRoot()) {
  const name = process.platform === 'win32' ? 'bsl-analyzer-app.exe' : 'bsl-analyzer-app';
  return join(installDir(manifest, root), name);
}

function markerPath(manifest, root) {
  return join(installDir(manifest, root), '.ready');
}

export async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

export function assetUrl(manifest, target) {
  return manifest.urlTemplate
    .replace('{repo}', manifest.repo)
    .replace('{version}', manifest.version)
    .replace('{asset}', target.asset);
}

/**
 * Возвращает путь к установленному бинарнику или null.
 *
 * Быстрая проверка идёт по маркеру, а не по пересчёту хеша: шестьдесят мегабайт считаются
 * заметно дольше, чем длится сам анализ, и платить это на каждом прогоне незачем. Хеш
 * сверяется при установке и по явному `--verify`.
 */
export function installed(manifest, root = dataRoot()) {
  const bin = binaryPath(manifest, root);
  const marker = markerPath(manifest, root);
  if (!existsSync(bin) || !existsSync(marker)) return null;
  try {
    const stated = JSON.parse(readFileSync(marker, 'utf8'));
    if (stated.sha256 !== manifest.targets[targetKey()]?.sha256) return null;
    if (statSync(bin).size !== stated.size) return null;
  } catch {
    return null;
  }
  return bin;
}

export async function verifyInstalled(manifest, root = dataRoot()) {
  const bin = installed(manifest, root);
  if (!bin) {
    // Файл на месте, но состояние установки невалидно — это не «не установлен», а «испорчен
    // или устарел». Разница важна: во втором случае помогает `--force`, в первом обычная
    // установка.
    const reason = existsSync(binaryPath(manifest, root)) ? 'corrupted_or_stale' : 'not_installed';
    return { ok: false, reason };
  }
  const expected = manifest.targets[targetKey()]?.sha256;
  const actual = await sha256(bin);
  return actual === expected ? { ok: true, path: bin } : { ok: false, reason: 'checksum_mismatch', actual, expected };
}

/**
 * Скачивает и устанавливает анализатор. Публикация атомарная: файл переименовывается на
 * место только после сверки суммы, маркер готовности пишется последним. Оборванная загрузка
 * не оставляет каталога, который выглядел бы рабочим.
 */
export async function install(manifest, { root = dataRoot(), force = false, log = () => {} } = {}) {
  const key = targetKey();
  const target = manifest.targets[key];
  if (!target) return { ok: false, reason: 'unsupported_platform', platform: key };

  if (!force) {
    const already = installed(manifest, root);
    if (already) return { ok: true, path: already, downloaded: false };
  }

  const dir = installDir(manifest, root);
  mkdirSync(dir, { recursive: true });
  const finalPath = binaryPath(manifest, root);
  const tmpPath = `${finalPath}.download`;

  const url = assetUrl(manifest, target);
  log(`Скачиваю ${manifest.engine} ${manifest.version} (${(target.size / 1048576).toFixed(0)} МБ) — один раз`);

  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      return { ok: false, reason: 'download_failed', status: response.status };
    }
    removeFileSync(tmpPath);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpPath));
  } catch (e) {
    removeFileSync(tmpPath);
    return { ok: false, reason: 'download_failed', error: String(e.message || e) };
  }

  const actual = await sha256(tmpPath);
  if (actual !== target.sha256) {
    removeFileSync(tmpPath);
    return { ok: false, reason: 'checksum_mismatch', actual, expected: target.sha256 };
  }

  removeFileSync(finalPath);
  renameSync(tmpPath, finalPath);
  if (process.platform !== 'win32') chmodSync(finalPath, 0o755);
  writeMarker(manifest, root, { sha256: actual, size: statSync(finalPath).size, installedFrom: url });
  log(`Готово: ${finalPath}`);
  return { ok: true, path: finalPath, downloaded: true };
}

/**
 * Принимает уже лежащий на диске бинарник как свою установку.
 *
 * Зачем. Установка лаунчера у пользователя нередко держит ровно ту версию, что закреплена
 * манифестом: качать те же 63 МБ заново незачем. Но ССЫЛАТЬСЯ на чужой файл нельзя — лаунчер
 * обновляет его сам, и закрепление протекает при первом же его самообновлении. Поэтому файл
 * копируется под наш контроль.
 *
 * Сумма считается у КОПИИ, а не у источника: между проверкой источника и копированием лаунчер
 * успел бы подменить файл, и проверка доказывала бы что-то о другом байтовом наборе. Порядок
 * тот же, что при скачивании: копия во временный файл, сверка, переименование, маркер
 * последним. В маркер уходит путь источника — по нему потом видно, что установка принята, а
 * не скачана.
 */
export async function adopt(manifest, sourcePath, { root = dataRoot(), log = () => {} } = {}) {
  const key = targetKey();
  const target = manifest.targets[key];
  if (!target) return { ok: false, reason: 'unsupported_platform', platform: key };
  if (!sourcePath || !existsSync(sourcePath)) return { ok: false, reason: 'source_missing' };

  const dir = installDir(manifest, root);
  mkdirSync(dir, { recursive: true });
  const finalPath = binaryPath(manifest, root);
  const tmpPath = `${finalPath}.download`;

  try {
    rmSync(tmpPath, { force: true });
    copyFileSync(sourcePath, tmpPath);
  } catch (e) {
    // На Windows лаунчер может держать свой файл открытым. Это не дефект и не повод падать:
    // вызывающий просто скачает бинарник обычным путём.
    rmSync(tmpPath, { force: true });
    return { ok: false, reason: 'copy_failed', error: String(e.message || e) };
  }

  const actual = await sha256(tmpPath);
  if (actual !== target.sha256) {
    rmSync(tmpPath, { force: true });
    return { ok: false, reason: 'checksum_mismatch', actual, expected: target.sha256 };
  }

  rmSync(finalPath, { force: true });
  renameSync(tmpPath, finalPath);
  if (process.platform !== 'win32') chmodSync(finalPath, 0o755);
  writeMarker(manifest, root, { sha256: actual, size: statSync(finalPath).size, installedFrom: sourcePath });
  log(`Принята существующая установка ${manifest.version}: ${sourcePath}`);
  return { ok: true, path: finalPath, adopted: true };
}

/** Маркер готовности пишется последним и только после сверки суммы. */
function writeMarker(manifest, root, data) {
  writeFileSync(markerPath(manifest, root), JSON.stringify({ version: manifest.version, ...data }, null, 2), 'utf8');
}

async function main(argv) {
  const args = argv.slice(2);
  const manifest = readManifest();
  const out = (s) => process.stdout.write(s + '\n');

  if (args.includes('--verify')) {
    const r = await verifyInstalled(manifest);
    out(r.ok ? `Проверено: ${r.path}` : `Не проверено: ${r.reason}`);
    return r.ok ? 0 : 2;
  }

  const r = await install(manifest, { force: args.includes('--force'), log: out });
  if (!r.ok) {
    process.stderr.write(`Установка не удалась: ${r.reason}${r.status ? ' (HTTP ' + r.status + ')' : ''}\n`);
    if (r.reason === 'unsupported_platform') {
      process.stderr.write(
        `Для ${r.platform} автор бинарников не публикует. Поставьте анализатор вручную и укажите ` +
          'analyzer.binary в .1c-quality-gate.json, либо переключитесь на движок bsl-ls.\n'
      );
    }
    return 2;
  }
  if (!r.downloaded) out(`Уже установлен: ${r.path}`);
  return 0;
}

if (process.argv[1]?.endsWith('analyzer-bootstrap.mjs')) {
  main(process.argv).then((code) => process.exit(code));
}
