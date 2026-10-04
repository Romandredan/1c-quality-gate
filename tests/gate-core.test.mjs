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
  // Известный 🔴-дефект не уходит молча: решение «не чинить» принимает пользователь, а не модель,
  // и оно записывается. В автономном прогоне согласие пользователя выдумывать нельзя.
  check(`${mode}: при 🔴 решение принимает пользователь, а не модель`, /решение принимает\s+пользователь, а не ты/.test(bm));
  check(`${mode}: при 🔴 названа команда с записанным решением`, /--critical-decision/.test(bm));
  check(`${mode}: согласие отсутствующего пользователя не выдумывается`, /не выдумывай его согласие/.test(bm));
  check(`${mode}: находки 🔴/🟠 показываются пользователю всегда`, /покажи пользователю в любом случае/.test(bm));
}
// Цикл проходов в текстах: номер прохода и потолок, правило о находках вне правки, три списка
// в завершающем сообщении — сессия узнаёт их из текста передачи, другого канала к ней нет.
{
  const bm2 = blockMessage({ sessionId: 's1', files, packageRoot: root, mode: 'claude', passes: 2 });
  check('блокировка называет номер прохода и потолок', /проходом 3 из 3/.test(bm2));
  check('передача на повторном проходе требует отчёт по прошлым находкам', /8\. По каждой находке прошлого отчёта/.test(bm2));
  check('первый проход пункта 8 не требует', !/8\. По каждой/.test(bmC));
  for (const bm of [bmC, bm2]) {
    check('правило о находках вне правки', /вне правки[^\n]*не исправляй/i.test(bm));
    check('три списка в завершающем сообщении', /исправлено за цикл/i.test(bm) && /вне правки/i.test(bm) && /нужно решение/i.test(bm));
  }
  // Обзор ветки (I5): без круга исправлений до снятия потолок обходится снятием — текст передачи
  // велит исправить согласованные находки в правке и повторить проверку, а снимать гейт, когда
  // в правке остались только обоснованно неисправляемые находки или достигнут потолок.
  for (const bm of [bmC, bm2]) {
    check('передача велит исправить открытое в правке и повторить проверку до снятия', /исправь[^\n]*повтори проверку/i.test(bm) || /исправь их и повтори проверку/i.test(bm));
    check('снятие — когда остались только обоснованно неисправляемые находки или потолок', /обоснованно не исправляешь/i.test(bm) && /потолок/i.test(bm));
    check('прежняя формула «нет 🔴 — сними» убрана', !/критичных находок 🔴 нет — сними гейт по отчёту/.test(bm));
  }
  const bmCap = blockMessage({ sessionId: 's1', files, packageRoot: root, mode: 'claude', passes: 3 });
  check('после потолка названы два выхода', /потолок цикла/i.test(bmCap) && /--decision/.test(bmCap));
  const hint2 = gateHint({ kind: 'bsl', rel: 'a.bsl', sessionId: 'sess-1', packageRoot: root, mode: 'claude', passes: 1 });
  check('подсказка при взводе называет следующий проход', /проходом 2 из 3/.test(hint2));
}
check('claude: тип субагента с именем плагина', /`[a-z0-9-]+:gate-runner`/.test(bmC));
check('opencode: тип субагента без префикса, инструмент task', /`gate-runner`/.test(bmO) && /task/.test(bmO));
const hintRunner = gateHint({ kind: 'bsl', rel: 'a.bsl', sessionId: 'sess-1', packageRoot: root, mode: 'claude' });
check('подсказка взвода предупреждает об описании работы заранее', /gate-runner/.test(hintRunner) && /описани/i.test(hintRunner));

const bmF = blockMessage({ sessionId: 's1', files, foreign: 3, packageRoot: root, mode: 'opencode', repeated: 0 });
check('чужие правки: предупреждение не трогать', bmF.includes('другой сессии (3)') && bmF.includes('НЕ трогай'));

