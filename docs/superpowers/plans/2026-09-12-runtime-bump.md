# Автоматический сдвиг закрепления движков: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Скрипт `tools/runtime-bump.mjs` и workflow `runtime-bump.yml`, которые находят новый релиз bsl-analyzer и bsl-context, переписывают манифесты закрепления и открывают PR с назначением на владельца.

**Architecture:** Один скрипт на оба движка с инжектируемым `fetchImpl`, чистые функции для выбора релиза, сборки целей и переписывания манифеста, CLI с тремя режимами. Workflow по матрице движков прогоняет `--check`, `--apply`, проверки и создаёт или обновляет PR штатным токеном. Обновление доезжает до пользователей с релизом плагина, как сейчас.

**Tech Stack:** Node 20 ESM, `node:fs`/`node:crypto`/`node:stream`, GitHub REST API (`/releases`, поле `digest`), GitHub Actions, `gh` CLI. Тесты в `tests/run-tests.mjs` (`section`/`check`), фикстуры в `tests/fixtures/runtime-bump/`.

**Spec:** `docs/superpowers/specs/2026-09-12-runtime-bump-design.md`

## Global Constraints

- Пути внутри плагина только через `PLUGIN_ROOT`, вычисленный от `import.meta.url`; абсолютных путей машины автора нет.
- Никаких проектных данных в артефактах; после каждой задачи `node tools/validate-package.mjs` зелёный.
- Тексты стандартов не воспроизводятся.
- Комментарии, сообщения, документация на русском; идентификаторы и код в оригинале; без сленг-гибридов.
- Самообновление движка у пользователя не вводится ни в каком виде.
- Частично обновлённого манифеста не бывает: либо все три цели, либо отказ.
- Тесты идут без сети: сетевой слой инжектируется параметром `fetchImpl`.
- Коммиты завершаются строкой `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Шаблоны имён в манифесте bsl-context

**Files:**
- Modify: `assets/platform-context/runtime-manifest.json`
- Test: `tests/run-tests.mjs` (секция «Самозаведение контура платформенного API», после проверки `адрес архива собирается из манифеста`)

**Interfaces:**
- Produces: в каждой цели манифеста поля `assetTemplate` и `dirTemplate` со строкой `{version}`; поля `asset` и `dir` остаются вычисленными значениями, их читает `platform-context-bootstrap.mjs`.

- [ ] **Step 1: Написать падающий тест**

В `tests/run-tests.mjs` после строки `check('адрес архива собирается из манифеста, а не зашит', ...)` добавить:

```js
  // Имя архива содержит версию, и скрипт сдвига закрепления (runtime-bump.mjs) собирает его
  // по шаблону. Шаблон обязан сходиться с закреплённым именем, иначе сдвиг соберёт имя,
  // которого в релизе нет, и откажет по всем целям сразу.
  for (const key of ['win32-x64', 'linux-x64', 'darwin-arm64']) {
    const t = man.targets[key];
    check(
      `цель ${key}: шаблон имени архива сходится с закреплённым именем`,
      Boolean(t.assetTemplate) && t.assetTemplate.replace('{version}', man.version) === t.asset,
      `${t.assetTemplate} → ${t.asset}`
    );
    check(
      `цель ${key}: шаблон каталога сходится с закреплённым каталогом`,
      Boolean(t.dirTemplate) && t.dirTemplate.replace('{version}', man.version) === t.dir,
      `${t.dirTemplate} → ${t.dir}`
    );
  }
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "шаблон|провалено"`
Expected: шесть строк `FAIL ... шаблон ...`, итог `провалено: 6`.

- [ ] **Step 3: Дописать шаблоны в манифест**

`assets/platform-context/runtime-manifest.json`, каждая цель получает две строки перед `asset`:

```json
    "win32-x64": {
      "assetTemplate": "bsl-context-v{version}-x86_64-pc-windows-msvc.zip",
      "dirTemplate": "bsl-context-v{version}-x86_64-pc-windows-msvc",
      "asset": "bsl-context-v0.16.0-x86_64-pc-windows-msvc.zip",
      "dir": "bsl-context-v0.16.0-x86_64-pc-windows-msvc",
      "sha256": "7729e75b808d17c0b5d779538bcb0468f38f7e2d4c2357aefdf5beceaeb61eaa",
      "size": 5485804
    },
    "linux-x64": {
      "assetTemplate": "bsl-context-v{version}-x86_64-unknown-linux-gnu.tar.gz",
      "dirTemplate": "bsl-context-v{version}-x86_64-unknown-linux-gnu",
      "asset": "bsl-context-v0.16.0-x86_64-unknown-linux-gnu.tar.gz",
      "dir": "bsl-context-v0.16.0-x86_64-unknown-linux-gnu",
      "sha256": "bbc59088e1a98bf4915f686ce7782e9c1baaf3ae2722d591d8df5cffaa544d05",
      "size": 5588654
    },
    "darwin-arm64": {
      "assetTemplate": "bsl-context-v{version}-aarch64-apple-darwin.tar.gz",
      "dirTemplate": "bsl-context-v{version}-aarch64-apple-darwin",
      "asset": "bsl-context-v0.16.0-aarch64-apple-darwin.tar.gz",
      "dir": "bsl-context-v0.16.0-aarch64-apple-darwin",
      "sha256": "4e0c730d66a374134a2ff4682e398700d26e2faa299a5ec51fb7e1fb7f07f895",
      "size": 4885367
    }
```

В `_comment` заменить фразу «Обновление версии: поменять version, суммы и размеры, взяв их из GitHub API релиза (поле digest у каждого asset).» на «Обновление версии: `node tools/runtime-bump.mjs --engine platform-context --apply`; имена архивов собираются из assetTemplate и dirTemplate, суммы и размеры берутся из GitHub API релиза (поле digest у каждого asset).»

- [ ] **Step 4: Прогнать тесты и validate-package**

Run: `node tests/run-tests.mjs 2>&1 | tail -3 && node tools/validate-package.mjs | tail -1`
Expected: `провалено: 0`, `Ошибок: 0`.

- [ ] **Step 5: Commit**

```bash
git add assets/platform-context/runtime-manifest.json tests/run-tests.mjs
git commit -m "feat(закрепление): шаблоны имён архива в манифесте bsl-context

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Ядро runtime-bump — выбор релиза, сборка целей, переписывание манифеста

**Files:**
- Create: `tools/runtime-bump.mjs`
- Create: `tests/fixtures/runtime-bump/analyzer-releases.json`
- Create: `tests/fixtures/runtime-bump/platform-context-releases.json`
- Test: `tests/run-tests.mjs` (новая секция «Сдвиг закрепления движков» перед строкой `// Изолированные наборы тестов`)

**Interfaces:**
- Produces:
  - `compareVersions(a: string, b: string): number` — как в `platform-context-bootstrap.mjs`, для строк `X.Y.Z`.
  - `pickLatest(releases: Release[]): { version: string, release: Release } | null` — без `draft`/`prerelease`, тег `v?X.Y.Z`.
  - `buildTargets(manifest, release, version): { ok, targets: Record<key, Target>, missing: string[], unsigned: string[] }` — `Target` = поля цели манифеста с обновлёнными `asset`, `dir`, `sha256` (или `null`), `size`, плюс `url`.
  - `updatedManifest(manifest, version, targets): object` — копия манифеста с новой версией и целями, порядок полей исходный, поле `url` из целей убрано.
  - `ENGINES`: `{ analyzer: { manifest, installPhrases }, 'platform-context': { manifest, installPhrases } }`.

