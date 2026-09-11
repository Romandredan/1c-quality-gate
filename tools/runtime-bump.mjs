#!/usr/bin/env node
/**
 * Сдвиг закрепления внешних движков: bsl-analyzer и bsl-context.
 *
 * Зачем не самообновление. Движок, меняющийся между прогонами, делает вердикт гейта
 * невоспроизводимым — поэтому плагин закрепляет версию и SHA-256 в манифесте и обходит
 * лаунчер автора, который обновляет бинарник сам (INSTALL.md). Цена закрепления — ручной
 * сдвиг, а оба проекта выпускаются почти ежедневно. Этот скрипт переносит сдвиг в конвейер
 * плагина: находит последний релиз, собирает суммы из GitHub API и переписывает манифест.
 * Решение остаётся за ревью PR (RELEASING.md), к пользователям версия едет с релизом плагина.
 *
 * Частично обновлённого манифеста не бывает: нет хотя бы одной цели — отказ целиком.
 *
 * Использование:
 *   node tools/runtime-bump.mjs --engine analyzer|platform-context [--check|--apply] [--json]
 *   node tools/runtime-bump.mjs --body <bump.json> [--sentinel <файл>]   # тело PR
 *
 * Коды возврата: --check — 0 обновления нет, 3 есть, 1 ошибка; --apply — 0 либо 1.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = dirname(HERE);

/**
 * Движки. `installPhrases` — фразы INSTALL.md, утверждающие ТЕКУЩЕЕ закрепление: их скрипт
 * правит сам. Всё остальное с упоминанием старой версии — история переходов и примеры
 * следа — только перечисляется (см. mentions), решение за ревьюером.
 */
export const ENGINES = {
  analyzer: {
    manifest: 'assets/analyzer/runtime-manifest.json',
    installPhrases: (oldV, newV) => [
      [`проверено на **${oldV}**`, `проверено на **${newV}**`],
      [`"version": "${oldV}"`, `"version": "${newV}"`],
    ],
  },
  'platform-context': {
    manifest: 'assets/platform-context/runtime-manifest.json',
    installPhrases: (oldV, newV) => [[`engine=bsl-context@${oldV}/`, `engine=bsl-context@${newV}/`]],
  },
};

const TAG = /^v?(\d+\.\d+\.\d+)$/;

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Последний обычный релиз. Черновики и предрелизы — не закрепление, а тестирование автора. */
export function pickLatest(releases) {
  let best = null;
  for (const r of releases || []) {
    if (r.draft || r.prerelease) continue;
    const m = TAG.exec(r.tag_name || '');
    if (!m) continue;
    if (!best || compareVersions(m[1], best.version) > 0) best = { version: m[1], release: r };
  }
  return best;
}

const fill = (template, version) => String(template).replace(/\{version\}/g, version);

/**
 * Цели манифеста в новом релизе. Имя asset берётся по шаблону (bsl-context: версия в имени)
 * либо как есть (bsl-analyzer: имена постоянные). Сумма — из поля digest вида `sha256:<hex>`;
 * иное значение или его отсутствие помечают цель в `unsigned`: сумму посчитает скачивание.
 */
export function buildTargets(manifest, release, version) {
  const targets = {};
  const missing = [];
  const unsigned = [];
  for (const [key, t] of Object.entries(manifest.targets || {})) {
    const asset = fill(t.assetTemplate || t.asset, version);
    const found = (release.assets || []).find((a) => a.name === asset);
    if (!found) {
      missing.push(key);
      continue;
    }
    const next = { ...t, asset };
    if (t.dirTemplate) next.dir = fill(t.dirTemplate, version);
    const m = /^sha256:([0-9a-f]{64})$/.exec(found.digest || '');
    next.sha256 = m ? m[1] : null;
    next.size = Number(found.size) || 0;
    next.url = found.browser_download_url;
    if (!m) unsigned.push(key);
    targets[key] = next;
  }
  return { ok: missing.length === 0, targets, missing, unsigned };
}

