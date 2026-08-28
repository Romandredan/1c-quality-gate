#!/usr/bin/env node
/**
 * Прямые тесты ядра механики гейта (hooks/gate-core.mjs): классификация файлов 1С,
 * взвод и чтение состояния, тексты сообщений обоих харнессов.
 *
 * Ядро — единый источник логики для хуков Claude Code и плагина OpenCode, поэтому
 * проверяется напрямую, а не только через обёртки.
 * Запуск: node tests/gate-core.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyFile,
  toProjectRelative,
  readPendingState,
  armGate,
  gateHint,
  blockMessage,
} from '../hooks/gate-core.mjs';
import { stateDirSegments } from '../tools/state-dir.mjs';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`ok — ${name}`); }
  else { failed++; console.error(`FAIL — ${name}`); }
}

const root = mkdtempSync(join(tmpdir(), 'qg-core-test-'));

// --- classifyFile: BSL ---
check('.bsl — bsl', classifyFile(join(root, 'src', 'CommonModules', 'М', 'Module.bsl')) === 'bsl');
check('.os — bsl', classifyFile(join(root, 'x.os')) === 'bsl');

// --- classifyFile: формат EDT ---
check('.mdo — metadata-xml', classifyFile(join(root, 'src', 'Catalogs', 'Товары', 'Товары.mdo')) === 'metadata-xml');
check('.form внутри src — metadata-xml', classifyFile(join(root, 'src', 'Catalogs', 'Товары', 'Forms', 'Форма', 'Form.form')) === 'metadata-xml');
check('.form вне src — не 1С', classifyFile(join(root, 'web', 'login.form')) === null);
check('.form в корне — не 1С', classifyFile(join(root, 'a.form')) === null);

// --- classifyFile: выгрузки конфигуратора ---
check('Configuration.xml — metadata-xml', classifyFile(join(root, 'dump', 'Configuration.xml')) === 'metadata-xml');
check('cf/ — metadata-xml', classifyFile(join(root, 'cf', 'Catalogs', 'Товары.xml')) === 'metadata-xml');
check('cfe/ — metadata-xml', classifyFile(join(root, 'ext', 'cfe', 'Documents', 'Заказ.xml')) === 'metadata-xml');
check('src/<Имя>/Catalogs — metadata-xml', classifyFile(join(root, 'src', 'MyConf', 'Catalogs', 'Товары.xml')) === 'metadata-xml');
check('src/Catalogs напрямую (EDT) — metadata-xml', classifyFile(join(root, 'src', 'Catalogs', 'Товары.xml')) === 'metadata-xml');

// --- classifyFile: dump-root требует Configuration.xml на диске ---
const dumpRoot = join(root, 'plaindump');
mkdirSync(join(dumpRoot, 'Catalogs'), { recursive: true });
check('Catalogs/ без Configuration.xml рядом — не 1С', classifyFile(join(dumpRoot, 'Catalogs', 'Товары.xml')) === null);
writeFileSync(join(dumpRoot, 'Configuration.xml'), '<Configuration/>\n', 'utf8');
check('Catalogs/ с Configuration.xml рядом — metadata-xml', classifyFile(join(dumpRoot, 'Catalogs', 'Товары.xml')) === 'metadata-xml');

// --- classifyFile: чужие проекты молчат ---
check('чужой src/ (Java) — не 1С', classifyFile(join(root, 'src', 'main', 'resources', 'app.xml')) === null);
check('обычный documents/ — не 1С', classifyFile(join(root, 'documents', 'readme.xml')) === null);
check('не-XML — не 1С', classifyFile(join(root, 'src', 'main.py')) === null);

// --- toProjectRelative ---
check('путь внутри корня — относительный', toProjectRelative(root, join(root, 'a', 'b.bsl')) === join('a', 'b.bsl').replace(/\\/g, '/'));
check('путь вне корня — исходный', toProjectRelative(root, join(tmpdir(), 'elsewhere.bsl')) === join(tmpdir(), 'elsewhere.bsl').replace(/\\/g, '/'));
check('относительный вход — как есть', toProjectRelative(root, 'src/x.bsl') === 'src/x.bsl');

// --- armGate / readPendingState: каталог состояния через env ---
const env = { QG_STATE_DIR: '.custom/.state' };
const bsl = join(root, 'src', 'CommonModules', 'М', 'Module.bsl');
mkdirSync(join(root, 'src', 'CommonModules', 'М'), { recursive: true });
writeFileSync(bsl, 'Процедура Т() КонецПроцедуры\n', 'utf8');

const armed = armGate({ root, filePath: bsl, sessionId: 'sess-1', env });
check('armGate взвёл .bsl', armed && armed.kind === 'bsl');
check('маркер в каталоге из QG_STATE_DIR', existsSync(join(root, '.custom', '.state', 'qg-pending.json')));
check('умолчательный .claude/.state не создан', !existsSync(join(root, '.claude')));

const armed2 = armGate({ root, filePath: bsl, sessionId: 'sess-1', env });
check('повторная правка увеличивает edits', armed2 && readPendingState(root, env).sessions['sess-1'].files[armed.rel].edits === 2);

check('armGate молчит на не-1С файле', armGate({ root, filePath: join(root, 'notes.txt'), sessionId: 'sess-1', env }) === null);

// Сессии разделены.
armGate({ root, filePath: bsl, sessionId: 'sess-2', env });
const state = readPendingState(root, env);
check('состояние разделено по сессиям', Object.keys(state.sessions).length === 2);

// Умолчание без env — .claude/.state.
const root2 = mkdtempSync(join(tmpdir(), 'qg-core-def-'));
armGate({ root: root2, filePath: bsl, sessionId: 's', env: {} });
check('умолчание каталога состояния — .claude/.state', existsSync(join(root2, '.claude', '.state', 'qg-pending.json')));

// --- stateDirSegments: абсолютный QG_STATE_DIR отвергается в пользу умолчания ---
// `C:\state` после разбора на сегменты дал бы ['C:', 'state'] под корнем
// проекта: мусор вместо каталога, поэтому такое значение игнорируется.
check('абсолютный POSIX QG_STATE_DIR (/abs/state) отвергается',
  JSON.stringify(stateDirSegments({ QG_STATE_DIR: '/abs/state' })) === JSON.stringify(['.claude', '.state']));
check('абсолютный Windows QG_STATE_DIR (C:\\state) отвергается',
  JSON.stringify(stateDirSegments({ QG_STATE_DIR: 'C:\\state' })) === JSON.stringify(['.claude', '.state']));
check('UNC QG_STATE_DIR (\\\\srv\\state) отвергается',
  JSON.stringify(stateDirSegments({ QG_STATE_DIR: '\\\\srv\\state' })) === JSON.stringify(['.claude', '.state']));
check('относительный QG_STATE_DIR (.opencode/.state) по-прежнему работает',
  JSON.stringify(stateDirSegments({ QG_STATE_DIR: '.opencode/.state' })) === JSON.stringify(['.opencode', '.state']));

// --- readPendingState: специальные состояния ---
check('нет маркера — null', readPendingState(mkdtempSync(join(tmpdir(), 'qg-core-empty-')), {}) === null);

const legacyRoot = mkdtempSync(join(tmpdir(), 'qg-core-legacy-'));
mkdirSync(join(legacyRoot, '.claude', '.state'), { recursive: true });
writeFileSync(join(legacyRoot, '.claude', '.state', 'qg-pending.json'), JSON.stringify({ armedAt: 't', files: { 'a.bsl': { kind: 'bsl', edits: 1 } } }), 'utf8');
const legacy = readPendingState(legacyRoot, {});
check('старый формат поднимается до сессионного', legacy?.sessions?.legacy?.files?.['a.bsl']?.kind === 'bsl');

writeFileSync(join(legacyRoot, '.claude', '.state', 'qg-pending.json'), '{битый', 'utf8');
check('повреждённый маркер — corrupt', readPendingState(legacyRoot, {})?.corrupt === true);

// --- gateHint: режимы харнессов ---
const hintC = gateHint({ kind: 'bsl', rel: 'a.bsl', packageRoot: root, mode: 'claude' });
const hintO = gateHint({ kind: 'bsl', rel: 'a.bsl', packageRoot: root, mode: 'opencode' });
check('подсказка claude обещает блокировку', hintC.includes('Завершение сессии заблокировано'));
check('подсказка opencode честна про мягкий гейт', hintO.includes('мягк') === false && hintO.includes('возвращать тебя к работе'));
check('подсказка opencode не обещает блокировку', !hintO.includes('Завершение сессии заблокировано'));
const hintXml = gateHint({ kind: 'metadata-xml', rel: 'x.xml', packageRoot: root, mode: 'claude' });
check('подсказка metadata-xml упоминает Configuration.mdo (EDT)', hintXml.includes('Configuration.mdo'));

// --- blockMessage: режимы и повторы ---
const files = [['a.bsl', { kind: 'bsl' }], ['src/Catalogs/Т.xml', { kind: 'metadata-xml' }]];
const bmC = blockMessage({ sessionId: 's1', files, packageRoot: root, mode: 'claude', repeated: 0 });
check('claude: заголовок блокировки', bmC.includes('ЗАВЕРШЕНИЕ ЗАБЛОКИРОВАНО'));
check('claude: без --session в команде release', !bmC.includes('release --session'));
const bmCr = blockMessage({ sessionId: 's1', files, packageRoot: root, mode: 'claude', repeated: 1 });
check('claude: повторная попытка добавляет прямой путь', bmCr.includes('повторная попытка') && bmCr.includes('release --session s1'));
const bmO = blockMessage({ sessionId: 's1', files, packageRoot: root, mode: 'opencode', repeated: 2, maxReprompts: 3 });
check('opencode: заголовок без блокировки', bmO.includes('РАБОТА НЕ ЗАВЕРШЕНА') && !bmO.includes('ЗАВЕРШЕНИЕ ЗАБЛОКИРОВАНО'));
check('opencode: release с --session', bmO.includes('release --session s1'));
check('opencode: номер возврата из лимита', bmO.includes('№2 из 3'));
const bmF = blockMessage({ sessionId: 's1', files, foreign: 3, packageRoot: root, mode: 'opencode', repeated: 0 });
check('чужие правки: предупреждение не трогать', bmF.includes('другой сессии (3)') && bmF.includes('НЕ трогай'));

rmSync(root, { recursive: true, force: true });
rmSync(root2, { recursive: true, force: true });
rmSync(legacyRoot, { recursive: true, force: true });

console.log(`\n${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