- [ ] **Step 1: Фикстуры ответов GitHub API**

`tests/fixtures/runtime-bump/analyzer-releases.json` (порядок намеренно перемешан, есть prerelease и draft новее всех, есть пропущенная версия без одной цели):

```json
[
  {
    "tag_name": "v0.2.81",
    "draft": true,
    "prerelease": false,
    "published_at": null,
    "body": "черновик",
    "assets": []
  },
  {
    "tag_name": "v0.2.80-rc1",
    "draft": false,
    "prerelease": true,
    "published_at": "2026-09-11T10:00:00Z",
    "body": "кандидат",
    "assets": []
  },
  {
    "tag_name": "v0.2.79",
    "draft": false,
    "prerelease": false,
    "published_at": "2026-09-10T17:46:20Z",
    "body": "## 0.2.79\n- исправлен разбор псевдонимов\n",
    "assets": [
      { "name": "bsl-analyzer-app-darwin-arm64", "size": 57986432, "digest": "sha256:33799e9e3066922046506915b7b162286d6405a1157c361a214787f78309c067", "browser_download_url": "https://github.com/itrous/bsl-analyzer/releases/download/v0.2.79/bsl-analyzer-app-darwin-arm64" },
      { "name": "bsl-analyzer-app-linux-amd64", "size": 74314376, "digest": "sha256:f62c5d561f9aa9da46cffa2b88676ec3304751a90f43cb005701170500b29aef", "browser_download_url": "https://github.com/itrous/bsl-analyzer/releases/download/v0.2.79/bsl-analyzer-app-linux-amd64" },
      { "name": "bsl-analyzer-app-windows-amd64.exe", "size": 68738048, "digest": "sha256:f52cf2e0af6e988e45601477f1961cf094ee52e89565bec7e34aa02852c2294e", "browser_download_url": "https://github.com/itrous/bsl-analyzer/releases/download/v0.2.79/bsl-analyzer-app-windows-amd64.exe" },
      { "name": "bsl-analyzer-windows-amd64.exe", "size": 4774912, "digest": "sha256:000b0d34b7cf6b27a40b1a14c25766e7eb87dfbf10d99dce1ad5a42cedb3acf5", "browser_download_url": "https://github.com/itrous/bsl-analyzer/releases/download/v0.2.79/bsl-analyzer-windows-amd64.exe" }
    ]
  },
  {
    "tag_name": "v0.2.73",
    "draft": false,
    "prerelease": false,
    "published_at": "2026-08-25T02:45:11Z",
    "body": "## 0.2.73\n",
    "assets": []
  },
  {
    "tag_name": "v0.2.77",
    "draft": false,
    "prerelease": false,
    "published_at": "2026-09-03T16:30:36Z",
    "body": "## 0.2.77\n- новая диагностика\n",
    "assets": [
      { "name": "bsl-analyzer-app-linux-amd64", "size": 1, "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000001", "browser_download_url": "https://example.invalid/a" },
      { "name": "bsl-analyzer-app-windows-amd64.exe", "size": 1, "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000002", "browser_download_url": "https://example.invalid/b" }
    ]
  },
  {
    "tag_name": "v0.2.72",
    "draft": false,
    "prerelease": false,
    "published_at": "2026-08-24T19:27:13Z",
    "body": "## 0.2.72\n",
    "assets": []
  }
]
```

`tests/fixtures/runtime-bump/platform-context-releases.json` (у одного asset нет `digest`, у другого он не sha256 — оба должны уйти в подсчёт скачиванием):

```json
[
  {
    "tag_name": "v0.18.1",
    "draft": false,
    "prerelease": false,
    "published_at": "2026-09-09T08:16:58Z",
    "body": "## 0.18.1\n- поправлен индекс\n",
    "assets": [
      { "name": "bsl-context-v0.18.1-x86_64-pc-windows-msvc.zip", "size": 5500000, "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111", "browser_download_url": "https://example.invalid/win.zip" },
      { "name": "bsl-context-v0.18.1-x86_64-unknown-linux-gnu.tar.gz", "size": 5600000, "browser_download_url": "https://example.invalid/linux.tar.gz" },
      { "name": "bsl-context-v0.18.1-aarch64-apple-darwin.tar.gz", "size": 4900000, "digest": "md5:abc", "browser_download_url": "https://example.invalid/mac.tar.gz" }
    ]
  },
  {
    "tag_name": "v0.16.0",
    "draft": false,
    "prerelease": false,
    "published_at": "2026-08-30T20:25:13Z",
    "body": "## 0.16.0\n",
    "assets": []
  }
]
```

- [ ] **Step 2: Написать падающие тесты ядра**

В `tests/run-tests.mjs` перед `// Изолированные наборы тестов`:

```js
// ---------------------------------------------------------------------------
section('Сдвиг закрепления движков — выбор релиза и сборка целей');

// Закрепление не самообновление: скрипт лишь готовит новую версию манифеста, а решение и
// проверка остаются за ревью PR. Здесь проверяется чистая часть: без сети и без записи.
{
  const rb = await import(pathToFileURL(join(ROOT, 'tools', 'runtime-bump.mjs')).href);
  const analyzerReleases = JSON.parse(readFileSync(join(FIXTURES, 'runtime-bump', 'analyzer-releases.json'), 'utf8'));
  const pcReleases = JSON.parse(readFileSync(join(FIXTURES, 'runtime-bump', 'platform-context-releases.json'), 'utf8'));
  const analyzerManifest = JSON.parse(readFileSync(join(ROOT, 'assets', 'analyzer', 'runtime-manifest.json'), 'utf8'));
  const pcManifest = JSON.parse(readFileSync(join(ROOT, 'assets', 'platform-context', 'runtime-manifest.json'), 'utf8'));

  check('сравнение версий: числовое, а не строковое', rb.compareVersions('0.2.79', '0.2.9') > 0 && rb.compareVersions('0.16.0', '0.16.0') === 0);

  const latest = rb.pickLatest(analyzerReleases);
  check('последний релиз — без черновиков и предрелизов, порядок в ответе не важен', latest?.version === '0.2.79', JSON.stringify(latest?.version));
  check('пустой список релизов — null', rb.pickLatest([]) === null);
  check('тег без вида X.Y.Z пропускается', rb.pickLatest([{ tag_name: 'nightly', draft: false, prerelease: false }]) === null);

  const built = rb.buildTargets(analyzerManifest, latest.release, latest.version);
  check('все три цели анализатора найдены по постоянным именам', built.ok && Object.keys(built.targets).length === 3, JSON.stringify(built.missing));
  check('сумма берётся из digest без префикса', built.targets['win32-x64'].sha256 === 'f52cf2e0af6e988e45601477f1961cf094ee52e89565bec7e34aa02852c2294e');
  check('размер берётся из size', built.targets['linux-x64'].size === 74314376);
  check('адрес скачивания сохранён для запасного подсчёта', built.targets['darwin-arm64'].url.endsWith('/v0.2.79/bsl-analyzer-app-darwin-arm64'));
  check('лаунчер автора (bsl-analyzer-windows-amd64.exe) не спутан с рабочим бинарником', built.targets['win32-x64'].asset === 'bsl-analyzer-app-windows-amd64.exe');

  const partial = analyzerReleases.find((r) => r.tag_name === 'v0.2.77');
  const broken = rb.buildTargets(analyzerManifest, partial, '0.2.77');
  check('релиз без одной цели — отказ целиком', !broken.ok && broken.missing.includes('darwin-arm64'), JSON.stringify(broken.missing));

  const pcLatest = rb.pickLatest(pcReleases);
  const pcBuilt = rb.buildTargets(pcManifest, pcLatest.release, pcLatest.version);
  check('имя архива bsl-context собрано по шаблону с версией', pcBuilt.ok && pcBuilt.targets['win32-x64'].asset === 'bsl-context-v0.18.1-x86_64-pc-windows-msvc.zip', JSON.stringify(pcBuilt.missing));
  check('каталог внутри архива собран по шаблону', pcBuilt.targets['linux-x64'].dir === 'bsl-context-v0.18.1-x86_64-unknown-linux-gnu');
  check('asset без digest помечен для подсчёта скачиванием', pcBuilt.unsigned.includes('linux-x64') && pcBuilt.targets['linux-x64'].sha256 === null);
  check('digest не sha256 отвергнут и тоже идёт в подсчёт', pcBuilt.unsigned.includes('darwin-arm64') && pcBuilt.targets['darwin-arm64'].sha256 === null);
  check('шаблоны в целях сохранены после сборки', pcBuilt.targets['win32-x64'].assetTemplate === pcManifest.targets['win32-x64'].assetTemplate);

  const next = rb.updatedManifest(pcManifest, pcLatest.version, pcBuilt.targets);
  check('переписанный манифест: версия новая', next.version === '0.18.1');
  check('переписанный манифест: порядок верхних полей исходный', JSON.stringify(Object.keys(next)) === JSON.stringify(Object.keys(pcManifest)));
  check('переписанный манифест: порядок полей цели исходный', JSON.stringify(Object.keys(next.targets['win32-x64'])) === JSON.stringify(Object.keys(pcManifest.targets['win32-x64'])));
  check('переписанный манифест: url в цели не попал', !('url' in next.targets['win32-x64']));
  check('переписанный манифест: _comment сохранён', next._comment === pcManifest._comment);
  check('исходный манифест не тронут', pcManifest.version === '0.16.0');
}
```