/** Копия манифеста с новой версией и целями. Порядок полей исходный, служебный `url` убран. */
export function updatedManifest(manifest, version, targets) {
  const out = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (k === 'version') out.version = version;
    else if (k === 'targets') {
      out.targets = {};
      for (const key of Object.keys(v)) {
        const { url, ...rest } = targets[key];
        out.targets[key] = rest;
      }
    } else out[k] = v;
  }
  return out;
}

/**
 * Релизы репозитория. Тридцати хватает, чтобы найти последний и собрать заметки за
 * пропущенные версии при недельном расписании; если закрепление отстало сильнее, последний
 * релиз всё равно в первой странице, а заметки будут неполными — это видно по их числу в PR.
 */
export async function fetchReleases(repo, { fetchImpl = globalThis.fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': '1c-quality-gate runtime-bump' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers });
  if (!res.ok) throw new Error(`GitHub API ответил ${res.status} на список релизов ${repo}`);
  return res.json();
}

/** Заметки автора за версии в интервале (current, latest], по возрастанию. Тело обрезано: в PR нужен обзор, а не полный текст. */
export function releaseNotesBetween(releases, current, latest, { limit = 4000 } = {}) {
  return (releases || [])
    .map((r) => ({ r, v: (TAG.exec(r.tag_name || '') || [])[1] }))
    .filter(({ r, v }) => v && !r.draft && !r.prerelease && compareVersions(v, current) > 0 && compareVersions(v, latest) <= 0)
    .sort((a, b) => compareVersions(a.v, b.v))
    .map(({ r, v }) => ({ tag: r.tag_name, version: v, publishedAt: r.published_at || null, body: String(r.body || '').slice(0, limit) }));
}

/** Сумма и размер файла по адресу — запасной путь, когда у asset нет digest. Поток, не буфер: бинарники по 70 МБ. */
export async function sha256Of(url, { fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`скачивание ${url}: HTTP ${res.status}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of Readable.fromWeb(res.body)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

/** Где старая версия — история или пример следа, а не утверждение о текущем закреплении. */
export const HISTORY_FILES = ['docs/false-positives-cfe.md', 'docs/analyzer-integration.md', 'docs/INSTALL.md'];

const SKIP_DIRS = new Set(['.git', 'node_modules', '.remember', '.state', '.qg-analyzer', 'tests']);
const TEXT_FILE = /\.(md|mjs|js|json|py|yml|yaml|toml|txt)$/;

/** Фразы INSTALL.md о текущем закреплении. Замена дословная: ничего, кроме этих фраз, не меняется. */
export function patchInstall(text, engine, oldV, newV) {
  let out = text;
  let changed = 0;
  for (const [from, to] of ENGINES[engine].installPhrases(oldV, newV)) {
    if (!out.includes(from)) continue;
    out = out.split(from).join(to);
    changed++;
  }
  return { text: out, changed };
}

/**
 * Файлы, где встречается старая версия, кроме истории и того, что скрипт правит сам.
 * Список идёт в PR для ревьюера: пример следа в README можно оставить, а фразу «проверено на»
 * в навыке — нет; отличить одно от другого скрипт не берётся.
 */
export function mentions(root, oldV, { exclude = [] } = {}) {
  const skip = new Set([...HISTORY_FILES, ...exclude]);
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relative(root, p).split(sep).join('/');
      if (statSync(p).isDirectory()) {
        if (!SKIP_DIRS.has(name) && !rel.startsWith('docs/superpowers')) walk(p);
        continue;
      }
      if (!TEXT_FILE.test(name) || skip.has(rel)) continue;
      if (readFileSync(p, 'utf8').includes(oldV)) found.push(rel);
    }
  };
  walk(root);
  return found.sort();
}

const publicTargets = (targets) =>
  Object.fromEntries(Object.entries(targets).map(([k, t]) => [k, { asset: t.asset, sha256: t.sha256, size: t.size }]));

/**
 * Один прогон по движку. `apply=false` ничего не пишет, но собирает всё, что нужно PR;
 * `apply=true` переписывает манифест и INSTALL.md. Упоминания считаются ДО записи, чтобы
 * список был одинаков в обоих режимах.
 */
export async function bump({ engine, root = PLUGIN_ROOT, apply = false, fetchImpl = globalThis.fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const spec = ENGINES[engine];
  if (!spec) return { ok: false, reason: 'unknown_engine', engine };
  const manifestPath = join(root, spec.manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const base = { ok: true, engine, name: manifest.engine, current: manifest.version };

  const releases = await fetchReleases(manifest.repo, { fetchImpl, token });
  const latest = pickLatest(releases);
  if (!latest) return { ok: false, reason: 'no_release', engine, name: manifest.engine, current: manifest.version };
  if (compareVersions(latest.version, manifest.version) <= 0) {
    return { ...base, latest: latest.version, upToDate: true, updated: false };
  }

  const built = buildTargets(manifest, latest.release, latest.version);
  if (!built.ok) {
    return { ok: false, reason: 'target_missing', engine, name: manifest.engine, current: manifest.version, latest: latest.version, missing: built.missing };
  }
  for (const key of built.unsigned) {
    const t = built.targets[key];
    const d = await sha256Of(t.url, { fetchImpl });
    t.sha256 = d.sha256;
    t.size = d.size;
  }

  const next = updatedManifest(manifest, latest.version, built.targets);
  const installPath = join(root, 'docs', 'INSTALL.md');
  const install = patchInstall(existsSync(installPath) ? readFileSync(installPath, 'utf8') : '', engine, manifest.version, latest.version);
  const manifestsRel = Object.values(ENGINES).map((e) => e.manifest);
  const result = {
    ...base,
    latest: latest.version,
    upToDate: false,
    updated: false,
    targets: publicTargets(next.targets),
    computed: built.unsigned,
    releaseNotes: releaseNotesBetween(releases, manifest.version, latest.version),
    installPatched: install.changed,
    mentions: mentions(root, manifest.version, { exclude: manifestsRel }),
  };
  if (apply) {
    writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    if (install.changed) writeFileSync(installPath, install.text, 'utf8');
    result.updated = true;
  }
  return result;
}

/** Коды возврата: check — 0 нет обновления, 3 есть, 1 ошибка; apply — 0 либо 1. */
export function exitCode(result, mode) {
  if (!result.ok) return 1;
  if (mode === 'check') return result.upToDate ? 0 : 3;
  return 0;
}

/** Тело PR. Всё, что ревьюеру нужно решить, — на одном экране; порядок ревью — RELEASING.md. */
export function prBody(result, { sentinel = '' } = {}) {
  const lines = [];
  lines.push(`Сдвиг закрепления **${result.name}**: ${result.current} → ${result.latest}.`, '');
  lines.push('Самообновления у пользователя по-прежнему нет: версия доедет с релизом плагина и поставится сама при первом прогоне.', '');
  lines.push('| Цель | Файл | SHA-256 | Размер |', '|---|---|---|---|');
  for (const [key, t] of Object.entries(result.targets || {})) {
    lines.push(`| ${key} | \`${t.asset}\` | \`${t.sha256}\` | ${t.size} |`);
  }
  if (result.computed?.length) lines.push('', `Суммы по целям ${result.computed.join(', ')} посчитаны скачиванием: у asset не было поля digest.`);
  lines.push('', '## Проверка', '');
  if (result.engine === 'analyzer') {
    lines.push(sentinel ? `Часовой на фикстуре плагина: \`${sentinel.trim()}\`` : 'Часовой не запускался.');
    lines.push('', 'Ревьюеру: A/B на корпусе по `docs/false-positives-cfe.md`, сравнить состав диагностик `rules list`; при расхождениях дописать раздел перехода.');
  } else {
    lines.push('Архив скачан, сумма сошлась, распакован. Сервер не запускался: на раннере нет установленной платформы 1С. Проверка живого сервера — на машине ревьюера, `node tools/platform-context-bootstrap.mjs --status`.');
  }
  lines.push('', '## Заметки автора за пропущенные версии', '');
  for (const n of result.releaseNotes || []) {
    lines.push(`### ${n.tag} (${n.publishedAt ? n.publishedAt.slice(0, 10) : 'дата не указана'})`, '', n.body || '_без описания_', '');
  }
  if (!(result.releaseNotes || []).length) lines.push('_заметок нет_', '');
  lines.push('## Упоминания старой версии, требующие решения', '');
  lines.push(`INSTALL.md переписан скриптом (${result.installPatched} фраз). Остальные файлы со строкой \`${result.current}\` — история либо примеры следа, решает ревьюер:`, '');
  for (const f of result.mentions || []) lines.push(`- \`${f}\``);
  if (!(result.mentions || []).length) lines.push('_нет_');
  lines.push('', '---', '', 'Собрано workflow `runtime-bump`; спецификация — `docs/superpowers/specs/2026-09-12-runtime-bump-design.md`.');
  return lines.join('\n') + '\n';
}