// --- Источник взвода: инструмент правки знает файл точно, оболочка — по времени изменения ---
// Сообщение блокировки обязано отделять одно от другого: файл, взведённый по времени, могла
// записать не команда сессии, и выход для него — отказ с причиной, а не проверка чужой работы.
{
  const mixed = [
    ['a.bsl', { kind: 'bsl', source: 'tool' }],
    ['src/cfe/Р/Catalogs/Т.xml', { kind: 'metadata-xml', source: 'shell' }],
  ];
  for (const mode of ['claude', 'opencode']) {
    const bm = blockMessage({ sessionId: 's1', files: mixed, packageRoot: root, mode });
    check(`${mode}: файлы, взведённые по времени, названы отдельно`, /по времени изменения \(1\)/.test(bm) && bm.includes('src/cfe/Р/Catalogs/Т.xml'));
    check(`${mode}: назван отказ от файла с причиной`, /gate\.mjs" disown --session s1 --reason/.test(bm));
  }
  check('без файлов, взведённых по времени, отказ не предлагается', !/disown/.test(bmC));

  const sr = mkdtempSync(join(tmpdir(), 'qg-core-source-'));
  const f = join(sr, 'src', 'CommonModules', 'М', 'Module.bsl');
  mkdirSync(join(sr, 'src', 'CommonModules', 'М'), { recursive: true });
  writeFileSync(f, 'Процедура Т() КонецПроцедуры\n', 'utf8');
  const entry = () => readPendingState(sr, {}).sessions.s.files['src/CommonModules/М/Module.bsl'];

  armGate({ root: sr, filePath: f, sessionId: 's', source: 'shell', env: {} });
  check('взвод из оболочки: источник shell', entry().source === 'shell');
  armGate({ root: sr, filePath: f, sessionId: 's', env: {} });
  check('правка инструментом после оболочки: источник tool', entry().source === 'tool');
  armGate({ root: sr, filePath: f, sessionId: 's', source: 'shell', env: {} });
  check('оболочка после инструмента источник не понижает', entry().source === 'tool');
  check('отпечаток — размер и время изменения файла', entry().stamp?.size > 0 && Number.isFinite(entry().stamp?.mtimeMs));

  // Точное свидетельство у двух сессий сразу: обе правили файл инструментом, ни одна не теряет его.
  armGate({ root: sr, filePath: f, sessionId: 's2', env: {} });
  check('правка инструментом не забирает файл у сессии с источником tool', Boolean(readPendingState(sr, {}).sessions.s?.files));
  rmSync(sr, { recursive: true, force: true });
}

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

// --- Цикл гейта: проходы, решения, сообщение пользователя ---
{
  const { MAX_PASSES, passCount, startPass, notePrompt, acceptPass, addDecision, updateSession } = await import('../tools/gate-cycle.mjs');
  const cr = mkdtempSync(join(tmpdir(), 'qg-core-cycle-'));
  const f = join(cr, 'src', 'CommonModules', 'Ц', 'Module.bsl');
  mkdirSync(join(cr, 'src', 'CommonModules', 'Ц'), { recursive: true });
  writeFileSync(f, 'Процедура Ц() КонецПроцедуры\n', 'utf8');
  armGate({ root: cr, filePath: f, sessionId: 'c1', env: {} });

  check('потолок проходов — три', MAX_PASSES === 3);
  const session = { files: {} };
  check('у новой сессии проходов нет', passCount(session) === 0);
  const p1 = startPass(session, '2026-10-01T10:00:00.000Z');
  check('первый проход получает номер 1 и базу HEAD', p1.n === 1 && p1.base === 'HEAD' && session.cycle.passes.length === 1);
  startPass(session, '2026-10-01T10:30:00.000Z');
  check('проходы считаются', passCount(session) === 2);
  notePrompt(session, '2026-10-01T10:40:00.000Z');
  check('сообщение пользователя сбрасывает счёт, записи остаются', passCount(session) === 0 && session.cycle.passes.length === 2);
  startPass(session, '2026-10-01T10:50:00.000Z');
  check('после сообщения считаются только новые проходы', passCount(session) === 1 && session.cycle.passes[2].n === 3);
  check(
    'принятый отчёт записывается в последний проход',
    acceptPass(session, { report: 'C:/t/r.md', now: '2026-10-01T11:00:00.000Z' }) === true && session.cycle.passes[2].report === 'C:/t/r.md'
  );
  check('без проходов принимать нечего', acceptPass({ files: {} }, { report: 'x', now: 'n' }) === false);
  addDecision(session, { text: 'Пользователь: четвёртый проход разрешён', pass: 4, now: '2026-10-01T11:10:00.000Z' });
  check('решение записано', session.cycle.decisions[0].pass === 4);

  const r = updateSession({ root: cr, sessionId: 'c1', env: {}, mutate: (s) => startPass(s, '2026-10-01T12:00:00.000Z').n });
  check('updateSession меняет сессию в состоянии под замком', r === 1 && readPendingState(cr, {}).sessions.c1.cycle.passes.length === 1);
  check(
    'updateSession чужой сессии ничего не создаёт',
    updateSession({ root: cr, sessionId: 'нет', env: {}, mutate: () => 'x' }) === null && !readPendingState(cr, {}).sessions['нет']
  );
  rmSync(cr, { recursive: true, force: true });
}

// --- Снимок и база прохода ---
{
  const { snapshotBlobs, blobExists, resolveBases, startPass, lastAcceptedReport, markChecked } = await import('../tools/gate-cycle.mjs');
  const { execFileSync } = await import('node:child_process');
  const sr = mkdtempSync(join(tmpdir(), 'qg-core-snap-'));
  execFileSync('git', ['init', '-q'], { cwd: sr });
  mkdirSync(join(sr, 'm'), { recursive: true });
  writeFileSync(join(sr, 'm', 'A.bsl'), 'А = 1;\n', 'utf8');
  writeFileSync(join(sr, 'm', 'B.bsl'), 'Б = 1;\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: sr });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: sr });
  writeFileSync(join(sr, 'm', 'A.bsl'), 'А = 2;\n', 'utf8');

  const blobs1 = snapshotBlobs(sr, ['m/A.bsl', 'm/B.bsl', 'm/Нет.bsl']);
  check('снимок даёт blob каждого существующего файла', /^[0-9a-f]{40}$/.test(blobs1['m/A.bsl']) && /^[0-9a-f]{40}$/.test(blobs1['m/B.bsl']));
  check('удалённый файл в снимке — null, без исключения', blobs1['m/Нет.bsl'] === null);
  check('записанный снимок есть в хранилище', blobExists(sr, blobs1['m/A.bsl']));
  check('выдуманного blob в хранилище нет', !blobExists(sr, '0123456789012345678901234567890123456789'));

  const session = { files: { 'm/A.bsl': { kind: 'code', edits: 1 }, 'm/B.bsl': { kind: 'code', edits: 1 } } };
  const r1 = resolveBases({ session, blobs: blobs1, root: sr });
  check('без отметок проверки база HEAD у всех', r1.label === 'HEAD' && r1.bases['m/A.bsl'] === 'HEAD' && r1.bases['m/B.bsl'] === 'HEAD');
  check('удалённый файл помечен', r1.notes['m/Нет.bsl'] === 'deleted');
  startPass(session, '2026-10-04T10:00:00.000Z', { blobs: blobs1, bases: r1.bases, notes: r1.notes, label: r1.label });
  check('проход хранит снимок и базы', session.cycle.passes[0].blobs['m/A.bsl'] === blobs1['m/A.bsl'] && session.cycle.passes[0].base === 'HEAD');

  // Файл изменён во время прохода — отметку не получает.
  writeFileSync(join(sr, 'm', 'B.bsl'), 'Б = 2;\n', 'utf8');
  const now = snapshotBlobs(sr, ['m/A.bsl', 'm/B.bsl']);
  const marked = markChecked(session, now);
  check('неизменённый файл получает отметку проверки', session.files['m/A.bsl'].checked?.blob === blobs1['m/A.bsl'] && session.files['m/A.bsl'].checked.pass === 1);
  check('изменённый во время прохода — без отметки и назван', !session.files['m/B.bsl'].checked && marked.changed.includes('m/B.bsl'));
  session.cycle.passes[0].report = 'C:/t/r1.md';
  session.cycle.passes[0].acceptedAt = '2026-10-04T10:20:00.000Z';

  // Второй проход: A исправлен, B — от HEAD (отметки нет).
  writeFileSync(join(sr, 'm', 'A.bsl'), 'А = 3;\n', 'utf8');
  const blobs2 = snapshotBlobs(sr, ['m/A.bsl', 'm/B.bsl']);
  const r2 = resolveBases({ session, blobs: blobs2, root: sr });
  check('проверенный файл идёт от снимка прохода 1', r2.bases['m/A.bsl']?.pass === 1 && r2.bases['m/A.bsl'].blob === blobs1['m/A.bsl']);
  check('файл без отметки идёт от HEAD', r2.bases['m/B.bsl'] === 'HEAD');
  check('метка базы — pass:1', r2.label === 'pass:1');
  check('прошлый принятый отчёт находится', lastAcceptedReport(session)?.report === 'C:/t/r1.md');
  check('отчёт текущего прохода не считается прошлым', lastAcceptedReport(session, { before: 1 }) === null);

  // Неизменённый со снимка файл помечается.
  const r2same = resolveBases({ session, blobs: { 'm/A.bsl': blobs1['m/A.bsl'] }, root: sr });
  check('файл, не менявшийся с прохода 1, помечен', r2same.notes['m/A.bsl'] === 'unchanged:1');

  // Снимок убран сборкой мусора — база HEAD с пометкой.
  const gone = { files: { 'm/A.bsl': { kind: 'code', edits: 1, checked: { blob: '0123456789012345678901234567890123456789', pass: 1 } } } };
  const r3 = resolveBases({ session: gone, blobs: { 'm/A.bsl': blobs2['m/A.bsl'] }, root: sr });
  check('пропавший снимок — HEAD и base_missing', r3.bases['m/A.bsl'] === 'HEAD' && r3.notes['m/A.bsl'] === 'base_missing' && r3.label === 'HEAD');

  // Файл вне корня проекта (ключ состояния — абсолютный путь) и файл без git: проход всегда полный.
  const outside = mkdtempSync(join(tmpdir(), 'qg-core-snap-out-'));
  const outFile = join(outside, 'X.bsl');
  writeFileSync(outFile, 'Х = 1;\n', 'utf8');
  const outBlobs = snapshotBlobs(sr, [outFile]);
  const outSession = { files: { [outFile]: { kind: 'code', edits: 1, checked: { blob: blobs1['m/A.bsl'], pass: 1 } } } };
  const r4 = resolveBases({ session: outSession, blobs: outBlobs, root: sr });
  check('файл вне корня — HEAD и no_git, не «удалён»', r4.bases[outFile] === 'HEAD' && r4.notes[outFile] === 'no_git' && r4.label === 'HEAD', JSON.stringify(r4));
  const outPassSession = { files: { [outFile]: { kind: 'code', edits: 1 } } };
  startPass(outPassSession, '2026-10-04T11:00:00.000Z', { blobs: outBlobs, bases: r4.bases, notes: r4.notes, label: r4.label });
  markChecked(outPassSession, outBlobs);
  check('файлу вне git отметка проверки не ставится', !outPassSession.files[outFile].checked);
  const nogit = mkdtempSync(join(tmpdir(), 'qg-core-snap-nogit-'));
  writeFileSync(join(nogit, 'Y.bsl'), 'У = 1;\n', 'utf8');
  const r5 = resolveBases({ session: { files: { 'Y.bsl': { kind: 'code', edits: 1 } } }, blobs: snapshotBlobs(nogit, ['Y.bsl']), root: nogit });
  check('проект без git — HEAD и no_git', r5.bases['Y.bsl'] === 'HEAD' && r5.notes['Y.bsl'] === 'no_git', JSON.stringify(r5));
  rmSync(outside, { recursive: true, force: true });
  rmSync(nogit, { recursive: true, force: true });
  rmSync(sr, { recursive: true, force: true });
}
rmSync(outsideDir, { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });
rmSync(root2, { recursive: true, force: true });
rmSync(legacyRoot, { recursive: true, force: true });

console.log(`\n${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