- [ ] **Step 3: Прогнать, убедиться, что секция падает на импорте**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "runtime-bump|Cannot find|провалено" | head -3`
Expected: ошибка импорта `tools/runtime-bump.mjs` (модуль не найден) либо `FAIL` по всей секции.

- [ ] **Step 4: Создать ядро `tools/runtime-bump.mjs`**

```js
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
```

- [ ] **Step 5: Прогнать тесты**

Run: `node tests/run-tests.mjs 2>&1 | tail -3`
Expected: `провалено: 0`.

- [ ] **Step 6: Commit**

```bash
git add tools/runtime-bump.mjs tests/fixtures/runtime-bump tests/run-tests.mjs
git commit -m "feat(закрепление): ядро runtime-bump — выбор релиза, цели, манифест

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Сетевой слой — релизы GitHub, заметки за пропущенные версии, сумма скачиванием

**Files:**
- Modify: `tools/runtime-bump.mjs` (дописать после `updatedManifest`)
- Test: `tests/run-tests.mjs` (продолжение секции из Task 2, новая секция «Сдвиг закрепления движков — сеть»)

**Interfaces:**
- Consumes: `compareVersions`, `TAG` из Task 2.
- Produces:
  - `fetchReleases(repo, { fetchImpl, token }): Promise<Release[]>` — бросает `Error` при не-2xx.
  - `releaseNotesBetween(releases, current, latest, { limit = 4000 }): { tag, version, publishedAt, body }[]` по возрастанию версии, только `(current, latest]`.
  - `sha256Of(url, { fetchImpl }): Promise<{ sha256, size }>` — потоковый подсчёт.

- [ ] **Step 1: Падающие тесты**

```js
// ---------------------------------------------------------------------------
section('Сдвиг закрепления движков — сеть');

{
  const rb = await import(pathToFileURL(join(ROOT, 'tools', 'runtime-bump.mjs')).href);
  const analyzerReleases = JSON.parse(readFileSync(join(FIXTURES, 'runtime-bump', 'analyzer-releases.json'), 'utf8'));

  // fetchReleases: адрес, заголовки, токен, ошибка HTTP.
  const calls = [];
  const fetchOk = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => analyzerReleases };
  };
  const got = await rb.fetchReleases('itrous/bsl-analyzer', { fetchImpl: fetchOk, token: 'T' });
  check('релизы запрошены у GitHub API по репозиторию из манифеста', calls[0].url === 'https://api.github.com/repos/itrous/bsl-analyzer/releases?per_page=30', calls[0].url);
  check('токен уходит в Authorization, формат API объявлен', calls[0].init.headers.Authorization === 'Bearer T' && calls[0].init.headers.Accept === 'application/vnd.github+json');
  check('ответ отдан как есть', got.length === analyzerReleases.length);
  const noToken = [];
  await rb.fetchReleases('a/b', { fetchImpl: async (u, i) => (noToken.push(i), { ok: true, json: async () => [] }), token: '' });
  check('без токена заголовка Authorization нет', !('Authorization' in noToken[0].headers));
  let thrown = null;
  try {
    await rb.fetchReleases('a/b', { fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }), token: '' });
  } catch (e) {
    thrown = e;
  }
  check('не-2xx от API — ошибка с кодом HTTP', thrown && /403/.test(thrown.message), thrown?.message);

  // releaseNotesBetween: только пропущенные версии, по возрастанию, без предрелизов, обрезка.
  const notes = rb.releaseNotesBetween(analyzerReleases, '0.2.73', '0.2.79');
  check('заметки — за версии строго новее текущей и не новее последней', notes.map((n) => n.version).join(',') === '0.2.77,0.2.79', notes.map((n) => n.version).join(','));
  check('заметка несёт тег, дату и тело', notes[0].tag === 'v0.2.77' && notes[0].publishedAt === '2026-09-03T16:30:36Z' && notes[0].body.includes('новая диагностика'));
  const cut = rb.releaseNotesBetween([{ tag_name: 'v9.9.9', draft: false, prerelease: false, body: 'x'.repeat(5000) }], '0.0.0', '9.9.9', { limit: 10 });
  check('тело заметки обрезано до предела', cut[0].body.length === 10);

  // sha256Of: сумма и размер считаются по потоку, без буферизации всего файла.
  const bytes = Buffer.from('содержимое архива для теста');
  const expected = createHash('sha256').update(bytes).digest('hex');
  const d = await rb.sha256Of('https://example.invalid/x', { fetchImpl: async () => ({ ok: true, status: 200, body: new Blob([bytes]).stream() }) });
  check('сумма скачиванием совпадает с эталоном', d.sha256 === expected && d.size === bytes.length, JSON.stringify(d));
  let dlErr = null;
  try {
    await rb.sha256Of('https://example.invalid/x', { fetchImpl: async () => ({ ok: false, status: 404 }) });
  } catch (e) {
    dlErr = e;
  }
  check('неудачное скачивание — ошибка с адресом и кодом', dlErr && /404/.test(dlErr.message) && dlErr.message.includes('example.invalid'), dlErr?.message);
}
```

Добавить `createHash` в импорты `tests/run-tests.mjs`: `import { createHash } from 'node:crypto';`.

