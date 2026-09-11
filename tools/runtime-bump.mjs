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
