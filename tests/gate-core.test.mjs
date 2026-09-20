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
import { join, sep } from 'node:path';
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

// --- armGate: файл вне корня проекта ---
// Ключ состояния для такого файла — абсолютный путь (относительный через «..» нестабилен),
// а взвод обязан сообщить об этом наружу: часть контуров по чужому файлу не работает,
// и узнать это модель должна при взводе, а не при отклонении следа.
const outsideDir = mkdtempSync(join(tmpdir(), 'qg-core-outside-'));
const outsideFile = join(outsideDir, 'Module.bsl');
const armedOut = armGate({ root, filePath: outsideFile, sessionId: 'sess-1', env });
check('файл вне корня взводится', Boolean(armedOut));
check(
  'ключ состояния — абсолютный путь файла',
  armedOut.rel.toLowerCase() === String(outsideFile).split(sep).join('/').toLowerCase()
);
check('взвод сообщает, что файл вне корня', armedOut.outside === true);
const armedIn = armGate({ root, filePath: bsl, sessionId: 'sess-1', env });
check('файл в корне не помечается как внешний', !armedIn.outside);

// --- gateHint: режимы харнессов ---
const hintC = gateHint({ kind: 'bsl', rel: 'a.bsl', packageRoot: root, mode: 'claude' });
const hintO = gateHint({ kind: 'bsl', rel: 'a.bsl', packageRoot: root, mode: 'opencode' });
check('подсказка claude обещает блокировку', hintC.includes('Завершение сессии заблокировано'));
check('подсказка opencode честна про мягкий гейт', hintO.includes('мягк') === false && hintO.includes('возвращать тебя к работе'));
check('подсказка opencode не обещает блокировку', !hintO.includes('Завершение сессии заблокировано'));
const hintXml = gateHint({ kind: 'metadata-xml', rel: 'x.xml', packageRoot: root, mode: 'claude' });
check('подсказка metadata-xml упоминает Configuration.mdo (EDT)', hintXml.includes('Configuration.mdo'));
// Task 14: подсказка называет план прогона literal-путём — до первого разрешения `$QG` в
// сессии модель иначе не знает, чем именно запустить `gate.mjs plan`.
check('подсказка называет план прогона', hintC.includes('gate.mjs" plan') && hintXml.includes('gate.mjs" plan'));
const hintOut = gateHint({ ...armedOut, sessionId: 'sess-1', packageRoot: root, mode: 'claude' });
check('подсказка про файл вне корня заявлена', hintOut.includes('вне корня'));
check('подсказка называет судьбу проектных проверок', hintOut.includes('not_verified'));
check('обычная подсказка про границы молчит', !hintC.includes('вне корня'));
// Идентификатор сессии модель узнаёт здесь и только здесь до первого блока Stop-хука:
// без него при нескольких сессиях verify/release отказывают.
const hintS = gateHint({ kind: 'bsl', rel: 'a.bsl', sessionId: 'sess-1', packageRoot: root, mode: 'claude' });
check('подсказка claude называет сессию', hintS.includes('Сессия: sess-1'));
const hintSO = gateHint({ kind: 'bsl', rel: 'a.bsl', sessionId: 'sess-1', packageRoot: root, mode: 'opencode' });
check('подсказка opencode называет сессию', hintSO.includes('Сессия: sess-1'));

// --- blockMessage: режимы и повторы ---
const files = [['a.bsl', { kind: 'bsl' }], ['src/Catalogs/Т.xml', { kind: 'metadata-xml' }]];
const bmC = blockMessage({ sessionId: 's1', files, packageRoot: root, mode: 'claude', repeated: 0 });
check('claude: заголовок блокировки', bmC.includes('ЗАВЕРШЕНИЕ ЗАБЛОКИРОВАНО'));
// Команда обязана срабатывать и при нескольких сессиях, когда без --session утилита отказывает.
check('claude: команда release содержит --session', bmC.includes('release --session s1'));
const bmCr = blockMessage({ sessionId: 's1', files, packageRoot: root, mode: 'claude', repeated: 1 });
check('claude: повторная попытка добавляет прямой путь', bmCr.includes('повторная попытка') && bmCr.includes('release --session s1'));
const bmO = blockMessage({ sessionId: 's1', files, packageRoot: root, mode: 'opencode', repeated: 2, maxReprompts: 3 });
check('opencode: заголовок без блокировки', bmO.includes('РАБОТА НЕ ЗАВЕРШЕНА') && !bmO.includes('ЗАВЕРШЕНИЕ ЗАБЛОКИРОВАНО'));
check('opencode: release с --session', bmO.includes('release --session s1'));
check('opencode: номер возврата из лимита', bmO.includes('№2 из 3'));
// Передача проверки субагенту. Замер живых прогонов: гейт — это десятки ходов основной модели,
// и каждый заново оплачивает контекст длинной сессии. Сообщение блокировки поэтому велит не
// гнать гейт самому, а запустить субагента и отдать ему описание работы по закрытому перечню:
// он не видит сессии ни строчкой, и пропущенный пункт перечня ему взять неоткуда.
for (const [mode, bm] of [['claude', bmC], ['opencode', bmO]]) {
  check(`${mode}: проверку исполняет субагент gate-runner`, /gate-runner/.test(bm));
  check(`${mode}: основной модели запрещено гнать гейт самой`, /НЕ прогоняй гейт сам/.test(bm));
  check(`${mode}: служебные данные подставлены — сессия и каталог плагина`,
    bm.includes('Сессия гейта: s1') && /Каталог плагина: .+/.test(bm));
  for (const [needle, label] of [
    ['1. Задача', 'задача дословно'],
    ['2. Что изменено и почему именно так', 'решения и отвергнутые альтернативы'],
    ['3. Инварианты', 'инварианты'],
    ['4. Что сознательно не сделано', 'что за рамками'],
    ['5. Что проверено вживую', 'проверенное и непроверенное'],
    ['6. Сомнения', 'сомнения автора'],
    ['7. Пути к спецификации', 'пути к спецификации и плану'],
  ]) check(`${mode}: перечень описания — ${label}`, bm.includes(needle));
  check(`${mode}: сомнения нельзя оставить пустыми`, /назови хотя бы слабейшее место/.test(bm));
  check(`${mode}: самооценка запрещена`, /Не оценивай свою работу/.test(bm));
  check(`${mode}: есть запасной путь, когда субагент недоступен`, /Субагент недоступен/.test(bm));
  check(`${mode}: снятие гейта — по отчёту субагента`, /release --session s1 --evidence/.test(bm));
}
check('claude: тип субагента с именем плагина', /`[a-z0-9-]+:gate-runner`/.test(bmC));
check('opencode: тип субагента без префикса, инструмент task', /`gate-runner`/.test(bmO) && /task/.test(bmO));
const hintRunner = gateHint({ kind: 'bsl', rel: 'a.bsl', sessionId: 'sess-1', packageRoot: root, mode: 'claude' });
check('подсказка взвода предупреждает об описании работы заранее', /gate-runner/.test(hintRunner) && /описани/i.test(hintRunner));