- [ ] **Step 2: Прогнать и увидеть падение**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "fetchReleases|is not a function|провалено" | head -3`
Expected: `TypeError: rb.fetchReleases is not a function` либо `FAIL` по секции.

- [ ] **Step 3: Реализация**

Дописать в `tools/runtime-bump.mjs`:

```js
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
```

- [ ] **Step 4: Прогнать тесты**

Run: `node tests/run-tests.mjs 2>&1 | tail -3`
Expected: `провалено: 0`.

- [ ] **Step 5: Commit**

```bash
git add tools/runtime-bump.mjs tests/run-tests.mjs
git commit -m "feat(закрепление): релизы GitHub, заметки за пропущенные версии, сумма скачиванием

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Правка INSTALL.md и перечень упоминаний старой версии

**Files:**
- Modify: `tools/runtime-bump.mjs`
- Test: `tests/run-tests.mjs` (новая секция «Сдвиг закрепления движков — документация»)

**Interfaces:**
- Consumes: `ENGINES[engine].installPhrases`.
- Produces:
  - `patchInstall(text, engine, oldV, newV): { text, changed: number }` — число заменённых фраз.
  - `mentions(root, oldV, { exclude }): string[]` — относительные пути через `/`, отсортированы; `exclude` — массив относительных путей и префиксов каталогов.
  - `HISTORY_FILES: string[]` — файлы, где старая версия законна.

- [ ] **Step 1: Падающие тесты**

```js
// ---------------------------------------------------------------------------
section('Сдвиг закрепления движков — документация');

{
  const rb = await import(pathToFileURL(join(ROOT, 'tools', 'runtime-bump.mjs')).href);

  const install = readFileSync(join(ROOT, 'docs', 'INSTALL.md'), 'utf8');
  const a = rb.patchInstall(install, 'analyzer', '0.2.73', '0.2.79');
  check('INSTALL.md: фраза «проверено на» и пример конфига анализатора переписаны', a.changed === 2 && a.text.includes('проверено на **0.2.79**') && a.text.includes('"version": "0.2.79"'), `changed=${a.changed}`);
  check('INSTALL.md: история переходов и чужие упоминания не тронуты', a.text.includes('engine=bsl-context@0.16.0/'));
  const p = rb.patchInstall(install, 'platform-context', '0.16.0', '0.18.1');
  check('INSTALL.md: штамп сервера справки переписан', p.changed === 1 && p.text.includes('engine=bsl-context@0.18.1/'), `changed=${p.changed}`);
  const none = rb.patchInstall('текст без версии', 'analyzer', '0.2.73', '0.2.79');
  check('фраз нет — ноль замен, текст тот же', none.changed === 0 && none.text === 'текст без версии');

  // mentions: перечисление для ревьюера, не правка. История, тесты и служебные каталоги вне списка.
  const root = join(WORK, 'bump-mentions');
  writeBytes('bump-mentions/README.md', 'engine=bsl-analyzer@0.2.73\n');
  writeBytes('bump-mentions/docs/false-positives-cfe.md', 'Переход 0.2.66 → 0.2.73\n');
  writeBytes('bump-mentions/docs/INSTALL.md', 'проверено на **0.2.73**\n');
  writeBytes('bump-mentions/tests/run-tests.mjs', "'0.2.73'\n");
  writeBytes('bump-mentions/.remember/now.md', '0.2.73\n');
  writeBytes('bump-mentions/tools/rename-check.mjs', '// bsl-analyzer 0.2.73 связывает\n');
  writeBytes('bump-mentions/assets/analyzer/runtime-manifest.json', '{"version":"0.2.73"}\n');
  writeBytes('bump-mentions/bin.exe', 'двоичное 0.2.73\n');
  const m = rb.mentions(root, '0.2.73', { exclude: ['assets/analyzer/runtime-manifest.json'] });
  check('упоминания: README и код перечислены', m.includes('README.md') && m.includes('tools/rename-check.mjs'), JSON.stringify(m));
  check('упоминания: история, INSTALL.md, тесты, .remember, манифест и не-текст исключены',
    !m.some((f) => /false-positives|INSTALL|tests\/|\.remember|runtime-manifest|bin\.exe/.test(f)), JSON.stringify(m));
  check('упоминания отсортированы и с прямыми слэшами', JSON.stringify(m) === JSON.stringify([...m].sort()) && !m.some((f) => f.includes('\\')));
}
```

- [ ] **Step 2: Прогнать, увидеть падение**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "patchInstall|провалено" | head -2`
Expected: `TypeError: rb.patchInstall is not a function`.

- [ ] **Step 3: Реализация**

Дописать в `tools/runtime-bump.mjs`:

```js
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
```

- [ ] **Step 4: Прогнать тесты**

Run: `node tests/run-tests.mjs 2>&1 | tail -3`
Expected: `провалено: 0`.

- [ ] **Step 5: Commit**

```bash
git add tools/runtime-bump.mjs tests/run-tests.mjs
git commit -m "feat(закрепление): правка INSTALL.md и перечень упоминаний старой версии

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: bump(), тело PR, CLI

**Files:**
- Modify: `tools/runtime-bump.mjs`
- Test: `tests/run-tests.mjs` (новая секция «Сдвиг закрепления движков — прогон и CLI»)

**Interfaces:**
- Consumes: всё из Task 2–4.
- Produces:
  - `bump({ engine, root, apply, fetchImpl, token }): Promise<Result>`, где `Result` = `{ ok, engine, name, current, latest, upToDate, updated, targets, computed, releaseNotes, installPatched, mentions }` либо `{ ok: false, reason, engine, ... }`.
  - `exitCode(result, mode: 'check'|'apply'): number`.
  - `prBody(result, { sentinel }): string` — Markdown.
  - `parseArgs(argv): { engine, mode, json, body, sentinel }`.
  - CLI: `--engine`, `--check` (по умолчанию), `--apply`, `--json`, `--body <файл> [--sentinel <файл>]`.

- [ ] **Step 1: Падающие тесты**

