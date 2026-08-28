"""Отметка о прогоне валидатора в журнале плагина.

Тот же журнал, что пишут инструменты на Node (`tools/run-journal.mjs`), и та же цель:
вердикт `[qg applied: ... verdict=clean]` пишет в отчёт модель, и написанный по прочтении
кода он неотличим от полученного прогоном. Журнал делает обнаружимым молчание — заявлено
`applied` по проверке, у которой есть инструмент, а инструмент не запускался.

Модуль отдельный и подключается через try/except: валидаторы XML запускаются и поодиночке,
скопированными в чужой проект, и падение импорта не должно лишать пользователя проверки.

Формат строки согласован с `run-journal.mjs`: JSON Lines,
`{"ts": ..., "scope": ..., "tool": ..., "verdict": ..., "files": ...}`.
"""

import json
import sys
import os
from datetime import datetime, timezone

CONFIG_MARKER = ".1c-quality-gate.json"
GIT_MARKER = ".git"
STATE_DIR = os.environ.get("QG_STATE_DIR", os.path.join(".claude", ".state"))
JOURNAL_FILE = "qg-runs.jsonl"
KEEP = 500


def project_root(start=None):
    """Корень проекта: переменная харнесса, иначе подъём по маркерам, иначе исходный каталог.

    Порядок повторяет `tools/project-root.mjs`. Разойдясь, два разрешителя писали бы журнал
    в разные каталоги, и валидатор следа не нашёл бы записей питоновского валидатора.
    """
    from_env = (
        os.environ.get("QG_PROJECT_DIR")
        or os.environ.get("OPENCODE_PROJECT_DIR")
        or os.environ.get("CLAUDE_PROJECT_DIR")
    )
    if from_env:
        return from_env

    here = os.path.abspath(start or os.getcwd())
    for marker in (CONFIG_MARKER, GIT_MARKER):
        current = here
        while True:
            if os.path.exists(os.path.join(current, marker)):
                return current
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
    return here


def emit_evidence(tool, errors, files=None, scope="structure-validation", sign="qg:XML-STRUCT", extra=None):
    """Печатает готовую запись следа и отмечает прогон в журнале.

    Общий хвост для всех валидаторов XML: контур переносит эту строку в отчёт дословно.
    Пока каждый валидатор просто печатал «Validation OK», запись следа составляла модель по
    прочтении вывода — то есть проверка с инструментом заканчивалась строкой, написанной от
    руки, и отличить её от прогнанной было нечем.

    Все валидаторы отчитываются ОДНИМ именем `structure-validation`: навык контура называет
    так проверку структуры любого файла метаданных, а валидатор следа сверяет по имени.
    Если бы отмечался только один из них, след после проверки формы или роли отвергался бы
    как «инструмент не запускался» — ложная находка на добросовестно выполненной работе.
    """
    verdict = f"violation:{sign}" if errors else "clean"
    record_run(scope, tool, verdict="violation" if errors else "clean", files=files or target_from_argv())

    print("")
    print("## quality evidence")
    print("")
    print(f"[qg applied: layer=xml, scope={scope}, ids=[{sign}], verdict={verdict}]")
    # Второй проверке того же инструмента нужен свой заголовок не больше, чем первой: контур
    # переносит блок целиком, и разорванный на два блока след читается как два прогона.
    for line in extra or []:
        print(line)


def target_from_argv(argv=None):
    """Что проверял валидатор — берётся из аргументов запуска.

    Так путь попадает в журнал без правки десяти скриптов, у каждого из которых своё имя
    параметра (`-Path`, `-ObjectPath`, `-FormPath`, `-RightsPath`…) и своя внутренняя
    переменная с разрешённым путём. Значение параметра — единственное общее место.

    Берётся значение параметра, в имени которого есть `path`, а НЕ последний позиционный
    аргумент: у валидаторов есть и `-MaxErrors 10`, и `-OutFile отчёт.txt`, и при запуске
    `-Path Товары.xml -MaxErrors 10` в журнал уходило бы `10`. Дальше сверка покрытия
    объявляла бы непроверенным каждый настоящий файл — ложное утверждение, называющее
    реальные пути.

    Возвращает список из одного пути либо пустой: путь может указывать и на файл, и на каталог
    объекта — сверку покрытия это учитывает, засчитывая файлы внутри каталога.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    for i, arg in enumerate(args):
        if arg.startswith("-") and "path" in arg.lstrip("-").lower():
            value = args[i + 1] if i + 1 < len(args) else None
            return [value] if value and not value.startswith("-") else []
    # Запасной путь — позиционный аргумент, если параметр пути не назван вовсе.
    positional = [a for i, a in enumerate(args) if not a.startswith("-") and (i == 0 or not args[i - 1].startswith("-"))]
    return positional[-1:] if positional else []


def normalize_path(path, root):
    """Путь в той же форме, в какой состав правки хранит гейт: от корня, слэши, нижний регистр.

    Регистр гасится намеренно: на Windows один файл приходит то как `src/CF/...`, то как
    `src/cf/...`, и сверка покрытия по-разному записанных путей дала бы находку на
    проверенном файле.
    """
    text = str(path)
    if os.path.isabs(text):
        try:
            text = os.path.relpath(text, root)
        except ValueError:
            # Разные диски на Windows: относительного пути не существует, оставляем как есть.
            pass
    text = text.replace("\\", "/")
    # Именно префикс «./», а не набор символов: lstrip("./") съел бы и ведущие «../»,
    # превратив путь за пределы проекта в путь внутри него.
    if text.startswith("./"):
        text = text[2:]
    return text.lower()


def record_run(scope, tool, verdict=None, files=None, root=None):
    """Дописывает запись о прогоне. Ошибка записи проглатывается: проверка важнее учёта."""
    if not scope or not tool:
        return None

    base = root or project_root()
    entry = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z",
        "scope": scope,
        "tool": tool,
    }
    if verdict:
        entry["verdict"] = verdict
    if files:
        paths = files if isinstance(files, (list, tuple)) else [files]
        entry["files"] = sorted({normalize_path(p, base) for p in paths})

    try:
        path = os.path.join(base, STATE_DIR, JOURNAL_FILE)
        os.makedirs(os.path.dirname(path), exist_ok=True)

        lines = []
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                lines = [ln for ln in fh.read().splitlines() if ln.strip()]
        lines.append(json.dumps(entry, ensure_ascii=False))

        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines[-KEEP:]) + "\n")
    except OSError:
        return entry
    return entry