const bmF = blockMessage({ sessionId: 's1', files, foreign: 3, packageRoot: root, mode: 'opencode', repeated: 0 });
check('чужие правки: предупреждение не трогать', bmF.includes('другой сессии (3)') && bmF.includes('НЕ трогай'));

// --- armGate: исключение путей tests.paths ---
// Тестовый файл гейт не взводит вовсе: всё после взвода (Stop-хук, план, снятие) работает
// от списка файлов сессии, и исключённого файла там быть не должно.
{
  const tr = mkdtempSync(join(tmpdir(), 'qg-core-tests-'));
  const tenv = {};
  const testFile = join(tr, 'src', 'cfe', 'Автотесты', 'CommonModules', 'тест_М', 'Ext', 'Module.bsl');
  const prodFile = join(tr, 'src', 'cfe', 'Доработки', 'CommonModules', 'М', 'Ext', 'Module.bsl');
  const withTests = () => ({ tests: { paths: ['src/cfe/Автотесты'] } });
  const pending = () => readPendingState(tr, tenv);

  const a = armGate({ root: tr, filePath: testFile, sessionId: 's', env: tenv, readConfig: withTests });
  check('исключённый путь: armGate возвращает null', a === null);
  check('исключённый путь: в сессию не попал', !pending() || !pending().sessions.s);

  const b = armGate({ root: tr, filePath: prodFile, sessionId: 's', env: tenv, readConfig: withTests });
  check('соседний рабочий файл взводится как обычно', b && b.kind === 'bsl' && Object.keys(pending().sessions.s.files).length === 1);

  // Взведён до появления настройки — следующая правка снимает его с сессии.
  armGate({ root: tr, filePath: testFile, sessionId: 's2', env: tenv });
  check('без настройки тестовый файл взводится', Boolean(pending().sessions.s2?.files));
  armGate({ root: tr, filePath: testFile, sessionId: 's2', env: tenv, readConfig: withTests });
  check('правка после настройки снимает ранее взведённый файл, пустая сессия удалена', !pending().sessions.s2);
  check('чужая сессия с рабочим файлом не тронута', Object.keys(pending().sessions.s.files).length === 1);

  // Файл вне корня не исключается: пути настройки относительные.
  const outDir = mkdtempSync(join(tmpdir(), 'qg-core-tests-out-'));
  const outFile = join(outDir, 'src', 'cfe', 'Автотесты', 'Module.bsl');
  check('файл вне корня не исключается', armGate({ root: tr, filePath: outFile, sessionId: 's', env: tenv, readConfig: withTests }) !== null);

  // Хук качества не ломает работу: падающее чтение и мусор в настройке — пустой список.
  const boom = () => { throw new Error('битый JSON'); };
  check('падающий readConfig: файл взводится', armGate({ root: tr, filePath: testFile, sessionId: 's3', env: tenv, readConfig: boom }) !== null);
  const junk = () => ({ tests: { paths: 'src/cfe/Автотесты' } });
  check('paths не массив: файл взводится', armGate({ root: tr, filePath: testFile, sessionId: 's4', env: tenv, readConfig: junk }) !== null);

  rmSync(outDir, { recursive: true, force: true });
  rmSync(tr, { recursive: true, force: true });
}

rmSync(outsideDir, { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });
rmSync(root2, { recursive: true, force: true });
rmSync(legacyRoot, { recursive: true, force: true });

console.log(`\n${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