```js
// ---------------------------------------------------------------------------
section('Сдвиг закрепления движков — прогон и CLI');

{
  const rb = await import(pathToFileURL(join(ROOT, 'tools', 'runtime-bump.mjs')).href);
  const analyzerReleases = JSON.parse(readFileSync(join(FIXTURES, 'runtime-bump', 'analyzer-releases.json'), 'utf8'));
  const pcReleases = JSON.parse(readFileSync(join(FIXTURES, 'runtime-bump', 'platform-context-releases.json'), 'utf8'));

  // Временный корень: настоящие манифесты, урезанный INSTALL.md, один файл с упоминанием.
  const root = join(WORK, 'bump-root');
  const seed = () => {
    removeTreeSync(root);
    for (const f of ['assets/analyzer/runtime-manifest.json', 'assets/platform-context/runtime-manifest.json']) {
      writeBytes(`bump-root/${f}`, readFileSync(join(ROOT, f), 'utf8'));
    }
    writeBytes('bump-root/docs/INSTALL.md', 'проверено на **0.2.73**; пример `"version": "0.2.73"`; след `engine=bsl-context@0.16.0/8.3.27.1688`\n');
    writeBytes('bump-root/README.md', 'engine=bsl-analyzer@0.2.73\n');
  };
  const apiFor = (releases, files = {}) => async (url) => {
    if (url.includes('/releases')) return { ok: true, status: 200, json: async () => releases };
    const bytes = files[url];
    if (!bytes) return { ok: false, status: 404 };
    return { ok: true, status: 200, body: new Blob([bytes]).stream() };
  };

  // --check: ничего не пишет, но всё сообщает.
  seed();
  const checked = await rb.bump({ engine: 'analyzer', root, apply: false, fetchImpl: apiFor(analyzerReleases), token: '' });
  check('check: обновление найдено, версии названы', checked.ok && !checked.upToDate && checked.current === '0.2.73' && checked.latest === '0.2.79', JSON.stringify(checked).slice(0, 200));
  check('check: имя движка из манифеста для ветки и заголовка', checked.name === 'bsl-analyzer');
  check('check: манифест на диске не тронут', JSON.parse(readFileSync(join(root, 'assets/analyzer/runtime-manifest.json'), 'utf8')).version === '0.2.73');
  check('check: заметки автора и упоминания приложены', checked.releaseNotes.length === 2 && checked.mentions.includes('README.md'), JSON.stringify(checked.mentions));
  check('check: updated=false', checked.updated === false);
  check('код возврата check при обновлении — 3', rb.exitCode(checked, 'check') === 3);

  // --apply: манифест и INSTALL.md переписаны, суммы из digest.
  const applied = await rb.bump({ engine: 'analyzer', root, apply: true, fetchImpl: apiFor(analyzerReleases), token: '' });
  const manAfter = JSON.parse(readFileSync(join(root, 'assets/analyzer/runtime-manifest.json'), 'utf8'));
  check('apply: манифест переписан на новую версию с суммами из digest', applied.updated && manAfter.version === '0.2.79' && manAfter.targets['win32-x64'].sha256.startsWith('f52cf2e0'), JSON.stringify(manAfter.targets['win32-x64']));
  check('apply: манифест заканчивается переводом строки', readFileSync(join(root, 'assets/analyzer/runtime-manifest.json'), 'utf8').endsWith('}\n'));
  check('apply: INSTALL.md переписан по двум фразам', applied.installPatched === 2 && readFileSync(join(root, 'docs/INSTALL.md'), 'utf8').includes('проверено на **0.2.79**'));
  check('код возврата apply — 0', rb.exitCode(applied, 'apply') === 0);

  // Повтор после apply: обновления нет.
  const again = await rb.bump({ engine: 'analyzer', root, apply: false, fetchImpl: apiFor(analyzerReleases), token: '' });
  check('после сдвига: upToDate, код 0', again.ok && again.upToDate && rb.exitCode(again, 'check') === 0);

  // Отказ при неполном релизе: манифест не тронут.
  seed();
  const partialOnly = analyzerReleases.filter((r) => r.tag_name !== 'v0.2.79');
  const refused = await rb.bump({ engine: 'analyzer', root, apply: true, fetchImpl: apiFor(partialOnly), token: '' });
  check('релиз без одной цели — отказ с перечнем целей, манифест не тронут',
    !refused.ok && refused.reason === 'target_missing' && refused.missing.includes('darwin-arm64') &&
      JSON.parse(readFileSync(join(root, 'assets/analyzer/runtime-manifest.json'), 'utf8')).version === '0.2.73', JSON.stringify(refused));
  check('код возврата при отказе — 1 в обоих режимах', rb.exitCode(refused, 'check') === 1 && rb.exitCode(refused, 'apply') === 1);

  // Запасной подсчёт суммы скачиванием для целей без digest.
  seed();
  const linuxBytes = Buffer.from('linux-архив');
  const macBytes = Buffer.from('mac-архив');
  const pc = await rb.bump({
    engine: 'platform-context', root, apply: true, token: '',
    fetchImpl: apiFor(pcReleases, { 'https://example.invalid/linux.tar.gz': linuxBytes, 'https://example.invalid/mac.tar.gz': macBytes }),
  });
  const pcMan = JSON.parse(readFileSync(join(root, 'assets/platform-context/runtime-manifest.json'), 'utf8'));
  check('bsl-context: цели без digest посчитаны скачиванием и отмечены в результате',
    pc.ok && pc.computed.sort().join(',') === 'darwin-arm64,linux-x64' &&
      pcMan.targets['linux-x64'].sha256 === createHash('sha256').update(linuxBytes).digest('hex') && pcMan.targets['linux-x64'].size === linuxBytes.length,
    JSON.stringify(pc.computed));
  check('bsl-context: цель с digest суммы не скачивала', pcMan.targets['win32-x64'].sha256 === '1'.repeat(64));
  check('bsl-context: INSTALL.md переписан по штампу', readFileSync(join(root, 'docs/INSTALL.md'), 'utf8').includes('engine=bsl-context@0.18.1/'));

  // Неизвестный движок и пустой список релизов.
  const unknown = await rb.bump({ engine: 'нет-такого', root, fetchImpl: apiFor([]), token: '' });
  check('неизвестный движок — отказ', !unknown.ok && unknown.reason === 'unknown_engine');
  seed();
  const empty = await rb.bump({ engine: 'analyzer', root, fetchImpl: apiFor([]), token: '' });
  check('нет обычных релизов — отказ no_release', !empty.ok && empty.reason === 'no_release');

  // Тело PR.
  const body = rb.prBody(checked, { sentinel: 'Часовой (bsl-analyzer@0.2.79): found' });
  check('тело PR: таблица версий, цели, заметки, упоминания, часовой', ['0.2.73', '0.2.79', 'win32-x64', 'новая диагностика', 'README.md', 'found', 'false-positives-cfe.md'].every((s) => body.includes(s)), body.slice(0, 300));
  const pcBody = rb.prBody(pc, {});
  check('тело PR сервера справки: сказано, что сервер не запускался', pcBody.includes('не запускался'));

  // Разбор аргументов.
  const pa = rb.parseArgs(['--engine', 'analyzer', '--apply', '--json']);
  check('аргументы: движок, режим, json', pa.engine === 'analyzer' && pa.mode === 'apply' && pa.json === true);
  check('аргументы: режим по умолчанию check', rb.parseArgs(['--engine', 'analyzer']).mode === 'check');
  check('аргументы: --check и --apply вместе — ошибка', rb.parseArgs(['--engine', 'analyzer', '--check', '--apply']).error != null);
  check('аргументы: без движка — ошибка, кроме режима --body', rb.parseArgs([]).error != null && rb.parseArgs(['--body', 'x.json']).error == null);

  // CLI: неверный вызов даёт код 1 и подсказку, --body печатает тело из файла результата.
  const bad = run('tools/runtime-bump.mjs', []);
  check('CLI без движка — код 1 и подсказка', bad.code === 1 && bad.out.includes('--engine'), `${bad.code}: ${bad.out.slice(0, 120)}`);
  writeBytes('bump-root/bump.json', JSON.stringify(checked));
  const bodyRun = run('tools/runtime-bump.mjs', ['--body', join(root, 'bump.json')]);
  check('CLI --body печатает тело PR', bodyRun.code === 0 && bodyRun.out.includes('0.2.79'), bodyRun.out.slice(0, 120));
}
```

Функция `run(script, args)` в тестах уже есть (используется для `validate-package.mjs`): убедиться по `grep -n "^function run" tests/run-tests.mjs`; если сигнатура иная — подстроить вызовы.