export function parseArgs(argv) {
  const out = { engine: null, mode: 'check', json: false, body: null, sentinel: null, error: null };
  let modes = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--engine') out.engine = argv[++i] || null;
    else if (a === '--check') {
      out.mode = 'check';
      modes++;
    } else if (a === '--apply') {
      out.mode = 'apply';
      modes++;
    } else if (a === '--json') out.json = true;
    else if (a === '--body') out.body = argv[++i] || null;
    else if (a === '--sentinel') out.sentinel = argv[++i] || null;
    else {
      out.error = `неизвестный аргумент ${a}`;
      return out;
    }
  }
  if (modes > 1) out.error = '--check и --apply взаимоисключающие';
  else if (out.body) {
    if (!existsSync(out.body)) out.error = `файл результата не найден: ${out.body}`;
  } else if (!out.engine) out.error = 'нужен --engine analyzer|platform-context';
  else if (!ENGINES[out.engine]) out.error = `неизвестный движок ${out.engine}; есть ${Object.keys(ENGINES).join(', ')}`;
  return out;
}

async function main(argv) {
  const out = (s) => process.stdout.write(s + '\n');
  const args = parseArgs(argv.slice(2));
  if (args.error) {
    process.stderr.write(`${args.error}\nИспользование: node tools/runtime-bump.mjs --engine analyzer|platform-context [--check|--apply] [--json]\n`);
    return 1;
  }
  if (args.body) {
    const result = JSON.parse(readFileSync(args.body, 'utf8'));
    const sentinel = args.sentinel && existsSync(args.sentinel) ? readFileSync(args.sentinel, 'utf8') : '';
    process.stdout.write(prBody(result, { sentinel }));
    return 0;
  }
  let result;
  try {
    result = await bump({ engine: args.engine, apply: args.mode === 'apply' });
  } catch (e) {
    result = { ok: false, reason: 'request_failed', engine: args.engine, error: String(e.message || e) };
  }
  if (args.json) out(JSON.stringify(result, null, 2));
  else if (!result.ok) {
    out(`${result.name || args.engine}: отказ — ${result.reason}${result.missing ? ' (' + result.missing.join(', ') + ')' : ''}${result.error ? ': ' + result.error : ''}`);
  } else if (result.upToDate) out(`${result.name}: закреплено ${result.current}, у автора ${result.latest} — обновления нет`);
  else out(`${result.name}: закреплено ${result.current}, у автора ${result.latest} — ${result.updated ? 'манифест переписан' : 'обновление есть'}`);
  return exitCode(result, args.mode);
}

if (process.argv[1]?.endsWith('runtime-bump.mjs')) {
  // Как у бутстрапов: мгновенный выход обрывает недописанный stdout, когда он труба.
  main(process.argv).then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 2000).unref();
  });
}
