#!/usr/bin/env node
/**
 * Самозаведение контура платформенного API: сервер справки ставится и поднимается плагином.
 *
 * Зачем. Контур, который надо настраивать руками, для большинства не существует: он молчит
 * записью пропуска, и это неотличимо от «замечаний нет» для того, кто не читал INSTALL.md.
 * Анализатор в это положение не попадает — его ставит `analyzer-bootstrap.mjs`, и шаг
 * «скачайте бинарник и пропишите путь» там уже признан отсекающим тех, кто мог бы
 * пользоваться. Здесь та же схема: закреплённый релиз, сверка SHA-256 до запуска, каталог
 * данных плагина.
 *
 * Чего у анализатора не было и что пришлось добавить.
 *
 * 1. Сервер справки — не одноразовый CLI, а демон: у бинарника один флаг `--config`, разговор
 *    идёт по HTTP. Значит плагин обязан его поднимать, переиспользовать между прогонами и
 *    уметь отличать свой процесс от чужого.
 * 2. Каталог платформы сервер сам НЕ ищет и версию не выбирает — это его осознанное решение:
 *    состав системных перечислений и сигнатуры между релизами платформы отличаются. Значит
 *    искать установленную 1С и писать `platform_path` должен плагин, а проект — вправе
 *    закрепить версию (`platformContext.platformVersion`).
 * 3. Релиз приезжает архивом, а не голым бинарником, — нужна распаковка средствами системы.
 *
 * Использование:
 *   node tools/platform-context-bootstrap.mjs           # поставить и поднять
 *   node tools/platform-context-bootstrap.mjs --status   # что известно про сервер
 *   node tools/platform-context-bootstrap.mjs --stop     # погасить свой демон
 *   node tools/platform-context-bootstrap.mjs --platforms # какие версии платформы видны
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { removeFileSync, removeTreeSync } from './fs-safe.mjs';
import { dataRoot } from './analyzer-bootstrap.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = dirname(HERE);
export const MANIFEST_PATH = join(PLUGIN_ROOT, 'assets', 'platform-context', 'runtime-manifest.json');

/** Порт из примера конфигурации самого сервера: с него и начинаем искать уже поднятый. */
export const DEFAULT_PORT = 8007;

export function readManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Ключ платформы в манифесте. Неподдержанная связка — не ошибка, а отсутствие бутстрапа. */
export function targetKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/**
 * Каталог установки. Версия в пути — чтобы смена закрепления не портила рабочую установку:
 * старая остаётся на месте, пока новая скачивается и проверяется.
 */
export function installDir(manifest, root = dataRoot()) {
  return join(root, 'platform-context', manifest.version);
}

export function binaryPath(manifest, root = dataRoot(), platform = process.platform) {
  const name = platform === 'win32' ? `${manifest.binary}.exe` : manifest.binary;
  return join(installDir(manifest, root), name);
}

/** Рабочие файлы демона (конфиг, состояние, логи) переживают смену версии сервера. */
export function runtimeDir(root = dataRoot()) {
  return join(root, 'platform-context', 'runtime');
}

/**
 * Конфиг именуется портом, а не один на каталог: демонов бывает несколько — по одному на
 * версию платформы. С общим файлом второй запуск переписывал бы конфиг первого, и запись в
 * реестре описывала бы уже чужой сервер (чужой порт, чужой каталог платформы).
 */
export function configPath(root = dataRoot(), port = null) {
  return join(runtimeDir(root), port ? `config-${port}.toml` : 'config.toml');
}