- [ ] **Step 2: Прогнать, увидеть падение**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "rb.bump|провалено" | head -2`
Expected: `TypeError: rb.bump is not a function`.

- [ ] **Step 3: Реализация**

Дописать в `tools/runtime-bump.mjs`:

```js
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
    else if (a === '--check') { out.mode = 'check'; modes++; }
    else if (a === '--apply') { out.mode = 'apply'; modes++; }
    else if (a === '--json') out.json = true;
    else if (a === '--body') out.body = argv[++i] || null;
    else if (a === '--sentinel') out.sentinel = argv[++i] || null;
    else { out.error = `неизвестный аргумент ${a}`; return out; }
  }
  if (modes > 1) out.error = '--check и --apply взаимоисключающие';
  else if (out.body) { if (!existsSync(out.body)) out.error = `файл результата не найден: ${out.body}`; }
  else if (!out.engine) out.error = 'нужен --engine analyzer|platform-context';
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
  else if (!result.ok) out(`${result.name || args.engine}: отказ — ${result.reason}${result.missing ? ' (' + result.missing.join(', ') + ')' : ''}${result.error ? ': ' + result.error : ''}`);
  else if (result.upToDate) out(`${result.name}: закреплено ${result.current}, у автора ${result.latest} — обновления нет`);
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
```

- [ ] **Step 4: Прогнать тесты и validate-package**

Run: `node tests/run-tests.mjs 2>&1 | tail -3 && node tools/validate-package.mjs | tail -1`
Expected: `провалено: 0`, `Ошибок: 0`.

- [ ] **Step 5: Живая проверка `--check` по обоим движкам (сеть)**

Run:
```bash
node tools/runtime-bump.mjs --engine analyzer --check; echo "код $?"
node tools/runtime-bump.mjs --engine platform-context --check; echo "код $?"
```
Expected: обе строки вида `…: закреплено X, у автора Y — обновление есть`, код 3. Если GitHub API отдал 403 по лимиту, повторить с `GITHUB_TOKEN=$(gh auth token)`.

- [ ] **Step 6: Commit**

```bash
git add tools/runtime-bump.mjs tests/run-tests.mjs
git commit -m "feat(закрепление): прогон bump, тело PR и CLI runtime-bump

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: validate-package сверяет фразы INSTALL.md с манифестами

**Files:**
- Modify: `tools/validate-package.mjs` (после цикла проверки JSON, строка ~215)
- Test: `tests/run-tests.mjs` (секция «Валидатор пакета — состав компонентов», тот же испорченный пакет)

**Interfaces:**
- Consumes: `ENGINES` из `tools/runtime-bump.mjs`.

- [ ] **Step 1: Падающий тест**

В секции «Валидатор пакета — состав компонентов» перед `const r = run('tools/validate-package.mjs', ['--root', pkg]);` добавить фикстуры:

```js
  writeBytes('pkg-broken/assets/analyzer/runtime-manifest.json', JSON.stringify({ engine: 'bsl-analyzer', version: '0.2.79', repo: 'itrous/bsl-analyzer', urlTemplate: 'https://github.com/{repo}/releases/download/v{version}/{asset}', targets: {} }));
  writeBytes('pkg-broken/assets/platform-context/runtime-manifest.json', JSON.stringify({ engine: 'bsl-context', version: '0.18.1', repo: 'Regsorm/bsl-context', urlTemplate: 'https://github.com/{repo}/releases/download/v{version}/{asset}', targets: {} }));
  writeBytes('pkg-broken/docs/INSTALL.md', 'проверено на **0.2.73**\nengine=bsl-context@0.18.1/8.3.27.1688\n');
```

и после существующих проверок:

```js
  check('INSTALL.md отстал от манифеста анализатора — ошибка',
    r.out.includes('INSTALL.md') && r.out.includes('проверено на **0.2.79**'), r.out.trim().slice(0, 300));
  check('INSTALL.md, совпадающий с манифестом сервера справки, не ругается',
    !r.out.includes('engine=bsl-context@0.18.1/'), r.out.trim().slice(0, 300));
```

- [ ] **Step 2: Прогнать, увидеть падение**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "INSTALL.md отстал|провалено"`
Expected: `FAIL INSTALL.md отстал от манифеста анализатора — ошибка`.

- [ ] **Step 3: Реализация**

В `tools/validate-package.mjs` добавить импорт `import { ENGINES } from './runtime-bump.mjs';` и после цикла проверки JSON-файлов:

```js
// Фразы INSTALL.md о текущем закреплении обязаны совпадать с манифестами: сдвиг закрепления
// (runtime-bump.mjs) правит их сам, а правка манифеста руками — нет, и документ отстаёт молча.
{
  const installPath = join(ROOT, 'docs', 'INSTALL.md');
  if (existsSync(installPath)) {
    const install = readFileSync(installPath, 'utf8');
    for (const [engine, spec] of Object.entries(ENGINES)) {
      const manifestPath = join(ROOT, spec.manifest);
      if (!existsSync(manifestPath)) continue;
      const version = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
      for (const [phrase] of spec.installPhrases(version, version)) {
        if (!install.includes(phrase)) {
          fail('docs/INSTALL.md', `нет фразы о текущем закреплении ${engine}: ожидалось «${phrase}» (версия из ${spec.manifest}); поправьте документ или прогоните runtime-bump.mjs --apply`);
        }
      }
    }
  }
}
```

- [ ] **Step 4: Прогнать тесты и validate-package на самом пакете**

Run: `node tests/run-tests.mjs 2>&1 | tail -3 && node tools/validate-package.mjs | tail -1`
Expected: `провалено: 0`, `Ошибок: 0` (INSTALL.md сейчас содержит обе фразы; если нет — это дефект документа, поправить).

- [ ] **Step 5: Commit**

```bash
git add tools/validate-package.mjs tests/run-tests.mjs
git commit -m "feat(пакет): INSTALL.md сверяется с манифестами закрепления

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `--install-only` у бутстрапа сервера справки

**Files:**
- Modify: `tools/platform-context-bootstrap.mjs` (шапка «Использование» и `main`, перед веткой `--platforms`)
- Test: `tests/run-tests.mjs` (секция «Самозаведение контура платформенного API», рядом с тестами `--status`)

**Interfaces:**
- Produces: CLI-режим `--install-only`: только `install()`, без поиска платформы и запуска демона; код 0, при неудаче 2.

- [ ] **Step 1: Падающий тест**

```js
  // --install-only нужен CI сдвига закрепления: на раннере нет платформы 1С, а скачать
  // архив, сверить сумму и распаковать можно и без неё. Проверяется на готовой установке:
  // сеть в тестах запрещена, а ветка «уже установлен» проходит тот же путь до скачивания.
  {
    const dataDir = join(WORK, 'pc-install-only');
    const fakeMan = boot.readManifest();
    const bin = boot.binaryPath(fakeMan, dataDir);
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, 'не бинарник', 'utf8');
    writeFileSync(join(dirname(bin), '.ready'), JSON.stringify({ version: fakeMan.version, sha256: fakeMan.targets[boot.targetKey()].sha256 }), 'utf8');
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'platform-context-bootstrap.mjs'), '--install-only'], {
      encoding: 'utf8',
      env: { ...process.env, QG_DATA_DIR: dataDir },
    });
    check('--install-only на готовой установке: код 0 и путь', r.status === 0 && r.stdout.includes('Уже установлен'), `${r.status}: ${r.stdout}${r.stderr}`.slice(0, 200));
    check('--install-only не поднимает демон и не ищет платформу', !r.stdout.includes('Готово:') && !r.stderr.includes('Контур не заведён'));
  }
```

Разместить внутри блока, где уже импортирован `boot` для `platform-context-bootstrap.mjs`.

- [ ] **Step 2: Прогнать, увидеть падение**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "install-only|провалено"`
Expected: `FAIL --install-only на готовой установке...` (без флага скрипт идёт в `ensureServer` и падает на отсутствии конфига проекта либо платформы).

- [ ] **Step 3: Реализация**

В шапке `platform-context-bootstrap.mjs` в блок «Использование» добавить строку:

```
 *   node tools/platform-context-bootstrap.mjs --install-only  # скачать и распаковать, демон не поднимать (CI)
