#!/usr/bin/env node
/**
 * Тесты программных проверок плагина.
 *
 * Что покрывается: инструменты, которые являются КОДОМ — гигиена файлов, сверка
 * «диск ↔ состав», валидатор следа, механика гейта.
 *
 * Что НЕ покрывается и почему: контуры code и arch — это инструкции для модели, а не
 * программы. CI не может прогнать модель, поэтому для них проверяется только полнота
 * правил (что строка про конкретный антипаттерн не исчезла из таблицы). Это ловит
 * регрессию удаления, но не качество применения.
 *
 * Отдельный акцент на ложных срабатываниях: заведомо корректный код обязан давать ноль
 * находок. Ложная находка вреднее пропущенной — она провоцирует переделку рабочего кода,
 * и после двух-трёх таких проверку отключают целиком.
 *
 * Использование:
 *   node tests/run-tests.mjs [--verbose]
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures');
const WORK = join(tmpdir(), 'qg-tests');
const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    if (VERBOSE) process.stdout.write(`  ok   ${name}\n`);
  } else {
    failures.push({ name, detail });
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

/** Запускает инструмент плагина, возвращает код возврата и вывод. */
function run(script, args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, script), ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, ...(opts.env || {}) },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

// Байтовые фикстуры генерируются, а не хранятся: git нормализует переводы строк и может
// снять BOM, из-за чего тест проверял бы не то, что задумано.
// Невидимые символы задаются кодом, а не литералом — литерал в исходнике сам источник ошибок.
const BOM = String.fromCharCode(0xfeff);
const GROUP_SEPARATOR = String.fromCharCode(0x1d);
function writeBytes(name, content) {
  mkdirSync(WORK, { recursive: true });
  const p = join(WORK, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// ---------------------------------------------------------------------------
section('Гигиена файлов — находит настоящие дефекты');

{
  const f = writeBytes('no-bom.bsl', 'Процедура Тест()\nКонецПроцедуры\n');
  const r = run('tools/hygiene-check.mjs', [f]);
  check('нет BOM — предупреждение', r.out.includes('bom-missing'), r.out.trim().slice(0, 80));
}
{
  const f = writeBytes('dash-comment.bsl', BOM + '// Комментарий с тире — вот так\n');
  const r = run('tools/hygiene-check.mjs', [f]);
  check('тире в комментарии — находка', r.out.includes('invalid-dash'));
}
{
  // Разделитель группы попадает в файл при программной записи и невидим в редакторе.
  const f = writeBytes('control.bsl', BOM + `Процедура Тест()
	А = "X${GROUP_SEPARATOR}Y";
КонецПроцедуры
`);
  const r = run('tools/hygiene-check.mjs', [f]);
  check('управляющий символ — ошибка', r.out.includes('control-char'));
  check('управляющий символ даёт код 2', r.code === 2, `код ${r.code}`);
}
{
  const f = writeBytes('mixed-eol.bsl', BOM + 'Процедура Тест()\r\n\tА = 1;\nКонецПроцедуры\r\n');
  const r = run('tools/hygiene-check.mjs', [f]);
  check('смешанные переводы строк — находка', r.out.includes('mixed-eol'));
}

// ---------------------------------------------------------------------------
section('Гигиена файлов — НЕ придирается к корректному коду (ложные срабатывания)');

{
  // Длинное тире в тексте для пользователя — норма, встречается в типовых модулях.
  const f = writeBytes('dash-literal.bsl', BOM + 'Процедура Т()\n\tСообщить("Заказ — оплачен");\nКонецПроцедуры\n');
  const r = run('tools/hygiene-check.mjs', [f]);
  check('тире в строковом литерале — молчание', !r.out.includes('invalid-dash'), r.out.trim().slice(0, 100));
}
{
  const f = writeBytes('dash-multiline.bsl', BOM + 'Процедура Т()\n\tТ = "Строка\n\t|продолжение — с тире";\nКонецПроцедуры\n');
  const r = run('tools/hygiene-check.mjs', [f]);
  check('тире в продолжении литерала — молчание', !r.out.includes('invalid-dash'));
}
{
  const f = writeBytes('clean.bsl', BOM + 'Процедура Тест()\n\tА = 1; // обычный дефис - тут\nКонецПроцедуры\n');
  const r = run('tools/hygiene-check.mjs', [f]);
  check('чистый файл — ноль находок', r.code === 0, `код ${r.code}: ${r.out.trim().slice(0, 80)}`);
}

// ---------------------------------------------------------------------------
section('Сверка «диск ↔ состав»');

{
  const r = run('tools/xml/orphan-check.mjs', [join(FIXTURES, 'config-clean')]);
  check('чистая выгрузка — расхождений нет', r.code === 0, `код ${r.code}: ${r.out.trim().slice(0, 120)}`);
}
{
  const r = run('tools/xml/orphan-check.mjs', [join(FIXTURES, 'config-orphan')]);
  check('файл-сирота найден', r.out.includes('СИРОТЫ') || r.out.includes('сирот'), r.out.trim().slice(0, 120));
  check('сирота даёт код 2', r.code === 2, `код ${r.code}`);
  check('назван конкретный объект', r.out.includes('ЗабытыйСправочник'));
}
{
  const r = run('tools/xml/orphan-check.mjs', [join(FIXTURES, 'config-missing')]);
  check('отсутствующий файл найден', r.out.includes('ОТСУТСТВУЮТ'), r.out.trim().slice(0, 120));
  check('отсутствующий файл даёт код 2', r.code === 2);
}

// ---------------------------------------------------------------------------
section('Валидаторы XML — контракт вызова');

// Десять валидаторов в tools/xml/ портированы из cc-1c-skills и до сих пор проверялись
// только через роль — да и та попала под тест как побочный эффект починки ложной ошибки
// версии 0.4.3. Между тем контур xml опирается на них целиком, а SKILL.md обещает
// пользователю единый способ вызова. Обещание, которое никто не проверяет, живёт до
// первого обновления порта.
const PY_VALIDATORS = ['cf', 'cfe', 'epf', 'form', 'interface', 'meta', 'mxl', 'role', 'skd', 'subsystem'];
const pyTool = (name) => join(ROOT, 'tools', 'xml', `${name}-validate.py`);

/** Запускает python-валидатор, возвращает код возврата и объединённый вывод. */
function runPy(script, args) {
  try {
    const out = execFileSync('python', [script, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

// Доступность определяется ОДИН раз и в одном месте. Иначе каждый блок вынес бы свой
// вердикт: десять одинаковых провалов вместо одного внятного — или, того хуже, guard
// остался бы только у первого блока, и остальные молча пропускались бы в CI.
const python = (() => {
  try {
    execFileSync('python', ['-c', 'import lxml.etree'], { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    // Нет интерпретатора и нет зависимости — разные диагнозы: во втором случае python
    // отвечает кодом 1, а причина видна только в тексте traceback.
    const missing = /ENOENT/.test(String(e.code || e.message));
    return { ok: false, reason: missing ? 'python недоступен' : 'библиотека lxml недоступна' };
  }
})();

if (!python.ok) {
  // В CI пропуск запрещён: зелёный прогон без проверки неотличим от проверенного.
  // Это же ловит удаление шага установки зависимостей из workflow.
  if (process.env.CI) {
    check('валидаторы XML прогнаны', false, `${python.reason} — в CI зависимости валидаторов обязаны быть установлены`);
  } else {
    process.stdout.write(`  (пропуск валидаторов XML: ${python.reason})\n`);
  }
}

if (python.ok) {
  // SKILL.md обещает: «-Path принимается всеми валидаторами без исключения». У каждого
  // скрипта своё второе имя параметра (-ObjectPath, -FormPath, -RightsPath…), а
  // allow_abbrev=False превращает промах в отказ разбора аргументов. Проверено это было
  // ровно для одного валидатора из десяти.
  for (const name of PY_VALIDATORS) {
    const r = runPy(pyTool(name), ['-Path', join(WORK, 'нет-такого-файла.xml')]);
    check(`${name}: принимает -Path`, !/unrecognized arguments|error: the following arguments/.test(r.out), r.out.trim().slice(0, 100));
    // Отсутствующий файл — штатная ситуация, а не сбой инструмента. Traceback здесь читается
    // как находка в проверяемом XML: та же подмена, что дал ModuleNotFoundError без lxml.
    check(`${name}: отсутствующий путь назван, а не свален в traceback`,
      /not found|не найден/i.test(r.out) && !/Traceback/.test(r.out), r.out.trim().slice(0, 100));
  }

  // Пара на каждый валидатор: заведомо корректный файл обязан пройти чисто, заведомо
  // дефектный — дать именно ту ошибку, ради которой фикстура написана. Проверка «нашёл
  // хоть что-то» бесполезна: она зелёная и когда валидатор ругается не на то.
  //
  // Половина про «корректный» — якорь регрессии, а не независимая истина: фикстуры
  // доводились до Validation OK по выводу самих валидаторов. Ценность в том, что молчание
  // зафиксировано: после правки порта ложная находка на исправном файле станет видна.
  // Дефекты во всех фикстурах — well-formed XML, нарушающий правило 1С, а не битая разметка:
  // сломанный XML проверял бы парсер lxml, а не валидатор.
  const xml = (...parts) => join(FIXTURES, 'xml', ...parts);
  const VALIDATOR_CASES = [
    ['cf', xml('cf', 'valid'), xml('cf', 'broken'), 'DefaultLanguage "Language.Английский" not found', 'язык по умолчанию не зарегистрирован в составе'],
    ['cfe', xml('cfe', 'valid'), xml('cfe', 'broken'), "ObjectBelonging must be 'Adopted'", 'объект расширения не помечен заимствованным'],
    ['epf', xml('epf', 'valid'), xml('epf', 'broken'), "expected 'c3831ec8-d8d5-4f93-8a22-f9bfae07327f'", 'ClassId отчёта в обработке'],
    ['form', xml('form', 'valid.xml'), xml('form', 'broken.xml'), "attribute 'НетТакогоРеквизита' not found", 'поле связано с несуществующим реквизитом'],
    ['interface', xml('interface', 'valid.xml'), xml('interface', 'broken.xml'), 'Section order', 'секции командного интерфейса переставлены'],
    ['meta', xml('meta', 'valid.xml'), xml('meta', 'broken.xml'), 'Type block has no v8:Type', 'тип реквизита задан скаляром'],
    ['mxl', xml('mxl', 'valid.xml'), xml('mxl', 'broken.xml'), 'height=1 but max row index=1', 'высота макета меньше числа строк'],
    ['role', join(FIXTURES, 'role-min', 'Roles', 'QG_ТестоваяРоль'), xml('role', 'QG_БитаяРоль'), "right 'ThinClient' has invalid value", 'право без значения'],
    ['skd', xml('skd', 'valid.xml'), xml('skd', 'broken.xml'), 'references unknown dataSource', 'набор данных ссылается на несуществующий источник'],
    ['subsystem', xml('subsystem', 'valid.xml'), xml('subsystem', 'broken.xml'), 'invalid format (expected Type.Name or UUID)', 'ссылка в составе не разрешается'],
  ];
  for (const [name, validPath, brokenPath, marker, defect] of VALIDATOR_CASES) {
    const good = runPy(pyTool(name), ['-Path', validPath]);
    check(`${name}: корректный файл проходит чисто`, good.code === 0 && /Validation OK/.test(good.out), good.out.trim().slice(0, 110));
    const bad = runPy(pyTool(name), ['-Path', brokenPath]);
    check(`${name}: найден дефект — ${defect}`, bad.code === 1 && bad.out.includes(marker), bad.out.trim().slice(0, 110));
  }

  // Валидатор роли проверяет Rights.xml, а путь ему дают тремя разными способами. Раньше файл
  // метаданных роли разбирался как Rights.xml и давал ЛОЖНУЮ ошибку при меньшем числе проверок:
  // не отказ, а находка, которой нет в чужом коде. Три формы обязаны давать один результат.
  const roleDir = join(FIXTURES, 'role-min', 'Roles', 'QG_ТестоваяРоль');
  const forms = [`${roleDir}.xml`, roleDir, join(roleDir, 'Ext', 'Rights.xml')];
  const outs = forms.map((p) => runPy(pyTool('role'), ['-Path', p]).out);
  const counts = outs.map((o) => (o.match(/\((\d+) checks\)/) || [])[1]);
  check('все три формы пути к роли дают один результат', new Set(counts).size === 1 && counts[0], counts.join(' / '));
  check('роль признана валидной', outs.every((o) => o.includes('Validation OK')), outs[0].trim().slice(0, 100));
}

// ---------------------------------------------------------------------------
section('Валидатор следа — отвергает недобросовестный прогон');

const ev = (name) => join(FIXTURES, 'evidence', name);
{
  const r = run('tools/evidence-validator.mjs', [ev('valid.md'), '--gate']);
  check('полный корректный след принимается', r.code === 0, r.out.trim().slice(0, 120));
}
{
  const r = run('tools/evidence-validator.mjs', [ev('no-sentinel.md'), '--gate']);
  check('без sentinel — отклонён', r.code === 2);
  check('причина названа', r.out.includes('sentinel'));
}
{
  const r = run('tools/evidence-validator.mjs', [ev('all-clean.md'), '--gate']);
  check('всё «чисто» без not_verified — отклонён', r.code === 2, r.out.trim().slice(0, 120));
}
{
  const r = run('tools/evidence-validator.mjs', [ev('empty-ids.md'), '--gate']);
  check('пустой список идентификаторов — отклонён', r.code === 2);
}
{
  const r = run('tools/evidence-validator.mjs', [ev('malformed.md'), '--gate']);
  check('незакрытая запись — отклонена', r.out.includes('не разобрана'));
}
{
  const r = run('tools/evidence-validator.mjs', [ev('multiline-scope.md'), '--gate']);
  check('многострочная запись scope разбирается', r.code === 0, r.out.trim().slice(0, 120));
}

// ---------------------------------------------------------------------------
section('Механика гейта');

{
  const proj = join(WORK, 'proj');
  rmSync(proj, { recursive: true, force: true });
  mkdirSync(join(proj, 'src', 'cf', 'CommonModules', 'М', 'Ext'), { recursive: true });
  const env = { CLAUDE_PROJECT_DIR: proj };
  const file = join(proj, 'src', 'cf', 'CommonModules', 'М', 'Ext', 'Module.bsl');

  const arm = (sessionId, path = file) => {
    const payload = JSON.stringify({ session_id: sessionId, cwd: proj, tool_input: { file_path: path } });
    try {
      return execFileSync(process.execPath, [join(ROOT, 'hooks', 'gate-arm.mjs')], {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
    } catch {
      return '';
    }
  };
  const stop = (sessionId, extra = {}) => {
    const payload = JSON.stringify({ session_id: sessionId, cwd: proj, ...extra });
    try {
      execFileSync(process.execPath, [join(ROOT, 'hooks', 'gate-check.mjs')], {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: 'pipe',
      });
      return 0;
    } catch (e) {
      return e.status ?? 1;
    }
  };

  check('правка .bsl взводит гейт', arm('S1').includes('взведён'));
  check('Stop блокирует свою сессию', stop('S1') === 2);
  check('Stop чужой сессии не блокирует', stop('S2') === 0);

  // Повторная попытка завершения не должна открывать обход.
  check('повторный Stop тоже блокирует', stop('S1', { stop_hook_active: true }) === 2);

  // Не-1С файлы игнорируются: в чужих проектах плагин обязан молчать.
  check('README не взводит гейт', arm('S3', join(proj, 'README.md')) === '');
  check('XML вне выгрузки 1С не взводит', arm('S3', join(proj, 'src', 'main', 'beans.xml')) === '');

  const rel = run('tools/gate.mjs', ['release', '--class', 'C3', '--reason', 'просто не хочу проверять'], { env });
  check('снятие C3 без следа запрещено', rel.code === 2, rel.out.trim().slice(0, 100));

  const relOk = run('tools/gate.mjs', ['release', '--evidence', ev('valid.md'), '--session', 'S1'], { env });
  check('снятие по валидному следу проходит', relOk.code === 0, relOk.out.trim().slice(0, 120));
  check('после снятия Stop пропускает', stop('S1') === 0);
}

// ---------------------------------------------------------------------------
section('Переиспользование доказательств и формат вывода хука');

{
  const proj = join(WORK, 'verify-proj');
  rmSync(proj, { recursive: true, force: true });
  mkdirSync(join(proj, 'src', 'cf', 'CommonModules', 'V', 'Ext'), { recursive: true });
  const env = { CLAUDE_PROJECT_DIR: proj };
  const rel = 'src/cf/CommonModules/V/Ext/Module.bsl';
  const file = join(proj, ...rel.split('/'));

  const arm = () => {
    try {
      return execFileSync(process.execPath, [join(ROOT, 'hooks', 'gate-arm.mjs')], {
        input: JSON.stringify({ session_id: 'V1', cwd: proj, tool_input: { file_path: file } }),
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
    } catch {
      return '';
    }
  };
  const readState = () => {
    const p = join(proj, '.claude', '.state', 'qg-pending.json');
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return Object.values(j.sessions?.V1?.files || {})[0] || null;
  };

  // Простой текст из PostToolUse до модели не доходит — нужен JSON с hookSpecificOutput.
  const out = arm();
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch {
    /* останется null */
  }
  check('хук взвода отдаёт валидный JSON', parsed !== null, out.slice(0, 60));
  check('в JSON есть additionalContext', Boolean(parsed?.hookSpecificOutput?.additionalContext));
  check('hookEventName корректен', parsed?.hookSpecificOutput?.hookEventName === 'PostToolUse');

  const v = run('tools/gate.mjs', ['verify', '--layer', 'code', rel, '--session', 'V1'], { env });
  check('verify отмечает файл проверенным', v.code === 0, v.out.trim().slice(0, 80));
  check('отметка записана в состояние', Boolean(readState()?.verified?.code));

  arm();
  check('правка снимает отметку (инвалидация)', !readState()?.verified, JSON.stringify(readState()?.verified));
  check('счётчик правок растёт', readState()?.edits === 2);

  const vBad = run('tools/gate.mjs', ['verify', '--layer', 'code', 'нет-такого-файла.bsl', '--session', 'V1'], { env });
  check('verify по чужому файлу не отмечает', vBad.code === 1);
}

// ---------------------------------------------------------------------------
section('Полнота правил (контуры code и arch выполняет модель — проверяем, что правила на месте)');

const mustContain = [
  ['skills/bsl-code-review/references/bsl-anti-patterns.md', 'Запрос в цикле', 'антипаттерн «запрос в цикле»'],
  ['skills/bsl-code-review/references/ai-antipatterns.md', 'AI-01', 'запись набора с неполным отбором'],
  ['skills/bsl-code-review/references/ai-antipatterns.md', 'AI-04', 'отчёт о непрогнанной проверке'],
  ['skills/bsl-code-review/references/ai-antipatterns.md', 'AI-05', 'зелёная сборка вместо компиляции'],
  ['skills/bsl-code-review/references/bsl-anti-patterns.md', 'Коррелированный подзапрос', 'коррелированный подзапрос в условии'],
  ['skills/bsl-code-review/references/bsl-anti-patterns.md', 'ИНДЕКСИРОВАТЬ ПО', 'временная таблица без индекса'],
  ['skills/bsl-code-review/references/bsl-anti-patterns.md', 'СообщитьПользователю', 'Сообщить() как уведомление'],
  ['skills/quality-gate/references/adversarial-audit.md', 'опроверг', 'состязательный аудит: обратная постановка'],
  ['skills/bsl-architecture-review/references/ai-antipatterns-arch.md', 'ARCH-AI-05', 'параллельная коллекция вместо поля'],
  ['skills/xml-structure-review/SKILL.md', 'ChildObjects', 'проверка регистрации в составе'],
  ['shared/routing-contract.md', 'радиус', 'граница контуров по радиусу правки'],
  ['skills/bsl-code-review/SKILL.md', 'НЕ РАЗОБРАНО', 'неразобранные файлы называются явно'],
  ['skills/xml-structure-review/SKILL.md', '-Path', 'универсальное имя параметра валидаторов XML'],
  ['skills/xml-structure-review/SKILL.md', 'reason=lxml_unavailable', 'падение валидатора без lxml — не находка в XML'],
];
for (const [file, needle, label] of mustContain) {
  const p = join(ROOT, file);
  check(`правило на месте: ${label}`, existsSync(p) && readFileSync(p, 'utf8').includes(needle));
}

// у каждого признака архитектуры обязан быть контр-сигнал
{
  const map = JSON.parse(readFileSync(join(ROOT, 'skills/bsl-architecture-review/references/signs-map.json'), 'utf8'));
  const without = (map.signs || []).filter((s) => !s.counter || s.counter.trim().length < 10);
  check('у каждого признака есть контр-сигнал', without.length === 0, without.map((s) => s.id).join(', '));
  const noPrinciple = (map.signs || []).filter((s) => !s.principles?.length);
  check('у каждого признака есть ссылка на принцип', noPrinciple.length === 0);

  // Признаки, которым нужен граф вызовов, обязаны быть помечены машиночитаемо: без индекса
  // кода они не «чисто», а `skipped`. Иначе контур молча не проверит треть карты, а отчёт
  // будет выглядеть полным — тот же ложный зелёный, который он ищет в чужом коде.
  const needGraph = (map.signs || []).filter((s) => s.requires?.includes('call-graph')).map((s) => s.id).sort();
  check('признаки по графу вызовов размечены', needGraph.join(',') === 'ARCH-A1,ARCH-A7,ARCH-A9', needGraph.join(',') || 'ни одного');

  const skill = readFileSync(join(ROOT, 'skills/bsl-architecture-review/SKILL.md'), 'utf8');
  check('правило пропуска при отсутствии индекса описано', skill.includes('reason=rlm_unavailable') && skill.includes('call-graph-signs'));
  for (const id of needGraph) {
    check(`пропуск называет ${id}`, skill.includes(id));
  }
}

// ---------------------------------------------------------------------------
section('Статический анализатор — нормализация вывода и поиск корня конфигурации');

{
  const analyzer = await import(pathToFileURL(join(ROOT, 'tools', 'analyzer-run.mjs')).href);

  // Синтетическое дерево: корень конфигурации определяется наличием Configuration.xml.
  const proj = join(WORK, 'proj');
  const cfRoot = join(proj, 'src', 'cf');
  const modDir = join(cfRoot, 'CommonModules', 'Тест', 'Ext');
  mkdirSync(modDir, { recursive: true });
  writeFileSync(join(cfRoot, 'Configuration.xml'), '<xml/>', 'utf8');
  const modFile = join(modDir, 'Module.bsl');
  writeFileSync(modFile, 'Процедура П() КонецПроцедуры', 'utf8');
  const outside = join(proj, 'scripts', 'tool.bsl');
  mkdirSync(dirname(outside), { recursive: true });
  writeFileSync(outside, '// вне конфигурации', 'utf8');

  check('корень конфигурации найден по Configuration.xml', analyzer.findConfigRoot(modFile, proj) === cfRoot);
  const grouped = analyzer.groupByConfigRoot([modFile, outside], proj);
  check('файлы сгруппированы по корню', grouped.groups.get(cfRoot)?.length === 1);
  check('файл вне конфигурации попал в сироты', grouped.orphans.length === 1);

  // Пути в отчётах: bsl-analyzer отдаёт `\\?\`-форму, BSL LS — file:// URI. Разбор обеих
  // обязателен: иначе фильтр по изменённым файлам не находит совпадений и контур
  // отчитывается «чисто» на пустом множестве. Это ровно тот отказ, что был найден живьём.
  const jsonl = [
    JSON.stringify({ type: 'start', total_files: 1, version: '0.0.0' }),
    JSON.stringify({
      type: 'file',
      path: '\\\\?\\' + modFile,
      diagnostics: [
        { code: 'CommonModuleInvalidType', message: 'тест', severity: 'Major', start_line: 0, start_column: 0 },
        { code: 'MagicNumber', message: 'тест', severity: 'Information', start_line: 41, start_column: 3 },
      ],
      metrics: { functions: 1, complexity: 2, cognitive_complexity: 3 },
    }),
    JSON.stringify({ type: 'done', elapsed_secs: 0.01, total_files: 1, total_diagnostics: 2 }),
  ].join('\n');

  const na = analyzer.normalizeBslAnalyzer(jsonl, { root: cfRoot, base: proj });
  check('bsl-analyzer: путь приведён к проектному', na.findings[0]?.file === 'src/cf/CommonModules/Тест/Ext/Module.bsl');
  check('bsl-analyzer: нумерация строк приведена к человеческой', na.findings[1]?.line === 42);
  check('bsl-analyzer: серьёзность отображена', na.findings[0]?.severity === 'major' && na.findings[1]?.severity === 'info');
  check('bsl-analyzer: метрики собраны', na.metrics.get('src/cf/CommonModules/Тест/Ext/Module.bsl')?.functions === 1);

  const lsReport = JSON.stringify({
    fileinfos: [
      {
        path: pathToFileURL(modFile).href,
        diagnostics: [{ code: { value: 'CommonModuleInvalidType' }, message: 'тест', severity: 'Major', range: { start: { line: 0, character: 0 } } }],
      },
      {
        path: pathToFileURL(join(cfRoot, 'CommonModules', 'Другой', 'Ext', 'Module.bsl')).href,
        diagnostics: [{ code: { value: 'LineLength' }, message: 'тест', severity: 'Minor', range: { start: { line: 7, character: 0 } } }],
      },
    ],
  });
  const nl = analyzer.normalizeBslLs(lsReport, { root: cfRoot, base: proj });
  check('BSL LS: file:// URI разобран', nl.findings[0]?.file === 'src/cf/CommonModules/Тест/Ext/Module.bsl');
  check('BSL LS: код диагностики извлечён из объекта', nl.findings[0]?.code === 'CommonModuleInvalidType');
  const nlFiltered = analyzer.normalizeBslLs(lsReport, { root: cfRoot, base: proj, only: [modFile] });
  check('BSL LS: фильтр по изменённым файлам работает', nlFiltered.findings.length === 1);

  // След: чистый прогон отчитывается за весь набор, нарушения — по записи на код.
  const evClean = analyzer.toEvidence({ findings: [], sentinelResult: { status: 'found' }, engine: 'bsl-analyzer', version: '1.2.3' });
  check('чистый прогон помечен идентификатором набора', evClean.some((l) => l.includes('ids=[bslls:*]') && l.includes('verdict=clean')));
  check('версия движка попала в след', evClean.some((l) => l.includes('engine=bsl-analyzer@1.2.3')));
  const evDirty = analyzer.toEvidence({ findings: na.findings, sentinelResult: { status: 'found' }, engine: 'bsl-analyzer', version: '1.2.3' });
  check('нарушения выведены по коду', evDirty.filter((l) => l.startsWith('[qg applied')).length === 2);

  // Раскладка проекта: расширение отличается от основной конфигурации назначением в корневом
  // XML. Без этого различения анализ идёт по расширению в одиночку, имена БСП неразрешимы, и
  // треть находок становится ложной — измерено на боевом коде.
  const proj2 = join(WORK, 'layout');
  const mainRoot = join(proj2, 'src', 'cf');
  const extRoot = join(proj2, 'src', 'cfe', 'Расш');
  mkdirSync(mainRoot, { recursive: true });
  mkdirSync(extRoot, { recursive: true });
  writeFileSync(join(mainRoot, 'Configuration.xml'), '<Configuration><Name>Основная</Name></Configuration>', 'utf8');
  writeFileSync(join(extRoot, 'Configuration.xml'), '<Configuration><ConfigurationExtensionPurpose>AddOn</ConfigurationExtensionPurpose></Configuration>', 'utf8');

  const layout = analyzer.discoverLayout(proj2);
  check('основная конфигурация опознана', layout.main === mainRoot, layout.main);
  check('расширение опознано по назначению', layout.extensions.length === 1 && layout.extensions[0] === extRoot);

  const toml = analyzer.buildProjectConfig({ layout, root: proj2 });
  check('в конфиг попал корень основной конфигурации', toml.includes('[source]') && toml.includes('root = "src/cf"'));
  check('в конфиг попало расширение', /extensions = \[\s*\n\s*"src\/cfe\/Расш",/.test(toml), toml.split('\n').slice(0, 6).join(' | '));

  // Неразобранный файл: сотни ParseError — это не сотни проблем, а отсутствие анализа.
  const parseFail = [
    JSON.stringify({
      type: 'file',
      path: '\\\\?\\' + modFile,
      diagnostics: [
        { code: 'ParseError', message: 'x', severity: 'Major', start_line: 1 },
        { code: 'ParseError', message: 'x', severity: 'Major', start_line: 2 },
        { code: 'MagicNumber', message: 'x', severity: 'Information', start_line: 3 },
      ],
    }),
  ].join('\n');
  const np = analyzer.normalizeBslAnalyzer(parseFail, { root: cfRoot, base: proj });
  check('ошибки разбора вынесены из находок', np.findings.length === 0, JSON.stringify(np.findings));
  check('файл помечен неразобранным', np.unparsed.get('src/cf/CommonModules/Тест/Ext/Module.bsl') === 2);

  const evUnparsed = analyzer.toEvidence({
    findings: [], sentinelResult: { status: 'found' }, engine: 'bsl-analyzer', version: '1.0.0', unparsed: np.unparsed,
  });
  check('неразобранное попало в след как not_verified', evUnparsed.some((l) => l.includes('reason=parse_failed')));

  const evExtOnly = analyzer.toEvidence({
    findings: [], sentinelResult: { status: 'found' }, engine: 'bsl-analyzer', version: '1.0.0', resolution: 'extension-only',
  });
  check('разбор без основной конфигурации отмечен в следе', evExtOnly.some((l) => l.includes('main_configuration_absent')));
  check('семейство неразрешимого перечислено', analyzer.UNRESOLVED_WITHOUT_MAIN.has('UnresolvedMethodCall') && analyzer.UNRESOLVED_WITHOUT_MAIN.has('UnknownFieldInQuery'));

  // Фикстура часового обязана оставаться НЕВАЛИДНОЙ по сочетанию флагов: валидное сочетание
  // погасит диагностику, и часовой начнёт считать недостоверным любой прогон.
  const fixture = readFileSync(join(ROOT, 'assets/analyzer/sentinel-fixture/CommonModules/QG_SentinelModule.xml'), 'utf8');
  const allFalse = ['Server', 'ServerCall', 'ClientManagedApplication', 'ClientOrdinaryApplication', 'ExternalConnection'].every(
    (flag) => fixture.includes(`<${flag}>false</${flag}>`)
  );
  check('фикстура часового осталась невалидной по типу модуля', allFalse);
  check('фикстура зарегистрирована в составе конфигурации',
    readFileSync(join(ROOT, 'assets/analyzer/sentinel-fixture/Configuration.xml'), 'utf8').includes('<CommonModule>QG_SentinelModule</CommonModule>'));
}

// ---------------------------------------------------------------------------
section('Установка анализатора — манифест и состояние установки');

{
  const boot = await import(pathToFileURL(join(ROOT, 'tools', 'analyzer-bootstrap.mjs')).href);
  const manifest = boot.readManifest();

  check('манифест закрепляет версию', /^\d+\.\d+\.\d+$/.test(manifest.version || ''), manifest.version);
  check('манифест называет источник', manifest.repo === 'itrous/bsl-analyzer' && manifest.urlTemplate.includes('{version}'));
  const targets = Object.entries(manifest.targets || {});
  check('поддержаны основные платформы', targets.length >= 3, targets.map(([k]) => k).join(', '));
  const badSums = targets.filter(([, t]) => !/^[0-9a-f]{64}$/.test(t.sha256 || '') || !(t.size > 0));
  check('у каждой платформы валидная сумма и размер', badSums.length === 0, badSums.map(([k]) => k).join(', '));

  const url = boot.assetUrl(manifest, manifest.targets[targets[0][0]]);
  check('ссылка собирается из шаблона', url.startsWith('https://github.com/itrous/bsl-analyzer/releases/download/v') && url.endsWith(targets[0][1].asset), url);

  // Состояние установки проверяется без сети: подкладываем свой «бинарник» и синтетический
  // манифест под него. Маркер готовности обязан отражать РЕАЛЬНЫЙ файл, иначе испорченная
  // загрузка выглядела бы рабочей установкой.
  const fakeRoot = join(WORK, 'plugin-data');
  const fake = { engine: 'test-engine', version: '9.9.9', repo: 'x/y', urlTemplate: 'https://example/{asset}', targets: {} };
  const dir = boot.installDir(fake, fakeRoot);
  mkdirSync(dir, { recursive: true });
  const binPath = boot.binaryPath(fake, fakeRoot);
  writeFileSync(binPath, 'не настоящий бинарник', 'utf8');
  const realSha = await boot.sha256(binPath);
  const realSize = readFileSync(binPath).length;
  fake.targets[boot.targetKey()] = { asset: 'fake', sha256: realSha, size: realSize };
  writeFileSync(join(dir, '.ready'), JSON.stringify({ version: fake.version, sha256: realSha, size: realSize }), 'utf8');

  check('корректная установка распознаётся', boot.installed(fake, fakeRoot) === binPath);

  writeFileSync(binPath, 'не настоящий бинарник, но длиннее', 'utf8');
  check('изменённый размер обесценивает установку', boot.installed(fake, fakeRoot) === null);

  const v = await boot.verifyInstalled(fake, fakeRoot);
  check('проверка отличает испорченное от неустановленного', v.reason === 'corrupted_or_stale', v.reason);
}

// ---------------------------------------------------------------------------
section('Часовой проверяется по целям, а не «хотя бы один живой»');

{
  const head = '## quality evidence\n\n[qg scope: volume=C1, files=1, archetypes=[none], driver=volume, resolved=code:L1]\n';
  const clean = '[qg applied: layer=code, scope=static-analysis, ids=[bslls:*], verdict=clean]\n';
  const notVerified = '[qg not_verified: dimension=compilation, reason=no_platform]\n';
  const v8 = '[qg sentinel: target=v8std, id=std454, status=found]\n';
  const bslls = '[qg sentinel: target=bslls, id=CommonModuleInvalidType, status=found]\n';

  const masked = writeBytes('ev-masked.md', head + v8 + clean + notVerified);
  const r1 = run('tools/evidence-validator.mjs', [masked, '--gate']);
  check('живой v8std НЕ маскирует отсутствие часового по анализатору', r1.code === 2, r1.out.trim().slice(0, 120));

  const ok = writeBytes('ev-both.md', head + v8 + bslls + clean + notVerified);
  const r2 = run('tools/evidence-validator.mjs', [ok, '--gate']);
  check('оба часовых подтверждены — след принят', r2.code === 0, r2.out.trim().slice(0, 120));

  const dead = writeBytes('ev-dead.md', head + v8 + '[qg sentinel: target=bslls, id=CommonModuleInvalidType, status=not_found]\n' + clean + notVerified);
  const r3 = run('tools/evidence-validator.mjs', [dead, '--gate']);
  check('часовой по анализатору не подтверждён — след отвергнут', r3.code === 2);

  // Идентификатор нашей эвристики бывает составным: qg:AI-CONTRACT-RECHECK, не только qg:ARCH-A1.
  const compound = writeBytes(
    'ev-compound.md',
    head + v8 + '[qg applied: layer=code, scope=t, ids=[qg:AI-CONTRACT-RECHECK], verdict=clean]\n' + notVerified
  );
  const rc = run('tools/evidence-validator.mjs', [compound]);
  check('составной идентификатор эвристики принимается', !rc.out.includes('непохож'), rc.out.trim().slice(0, 120));

  const bogus = writeBytes(
    'ev-bogus.md',
    head + v8 + '[qg applied: layer=code, scope=t, ids=[qg:X], verdict=clean]\n' + notVerified
  );
  const rb = run('tools/evidence-validator.mjs', [bogus]);
  check('односегментный идентификатор по-прежнему отвергается', rb.out.includes('непохож'));

  // Нарушения не требуют часового: «нашли» самодостаточно, недостоверно только «не нашли».
  const onlyViolations = writeBytes('ev-viol.md', head + v8 + '[qg applied: layer=code, scope=static-analysis, ids=[bslls:MagicNumber], verdict=violation:bslls:MagicNumber]\n');
  const r4 = run('tools/evidence-validator.mjs', [onlyViolations, '--gate']);
  check('вердикт с нарушениями не требует часового по анализатору', r4.code === 0, r4.out.trim().slice(0, 120));
}

// ---------------------------------------------------------------------------
process.stdout.write(`\n${'='.repeat(60)}\nПройдено: ${passed}, провалено: ${failures.length}\n`);
if (failures.length) {
  process.stdout.write('\nПровалившиеся проверки:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}\n`);
}
rmSync(WORK, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