export function statePath(root = dataRoot()) {
  return join(runtimeDir(root), 'server.json');
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
 * Установлен ли сервер. Проверка по маркеру, а не по пересчёту суммы: сумма считается при
 * установке и по явному `--verify`, на каждом прогоне платить за неё незачем.
 */
export function installed(manifest, root = dataRoot()) {
  const bin = binaryPath(manifest, root);
  const marker = markerPath(manifest, root);
  if (!existsSync(bin) || !existsSync(marker)) return null;
  try {
    const stated = JSON.parse(readFileSync(marker, 'utf8'));
    if (stated.sha256 !== manifest.targets[targetKey()]?.sha256) return null;
  } catch {
    return null;
  }
  return bin;
}

/**
 * Команда распаковки. Отдельная чистая функция, потому что выбор здесь неочевиден и его
 * надо проверять тестом на всех трёх системах, а не на той, где идёт разработка.
 *
 * Windows: `tar` из System32 — это bsdtar, он читает zip. Тот `tar`, что приходит с Git for
 * Windows, — GNU, и на zip отвечает «This does not look like a tar archive». Поэтому путь к
 * системному берётся явно, а не по PATH: в PATH у разработчика первым стоит как раз GNU.
 */
export function extractCommands(archivePath, destDir, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    return [
      { cmd: join(systemRoot, 'System32', 'tar.exe'), args: ['-xf', archivePath, '-C', destDir] },
      // Запасной путь для сборок Windows без bsdtar: PowerShell есть везде, где есть плагин.
      {
        cmd: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
        ],
      },
    ];
  }
  return [{ cmd: 'tar', args: ['-xzf', archivePath, '-C', destDir] }];
}

export function extractArchive(archivePath, destDir, { platform = process.platform, env = process.env, runImpl = spawnSync } = {}) {
  mkdirSync(destDir, { recursive: true });
  const attempts = extractCommands(archivePath, destDir, platform, env);
  const errors = [];
  for (const { cmd, args } of attempts) {
    const r = runImpl(cmd, args, { encoding: 'utf8' });
    if (r && !r.error && r.status === 0) return { ok: true, via: cmd };
    errors.push(`${cmd}: ${r?.error?.message || `код ${r?.status}`}`);
  }
  return { ok: false, reason: 'extract_failed', errors };
}

/**
 * Скачивает, проверяет и распаковывает сервер.
 *
 * Порядок тот же, что у анализатора: временный файл, сверка суммы, только потом публикация и
 * маркер последним. Оборванная загрузка не оставляет каталога, который выглядел бы рабочим.
 */
export async function install(manifest, { root = dataRoot(), force = false, log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const key = targetKey();
  const target = manifest.targets[key];
  if (!target) return { ok: false, reason: 'unsupported_platform', platform: key };

  if (!force) {
    const already = installed(manifest, root);
    if (already) return { ok: true, path: already, downloaded: false };
  }

  const dir = installDir(manifest, root);
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, target.asset);
  const unpack = join(dir, '.unpack');
  const url = assetUrl(manifest, target);

  log(`Скачиваю ${manifest.engine} ${manifest.version} (${(target.size / 1048576).toFixed(0)} МБ) — один раз`);
  try {
    const response = await fetchImpl(url, { redirect: 'follow' });
    if (!response.ok || !response.body) return { ok: false, reason: 'download_failed', status: response.status };
    removeFileSync(archive);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  } catch (e) {
    removeFileSync(archive);
    return { ok: false, reason: 'download_failed', error: String(e.message || e) };
  }

  const actual = await sha256(archive);
  if (actual !== target.sha256) {
    removeFileSync(archive);
    return { ok: false, reason: 'checksum_mismatch', actual, expected: target.sha256 };
  }

  removeTreeSync(unpack);
  const ex = extractArchive(archive, unpack);
  if (!ex.ok) {
    removeFileSync(archive);
    return ex;
  }

  const name = process.platform === 'win32' ? `${manifest.binary}.exe` : manifest.binary;
  const inner = join(unpack, target.dir, name);
  const source = existsSync(inner) ? inner : join(unpack, name);
  if (!existsSync(source)) {
    removeTreeSync(unpack);
    removeFileSync(archive);
    return { ok: false, reason: 'binary_missing', expected: inner };
  }

  const finalPath = binaryPath(manifest, root);
  if (!removeFileSync(finalPath)) {
    removeTreeSync(unpack);
    return { ok: false, reason: 'stale_target', path: finalPath };
  }
  renameSync(source, finalPath);
  if (process.platform !== 'win32') chmodSync(finalPath, 0o755);
  removeTreeSync(unpack);
  removeFileSync(archive);
  writeFileSync(
    markerPath(manifest, root),
    JSON.stringify({ version: manifest.version, sha256: actual, size: statSync(finalPath).size, installedFrom: url }, null, 2),
    'utf8'
  );
  log(`Готово: ${finalPath}`);
  return { ok: true, path: finalPath, downloaded: true };
}