```

В `main` перед `if (args.includes('--platforms'))`:

```js
  if (args.includes('--install-only')) {
    const r = await install(manifest, { root, force: args.includes('--force'), log: out });
    if (!r.ok) {
      process.stderr.write(`Установка не удалась: ${r.reason}${r.status ? ' (HTTP ' + r.status + ')' : ''}\n`);
      return 2;
    }
    if (!r.downloaded) out(`Уже установлен: ${r.path}`);
    return 0;
  }
```

- [ ] **Step 4: Прогнать тесты**

Run: `node tests/run-tests.mjs 2>&1 | tail -3`
Expected: `провалено: 0`.

- [ ] **Step 5: Commit**

```bash
git add tools/platform-context-bootstrap.mjs tests/run-tests.mjs
git commit -m "feat(контекст платформы): режим --install-only для CI без платформы

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Workflow `runtime-bump.yml`

**Files:**
- Create: `.github/workflows/runtime-bump.yml`
- Test: `tests/run-tests.mjs` (новая секция «Workflow сдвига закрепления»)

**Interfaces:**
- Consumes: CLI `runtime-bump.mjs` (`--check --json` → код 3 при обновлении; `--apply --json`; `--body`), `analyzer-bootstrap.mjs`, `analyzer-run.mjs --sentinel`, `platform-context-bootstrap.mjs --install-only`.

- [ ] **Step 1: Падающий тест на состав файла**

```js
// ---------------------------------------------------------------------------
section('Workflow сдвига закрепления');

// YAML не исполняется в тестах; проверяется то, что теряется молча при правке: расписание,
// ручной запуск, права на PR, назначение на владельца и повторный запрос ревью.
{
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'runtime-bump.yml'), 'utf8');
  check('workflow: расписание и ручной запуск', wf.includes('schedule:') && wf.includes('workflow_dispatch:'));
  check('workflow: права на ветку и PR', wf.includes('contents: write') && wf.includes('pull-requests: write'));
  check('workflow: матрица по двум движкам', wf.includes('engine: [analyzer, platform-context]'));
  check('workflow: проверка через --check с кодом 3', wf.includes('--check --json') && wf.includes('-eq 3'));
  check('workflow: часовой анализатора и install-only сервера справки', wf.includes('analyzer-run.mjs --sentinel') && wf.includes('--install-only'));
  check('workflow: те же проверки, что validate.yml', wf.includes('validate-package.mjs') && wf.includes('tests/run-tests.mjs') && wf.includes('gen-catalog-index.mjs --check'));
  check('workflow: PR на владельца с запросом ревью', wf.includes('--assignee "$OWNER"') && wf.includes('--reviewer "$OWNER"') && wf.includes('github.repository_owner'));
  check('workflow: открытый PR обновляется, а не дублируется', wf.includes('gh pr list --head') && wf.includes('gh pr edit'));
  check('workflow: ветка на движок', wf.includes('chore/bump-'));
  check('workflow: подсказка про настройку репозитория при отказе создать PR', wf.includes('create and approve pull requests'));
}
```

- [ ] **Step 2: Прогнать, увидеть падение**

Run: `node tests/run-tests.mjs 2>&1 | grep -E "ENOENT.*runtime-bump.yml|провалено" | head -2`
Expected: ошибка чтения `.github/workflows/runtime-bump.yml`.

- [ ] **Step 3: Создать workflow**

`.github/workflows/runtime-bump.yml`:

```yaml
name: runtime-bump

# Сдвиг закрепления внешних движков (bsl-analyzer, bsl-context) — через PR, а не
# самообновлением у пользователя: движок, меняющийся между прогонами, делает вердикт гейта
# невоспроизводимым (docs/INSTALL.md). Здесь новая версия проходит те же проверки, что
# validate.yml, и приходит владельцу как PR с запросом ревью.
# Спецификация — docs/superpowers/specs/2026-09-12-runtime-bump-design.md, порядок ревью —
# docs/RELEASING.md, раздел «Сдвиг закрепления движков».
#
# PR, открытый штатным GITHUB_TOKEN, не запускает validate.yml — поэтому проверки прогоняются
# здесь же, до создания PR. Личный токен снял бы ограничение, но GitHub не уведомляет автора о
# его собственных действиях, и уведомление о PR пропало бы.

on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:
    inputs:
      engine:
        description: "Какой движок проверять"
        type: choice
        options: [both, analyzer, platform-context]
        default: both

permissions:
  contents: write
  pull-requests: write

jobs:
  bump:
    strategy:
      fail-fast: false
      matrix:
        engine: [analyzer, platform-context]
    # Ручной запуск с выбором одного движка: второе задание матрицы завершается сразу.
    if: ${{ github.event_name == 'schedule' || inputs.engine == 'both' || inputs.engine == matrix.engine }}
    runs-on: ubuntu-latest
    env:
      GITHUB_TOKEN: ${{ github.token }}
      GH_TOKEN: ${{ github.token }}
      OWNER: ${{ github.repository_owner }}

    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: "20"

      - uses: actions/setup-python@v7
        with:
          python-version: "3.12"

      - name: Зависимости валидаторов XML
        run: pip install --disable-pip-version-check "lxml==6.1.1"

      - name: Есть ли релиз новее закреплённого
        id: check
        run: |
          set +e
          node tools/runtime-bump.mjs --engine "${{ matrix.engine }}" --check --json | tee check.json
          code=${PIPESTATUS[0]}
          set -e
          if [ "$code" -eq 3 ]; then
            echo "update=yes" >> "$GITHUB_OUTPUT"
          elif [ "$code" -eq 0 ]; then
            echo "update=no" >> "$GITHUB_OUTPUT"
          else
            echo "::error::runtime-bump --check завершился с кодом $code"
            exit "$code"
          fi

      - name: Переписать манифест и INSTALL.md
        if: steps.check.outputs.update == 'yes'
        run: node tools/runtime-bump.mjs --engine "${{ matrix.engine }}" --apply --json | tee bump.json

      # Анализатор: бинарник скачивается по новому манифесту, сумма сверяется, часовой на
      # фикстуре плагина обязан найти свою диагностику. Платформа 1С для этого не нужна.
      - name: Анализатор скачивается, сумма сходится, часовой найден
        if: steps.check.outputs.update == 'yes' && matrix.engine == 'analyzer'
        run: |
          node tools/analyzer-bootstrap.mjs
          node tools/analyzer-run.mjs --sentinel | tee sentinel.txt

      # Сервер справки: скачать, сверить сумму, распаковать. Запустить его без установленной
      # платформы нельзя — об этом сказано в теле PR.
      - name: Сервер справки скачивается, сумма сходится, архив распаковывается
        if: steps.check.outputs.update == 'yes' && matrix.engine == 'platform-context'
        run: node tools/platform-context-bootstrap.mjs --install-only

      - name: Целостность пакета
        if: steps.check.outputs.update == 'yes'
        run: node tools/validate-package.mjs

      - name: Индекс каталога антипаттернов синхронен с карточками
        if: steps.check.outputs.update == 'yes'
        run: node tools/gen-catalog-index.mjs --check

      - name: Тесты программных проверок
        if: steps.check.outputs.update == 'yes'
        run: node tests/run-tests.mjs

      - name: Ветка и PR на владельца
        if: steps.check.outputs.update == 'yes'
        run: |
          NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('bump.json','utf8')).name)")
          CURRENT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('bump.json','utf8')).current)")
          LATEST=$(node -e "console.log(JSON.parse(require('fs').readFileSync('bump.json','utf8')).latest)")
          BRANCH="chore/bump-$NAME"
          TITLE="chore(закрепление): $NAME $CURRENT → $LATEST"

          node tools/runtime-bump.mjs --body bump.json --sentinel sentinel.txt > body.md

          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          # Ветка принадлежит workflow и пересобирается от main при каждом прогоне; ручных
          # коммитов в ней не ожидается. Ссылку на удалённую ветку дотягиваем, чтобы
          # --force-with-lease имел с чем сверяться.
          git fetch origin "$BRANCH" || true
          git checkout -B "$BRANCH"
          git add assets docs/INSTALL.md
          git commit -m "$TITLE" -m "Собрано workflow runtime-bump. Проверки: см. тело PR."
          git push --force-with-lease origin "$BRANCH"

          EXISTING=$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number')
          if [ -n "$EXISTING" ]; then
            gh pr edit "$EXISTING" --title "$TITLE" --body-file body.md
            gh pr edit "$EXISTING" --add-reviewer "$OWNER"
            gh pr comment "$EXISTING" --body "Обновлено: $CURRENT → $LATEST, проверки прогнаны заново."
            echo "PR #$EXISTING обновлён"
          else
            if ! gh pr create --base main --head "$BRANCH" --title "$TITLE" --body-file body.md --assignee "$OWNER" --reviewer "$OWNER"; then
              echo "::error::Не удалось создать PR. Проверьте Settings → Actions → General → «Allow GitHub Actions to create and approve pull requests»."
              exit 1
            fi
          fi
```

- [ ] **Step 4: Прогнать тесты и validate-package**

Run: `node tests/run-tests.mjs 2>&1 | tail -3 && node tools/validate-package.mjs | tail -1`
Expected: `провалено: 0`, `Ошибок: 0`.

- [ ] **Step 5: Проверить синтаксис YAML**

Run: `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/runtime-bump.yml', encoding='utf-8')); print('YAML ok')"`
Expected: `YAML ok`. Если модуля `yaml` нет: `pip install pyyaml` и повторить.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/runtime-bump.yml tests/run-tests.mjs
git commit -m "feat(ci): workflow сдвига закрепления движков с PR на владельца

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Документация и завершение

**Files:**
- Modify: `docs/RELEASING.md` (новый раздел перед «Что в релиз не кладётся»)
- Modify: `docs/INSTALL.md` (раздел «Обновление анализатора», после таблицы поверхностей; раздел про bsl-context после строки про штамп `engine=bsl-context@…`)
- Modify: `README.md`, строка таблицы раскладки `| [.github/workflows/](.github/workflows/validate.yml) | CI: проверка на каждый push и выпуск релиза по тегу |` → `| [.github/workflows/](.github/workflows/) | CI: проверка на каждый push, выпуск релиза по тегу, еженедельный сдвиг закрепления движков через PR |`.

- [ ] **Step 1: Раздел в RELEASING.md**

Перед `## Что в релиз не кладётся`:

```markdown
## Сдвиг закрепления движков

Версии `bsl-analyzer` и `bsl-context` закреплены в `assets/*/runtime-manifest.json` и
сдвигаются PR, а не самообновлением у пользователя: движок, меняющийся между прогонами,
делает вердикт невоспроизводимым. Разбор — `docs/superpowers/specs/2026-09-12-runtime-bump-design.md`.

Workflow `runtime-bump` раз в неделю (и по кнопке «Run workflow») сравнивает закрепление с
последним релизом автора. Есть новее — переписывает манифест и фразы INSTALL.md
(`node tools/runtime-bump.mjs --engine <движок> --apply`), прогоняет проверки и открывает
PR в ветке `chore/bump-<движок>` с назначением на владельца и запросом ревью. Открытый PR
при следующем релизе обновляется, а не дублируется.

Разовая настройка репозитория, без которой создание PR падает: Settings → Actions →
General → «Allow GitHub Actions to create and approve pull requests».

Что делает ревьюер такого PR:

| Движок | Проверка | Где |
|---|---|---|
| `bsl-analyzer` | A/B на корпусе: находки те же или расхождения разобраны | `docs/false-positives-cfe.md`, раздел перехода |
| `bsl-analyzer` | состав диагностик `rules list`: новые, переименованные, исчезнувшие | таблица алиасов в `tools/analyzer-run.mjs`, `assets/analyzer/` |
| `bsl-context` | сервер поднимается и отвечает на машине с платформой | `node tools/platform-context-bootstrap.mjs --status` |
| оба | упоминания старой версии из тела PR: пример следа можно оставить, утверждение о закреплении — нет | по списку в PR |

Сдвиг закрепления при тех же находках — PATCH по таблице выше; изменившиеся находки —
MINOR с разделом перехода в `false-positives-cfe.md`.

Локально, без workflow: `node tools/runtime-bump.mjs --engine analyzer --check` говорит,
есть ли новее (код 3), `--apply` переписывает. Проверка после сдвига та же, что в workflow.
```

- [ ] **Step 2: Фразы в INSTALL.md**

После таблицы в разделе «Обновление анализатора» добавить абзац:

```markdown
Закрепление сдвигается автоматически: workflow `runtime-bump` раз в неделю сверяет манифест с
релизами автора и открывает PR с новой версией и суммами. Самообновления у пользователя нет
намеренно, см. выше про лаунчер; порядок ревью такого PR — `RELEASING.md`.
```

После абзаца со штампом `engine=bsl-context@0.16.0/8.3.27.1688` (раздел про сервер справки) добавить:

```markdown
Закреплённая версия сервера сдвигается тем же workflow `runtime-bump`, что и анализатор:
PR с новой версией и суммами, решение за ревью.
```

- [ ] **Step 3: Прогнать всё, что гоняет CI**

Run:
```bash
node tests/run-tests.mjs 2>&1 | tail -3
node tools/validate-package.mjs | tail -1
node tools/gen-catalog-index.mjs --check
```
Expected: `провалено: 0`, `Ошибок: 0, предупреждений: 0`, индекс синхронен.

- [ ] **Step 4: Commit**

```bash
git add docs/RELEASING.md docs/INSTALL.md
git commit -m "docs(закрепление): порядок сдвига закрепления и ревью PR

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Отправить ветку и открыть PR**

```bash
git push -u origin feat/runtime-bump
gh pr create --base main --title "feat(закрепление): автоматический сдвиг закрепления движков через PR" --body-file - <<'EOF'
Скрипт `tools/runtime-bump.mjs` и workflow `runtime-bump`: раз в неделю сверяют закрепление bsl-analyzer и bsl-context с релизами авторов, переписывают манифесты и открывают PR на владельца с запросом ревью. Самообновления у пользователя нет: вердикт остаётся воспроизводимым.

Спецификация: `docs/superpowers/specs/2026-09-12-runtime-bump-design.md`.

После влития нужна разовая настройка: Settings → Actions → General → «Allow GitHub Actions to create and approve pull requests». Затем «Run workflow» у `runtime-bump` — он откроет два PR сдвига (0.2.73 → 0.2.79 и 0.16.0 → 0.18.1).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 6: Дождаться CI**

Run: `gh pr checks --watch`
Expected: все задания `validate` зелёные на всей матрице.