/** Каталоги, где 1С раскладывает версии платформы. Список открытый: `platformPath` перекрывает. */
export function platformRoots(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const pf = env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [join(pf, '1cv8'), join(pf86, '1cv8')];
  }
  if (platform === 'darwin') return ['/opt/1cv8/x86_64', '/Applications/1cv8'];
  return ['/opt/1cv8/x86_64', '/opt/1C/v8.3/x86_64', '/opt/1cv8'];
}

const VERSION_DIR = /^\d+\.\d+\.\d+\.\d+$/;
/** Файл справки, ради которого всё и затевается: без него каталог платформы серверу бесполезен. */
export const HELP_FILE = 'shcntx_ru.hbk';

/**
 * Ищет установленные версии платформы.
 *
 * Признак — не имя каталога, а наличие `shcntx_ru.hbk`: клиентская установка без справки
 * серверу не годится, и молча отдать её значило бы поднять сервер, который на любой вопрос
 * отвечает «индекс не загружен». Сервер ищет файл в самом каталоге и в `bin`, поэтому и мы
 * смотрим оба места.
 */
export function discoverPlatforms({
  platform = process.platform,
  env = process.env,
  roots = null,
  list = (dir) => readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name),
  exists = existsSync,
} = {}) {
  const found = [];
  for (const root of roots || platformRoots(platform, env)) {
    let names;
    try {
      names = list(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!VERSION_DIR.test(name)) continue;
      const dir = join(root, name);
      if (exists(join(dir, HELP_FILE)) || exists(join(dir, 'bin', HELP_FILE))) {
        found.push({ version: name, path: dir });
      }
    }
  }
  return found.sort((a, b) => compareVersions(b.version, a.version));
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Годится ли версия платформы под закрепление проекта.
 *
 * Один компаратор на все три места, где задаётся этот вопрос: выбор каталога 1С, пригодность
 * найденного сервера и сверка версии в прогоне. Порознь они разъезжаются — закрепление по ветке
 * (`8.3.27`) выбирало каталог 8.3.27.1688, поднимало по нему демон и тут же отвергало его как
 * чужую версию, уже заплатив за установку и запуск.
 *
 * Закрепление без номера сборки — не послабление, а обычная форма требования: внутри ветки
 * состав перечислений и сигнатуры совместимы, а требовать четвёртое число значит ломать
 * закрепление при каждом обновлении платформы.
 */
export function platformSatisfies(wanted, actual) {
  if (!wanted || !actual) return true;
  return actual === wanted || actual.startsWith(`${wanted}.`);
}

/**
 * Выбор версии платформы.
 *
 * Закреплённая версия проекта — точное совпадение либо префикс (`8.3.27` подходит к
 * `8.3.27.1688`): проекты закрепляют версию с разной точностью, а требовать сборку до
 * четвёртого числа значит ломать закрепление при каждом обновлении платформы.
 * Не нашлось — не берём старшую молча: это была бы проверка чужой справкой, ровно тот
 * тихий обман, против которого заведено `platformVersion`.
 */
export function choosePlatform(list, wanted = null) {
  if (!list?.length) return null;
  if (!wanted) return list[0];
  const fit = list.filter((p) => platformSatisfies(wanted, p.version));
  return fit.length ? fit.sort((a, b) => compareVersions(b.version, a.version))[0] : null;
}

/** Литерал TOML: путь Windows полон обратных слэшей, и одинарные кавычки избавляют от экранирования. */
function tomlLiteral(value) {
  const s = String(value);
  return s.includes("'") ? JSON.stringify(s) : `'${s}'`;
}

/**
 * Конфигурация сервера. Секции источников имён конфигурации здесь НЕТ намеренно: они требуют
 * параметр `repo` в каждом запросе, а плагину нужна именно платформа — имена конфигурации
 * закрывает анализатор. Свой сервер без источников отвечает и без `repo`.
 */
export function renderConfigToml({ host = '127.0.0.1', port = DEFAULT_PORT, platformPath, logDir, level = 2 }) {
  return [
    '# Создан плагином 1c-quality-gate (tools/platform-context-bootstrap.mjs). Правки будут',
    '# перезаписаны: свой сервер настраивайте отдельно и укажите его адрес в platformContext.url.',
    `host = "${host}"`,
    `port = ${port}`,
    `platform_path = ${tomlLiteral(platformPath)}`,
    `log_dir = ${tomlLiteral(logDir)}`,
    'log_level = "info"',
    `default_validation_level = ${level}`,
    '',
  ].join('\n');
}

/** Пишет конфиг, только когда содержимое изменилось: лишняя запись — лишний повод перезапустить демон. */
export function ensureConfigFile({ root = dataRoot(), host, port, platformPath, level }) {
  const dir = runtimeDir(root);
  const logDir = join(dir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const path = configPath(root, port);
  const text = renderConfigToml({ host, port, platformPath, logDir, level });
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (before === text) return { path, changed: false };
  writeFileSync(path, text, 'utf8');
  return { path, changed: true };
}

/**
 * Поднятые нами демоны — по одному на версию платформы, а не один на машину.
 *
 * Ключ по версии, потому что один сервер отдаёт справку ОДНОЙ версии, а проектов на машине
 * бывает несколько. С единственной записью два проекта на разных версиях вытесняли бы демон
 * друг друга: каждый прогон отвергал бы чужую версию, поднимал свой и терял из виду
 * предыдущий — тот оставался бы жить процессом, за которым уже никто не следит.
 */
export function readServers(root = dataRoot()) {
  try {
    const raw = JSON.parse(readFileSync(statePath(root), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.values(raw) : [];
  } catch {
    return [];
  }
}

export function saveServer(root, state) {
  mkdirSync(runtimeDir(root), { recursive: true });
  let all = {};
  try {
    const raw = JSON.parse(readFileSync(statePath(root), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) all = raw;
  } catch {
    all = {};
  }
  all[state.platform || 'unknown'] = state;
  writeFileSync(statePath(root), JSON.stringify(all, null, 2), 'utf8');
}

export function clearState(root = dataRoot()) {
  removeFileSync(statePath(root));
}

export function urlForPort(port, host = '127.0.0.1') {
  return `http://${host}:${port}/mcp`;
}

export function healthUrl(url) {
  return String(url || '').replace(/\/mcp\/?$/, '/health');
}

/**
 * Опрос `/health`. Возвращает тело целиком: кроме версии оттуда нужны каталог платформы (по
 * нему видно, чью справку сервер отдаёт) и список источников имён конфигурации (по нему
 * видно, потребует ли сервер параметр `repo`).
 */
export async function probeHealth({ url, timeoutMs = 3000, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // `Connection: close` по той же причине, что и в запросах движка: инструмент одноразовый,
    // сокет keep-alive пережил бы работу и мешал выходу процесса.
    const res = await fetchImpl(healthUrl(url), { signal: controller.signal, headers: { Connection: 'close' } });
    if (!res.ok) return null;
    return JSON.parse(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Версия платформы из ответа `/health`: в следе нужен номер, а не путь установки конкретной машины. */
export function platformOf(health) {
  const versions = String(health?.platform_path || '').match(/\d+\.\d+\.\d+\.\d+/g);
  return versions?.[versions.length - 1] || null;
}

/** Алиасы конфигураций сервера. Есть хоть один — сервер потребует `repo` в каждом запросе. */
export function sourcesOf(health) {
  const s = health?.symbol_sources;
  return s && typeof s === 'object' ? Object.keys(s) : [];
}

export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** Первый свободный порт начиная с предпочтительного. Диапазон узкий: занято всё — это диагноз. */
export async function pickPort(preferred = DEFAULT_PORT, { host = '127.0.0.1', probe = isPortFree, span = 20 } = {}) {
  for (let p = preferred; p < preferred + span; p++) {
    if (await probe(p, host)) return p;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Поднимает свой демон и ждёт, пока справка платформы разберётся.
 *
 * Ждём именно `index_loaded`, а не ответа `/health`: сервер отвечает раньше, чем читает
 * `hbk`, и запросы в этом окне возвращаются пустыми — то есть «замечаний нет» на непрочитанной
 * справке. Ровно тот ложный зелёный вердикт, ради которого движок и написан.
 */
export async function startServer({
  manifest,
  root = dataRoot(),
  binary,
  configFile,
  port,
  host = '127.0.0.1',
  waitMs = 90000,
  stepMs = 500,
  log = () => {},
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
} = {}) {
  const bin = binary || binaryPath(manifest, root);
  if (!existsSync(bin)) return { ok: false, reason: 'not_installed' };
  const url = urlForPort(port, host);
  let child;
  try {
    child = spawnImpl(bin, ['--config', configFile], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
  } catch (e) {
    return { ok: false, reason: 'spawn_failed', error: String(e.message || e) };
  }
  log(`Поднимаю сервер справки платформы на ${url}`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const health = await probeHealth({ url, timeoutMs: 2000, fetchImpl });
    if (health?.index_loaded) {
      // Порт мог занять чужой процесс, пока мы запускались: наш тогда упал на bind, а отвечает
      // не он. Записать его pid в состояние нельзя — при остановке этот номер уже принадлежал
      // бы другой программе, и «уборка за собой» убила бы постороннее. Сервер при этом рабочий,
      // поэтому прогон продолжается — просто как с чужим.
      if (child.exitCode !== null || child.signalCode !== null) {
        return { ok: true, url, health, own: false, adopted: true };
      }
      const state = {
        pid: child.pid,
        port,
        url,
        host,
        version: health.version || manifest.version,
        platform: platformOf(health),
        configFile,
        startedAt: new Date().toISOString(),
      };
      saveServer(root, state);
      return { ok: true, url, health, state };
    }
    await sleep(stepMs);
  }
  return { ok: false, reason: 'start_timeout', url, pid: child.pid };
}

/**
 * Гасит демон, поднятый плагином. Чужой сервер не трогаем никогда: адрес мог быть общим на
 * машину, и остановить его значило бы сломать работу соседа ради своей уборки.
 */
export async function stopServer({ root = dataRoot(), killImpl = process.kill, probe = probeHealth, fetchImpl = globalThis.fetch } = {}) {
  const servers = readServers(root).filter((s) => s?.pid);
  if (!servers.length) return { ok: false, reason: 'not_started_by_us' };
  const stopped = [];
  const stale = [];
  const failed = [];
  for (const s of servers) {
    // Номер процесса система переиспользует: после перезагрузки записанный pid принадлежит
    // постороннему, и «уборка за собой» убила бы чужую программу. Гасим только тогда, когда по
    // записанному адресу отвечает именно тот сервер, который мы туда ставили.
    const health = await probe({ url: s.url, timeoutMs: 2000, fetchImpl });
    const same =
      health &&
      (!s.version || !health.version || health.version === s.version) &&
      (!s.platform || platformOf(health) === s.platform);
    if (!same) {
      stale.push(s.pid);
      continue;
    }
    try {
      killImpl(s.pid);
      stopped.push(s.pid);
    } catch (e) {
      failed.push({ pid: s.pid, error: String(e.message || e) });
    }
  }
  clearState(root);
  if (failed.length && !stopped.length) return { ok: false, reason: 'kill_failed', failed, stale };
  return { ok: true, stopped, stale, failed };
}

/**
 * Годится ли найденный сервер для этого проекта.
 *
 * Проверяется не «жив ли», а «ту ли справку отдаёт»: чужой сервер на общем порту может быть
 * поднят под другую версию платформы, и проверка его справкой даёт находки, которых в коде
 * нет. Незагруженный индекс отвергается по той же причине, что и в ожидании старта.
 */
export function healthSuitable(health, { platformVersion = null, repo = null } = {}) {
  if (!health) return { ok: false, reason: 'unreachable' };
  if (health.index_loaded === false) return { ok: false, reason: 'index_not_loaded' };
  const platform = platformOf(health);
  if (platformVersion && platform && !platformSatisfies(platformVersion, platform)) {
    return { ok: false, reason: 'platform_version_mismatch', platform };
  }
  // Сервер с настроенными источниками имён отвергает запрос без алиаса, а отказ приходит
  // успешным ответом — то есть выглядит как «замечаний нет» по каждому файлу. Алиас чужого
  // проекта не подставляем: это имена другой конфигурации.
  const sources = sourcesOf(health);
  if (sources.length && !repo) return { ok: false, reason: 'repo_required', sources, platform };
  return { ok: true, platform };
}

/**
 * Довести контур до рабочего состояния и вернуть адрес.
 *
 * Порядок проб — от самого дешёвого к самому дорогому, и он же порядок уважения к чужой
 * настройке: явный адрес проекта, наш прошлый демон, общий порт по умолчанию, и только потом
 * установка и запуск своего.
 *
 * Непригодный сервер на общем порту не отменяет заведения, а лишь исключает себя. Случай не
 * выдуманный: на машине с несколькими проектами общий сервер обычно настроен на ЧУЖИЕ
 * конфигурации и без алиаса отвечает отказом. Подставить чужой алиас нельзя, а сдаться значит
 * оставить контур невыполненным там, где он выполним, — поэтому поднимается свой, без
 * источников имён, которому алиас не нужен.
 */
export async function ensureServer(
  cfg,
  { root = dataRoot(), manifest = readManifest(), log = () => {}, fetchImpl = globalThis.fetch, spawnImpl = spawn, discover = discoverPlatforms, installImpl = install, startImpl = startServer, portImpl = pickPort } = {}
) {
  const wanted = cfg?.platformVersion || null;

  const tryUrl = async (url, own) => {
    if (!url) return null;
    const health = await probeHealth({ url, fetchImpl });
    const fit = healthSuitable(health, { platformVersion: wanted, repo: cfg?.repo });
    return fit.ok
      ? { ok: true, url, health, own }
      : { ok: false, url, health, reason: fit.reason, platform: fit.platform, sources: fit.sources };
  };

  // Явный адрес — решение проекта: не подходит, так и скажем, подменять его своим демоном нельзя.
  if (cfg?.url) {
    const r = await tryUrl(cfg.url, false);
    return r.ok
      ? r
      : {
          ok: false,
          reason: r.reason === 'unreachable' ? 'server_unreachable' : r.reason,
          url: cfg.url,
          platform: r.platform,
          sources: r.sources,
        };
  }

  // Свои демоны перебираются все: на машине с несколькими версиями платформы годится тот,
  // чья справка совпадает с закреплением проекта, а не тот, что поднят последним.
  for (const s of readServers(root)) {
    const mine = await tryUrl(s?.url, true);
    if (mine?.ok) return mine;
  }

  const shared = await tryUrl(urlForPort(DEFAULT_PORT), false);
  if (shared?.ok) return shared;

  if (cfg?.autoStart === false) return { ok: false, reason: 'server_absent' };

  // Явно указанный каталог платформы — тоже решение проекта: поиск по машине его не отменяет
  // и не перепроверяет. Единственное, что проверяется, — лежит ли там справка: пустой каталог
  // поднял бы сервер, который на любой вопрос отвечает «индекс не загружен».
  if (cfg?.platformPath) {
    const dir = cfg.platformPath;
    const hasHelp = existsSync(join(dir, HELP_FILE)) || existsSync(join(dir, 'bin', HELP_FILE));
    if (!hasHelp) return { ok: false, reason: 'platform_path_invalid', path: dir };
  }

  const platforms = cfg?.platformPath
    ? [{ version: wanted || '', path: cfg.platformPath }]
    : discover();
  const chosen = cfg?.platformPath ? platforms[0] : choosePlatform(platforms, wanted);
  if (!chosen) {
    return {
      ok: false,
      reason: platforms.length ? 'platform_version_absent' : 'no_platform_install',
      available: platforms.map((p) => p.version),
    };
  }

  let bin = installed(manifest, root);
  if (!bin) {
    if (cfg?.autoInstall === false) return { ok: false, reason: 'not_installed' };
    const r = await installImpl(manifest, { root, log, fetchImpl });
    if (!r.ok) return { ok: false, reason: r.reason, detail: r.status || r.error || r.actual };
    bin = r.path;
  }

  const port = await portImpl(cfg?.port || DEFAULT_PORT);
  if (!port) return { ok: false, reason: 'no_free_port' };
  const { path: configFile } = ensureConfigFile({ root, port, platformPath: chosen.path, level: cfg?.level || 2 });
  const started = await startImpl({ manifest, root, binary: bin, configFile, port, log, spawnImpl, fetchImpl });
  if (!started.ok) return { ok: false, reason: started.reason, url: started.url };
  return { ok: true, url: started.url, health: started.health, own: true, started: true, platform: chosen.version };
}

async function main(argv) {
  const args = argv.slice(2);
  const out = (s) => process.stdout.write(s + '\n');
  const manifest = readManifest();
  const root = dataRoot();

  if (args.includes('--platforms')) {
    const list = discoverPlatforms();
    if (!list.length) {
      out('Установленной платформы 1С со справкой не найдено.');
      return 2;
    }
    for (const p of list) out(`${p.version}  ${p.path}`);
    return 0;
  }

  if (args.includes('--stop')) {
    const r = await stopServer({ root });
    if (!r.ok) {
      out(`Гасить нечего: ${r.reason}`);
      return 1;
    }
    out(r.stopped.length ? `Остановлено демонов: ${r.stopped.join(', ')}.` : 'Живых демонов не осталось.');
    if (r.stale.length) out(`Записи без живого сервера сняты: ${r.stale.join(', ')}.`);
    return 0;
  }

  if (args.includes('--status')) {
    const servers = readServers(root);
    const bin = installed(manifest, root);
    out(`Бинарник: ${bin || 'не установлен'}`);
    out(`Рабочий каталог: ${existsSync(runtimeDir(root)) ? runtimeDir(root) : 'не создан'}`);
    if (!servers.length) {
      out('Свой демон не поднимался.');
    }
    for (const state of servers) {
      const health = await probeHealth({ url: state.url });
      out(`Свой демон: ${state.url} (pid ${state.pid}) — ${health ? 'отвечает' : 'не отвечает'}`);
      if (health) out(`Платформа: ${platformOf(health)} | индекс: ${health.index_loaded ? 'загружен' : 'нет'}`);
    }
    const shared = await probeHealth({ url: urlForPort(DEFAULT_PORT) });
    if (shared) out(`На ${DEFAULT_PORT} отвечает сервер ${shared.version}, платформа ${platformOf(shared)}`);
    return 0;
  }

  const { readConfig } = await import('./config.mjs');
  const { projectRoot } = await import('./project-root.mjs');
  const cfg = readConfig(projectRoot()).platformContext;
  const r = await ensureServer(cfg, { root, manifest, log: out });
  if (!r.ok) {
    process.stderr.write(`Контур не заведён: ${r.reason}\n`);
    return 2;
  }
  out(`Готово: ${r.url} (платформа ${platformOf(r.health) || '—'}${r.own ? '' : ', чужой сервер'})`);
  return 0;
}

if (process.argv[1]?.endsWith('platform-context-bootstrap.mjs')) {
  // Причина та же, что у движка: мгновенный выход обрывает недописанный stdout, когда он труба.
  main(process.argv).then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 2000).unref();
  });
}
