"""Resolución de imports y llamadas -> aristas del grafo.

Orden de búsqueda para cada llamada (especificación §5.2):
  1. Ámbito del mismo archivo (funciones anidadas, luego nivel superior,
     clases locales y `self.`/`this.` sobre la clase actual)  -> confirmed
  2. Símbolos importados explícitamente                       -> confirmed
  3. `obj.metodo()` sobre instancias sin tipo: se buscan métodos del
     proyecto con ese nombre (1..MAX_INFERRED_CANDIDATES)      -> inferred
Las llamadas a librerías externas o builtins no generan aristas.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from codemap.models import FileAnalysis, FunctionInfo, ImportBinding

CONFIRMED = "confirmed"
INFERRED = "inferred"

MAX_INFERRED_CANDIDATES = 3
MAX_REEXPORT_DEPTH = 3

SELF_NAMES = frozenset({"self", "cls", "this"})
JS_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx")
JS_SPECIFIER_EXTENSIONS = (".js", ".jsx", ".mjs", ".cjs")
CONSTRUCTOR_NAMES = {"python": "__init__"}  # JS/TS: "constructor"

# Objetos globales cuyos métodos nunca son del proyecto.
KNOWN_GLOBAL_OBJECTS = frozenset(
    {
        "console", "Math", "JSON", "Object", "Array", "Promise", "Number",
        "String", "Date", "Reflect", "Symbol", "document", "window",
        "globalThis", "process", "super",
    }
)
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z_$][\w$]*$")


@dataclass
class ProjectIndex:
    """Tablas de búsqueda construidas una vez por análisis."""

    files: dict[str, FileAnalysis]                    # ruta abs -> análisis
    file_ids: dict[str, str]                          # ruta abs -> ID relativo
    functions_by_file: dict[str, dict[str, FunctionInfo]]  # ruta abs -> qualname -> info
    methods_by_name: dict[str, list[str]]             # nombre corto -> IDs de métodos
    root_dir: str


@dataclass
class ResolvedCall:
    source_id: str
    target_id: str
    confidence: str
    line: int


# ---------------------------------------------------------------------------
# Índice
# ---------------------------------------------------------------------------

def function_id(file_id: str, qualname: str) -> str:
    """ID de nodo función según la especificación: 'src/engine.py::Value.backward'."""
    return f"{file_id}::{qualname}"


def build_index(analyses: list[FileAnalysis], file_ids: dict[str, str], root_dir: str) -> ProjectIndex:
    index = ProjectIndex(
        files={a.path: a for a in analyses},
        file_ids=file_ids,
        functions_by_file={},
        methods_by_name={},
        root_dir=root_dir,
    )
    for analysis in analyses:
        functions = {f.qualname: f for f in analysis.functions}
        index.functions_by_file[analysis.path] = functions
        for function in analysis.functions:
            if function.class_name is not None:
                fid = function_id(file_ids[analysis.path], function.qualname)
                index.methods_by_name.setdefault(function.short_name, []).append(fid)
    return index


def resolve_project(index: ProjectIndex) -> list[ResolvedCall]:
    """Todas las llamadas resueltas del proyecto (sin agregar)."""
    resolved: list[ResolvedCall] = []
    for path, analysis in index.files.items():
        file_id = index.file_ids[path]
        for function in analysis.functions:
            source_id = function_id(file_id, function.qualname)
            for call in function.calls:
                for target_id, confidence in resolve_call(call.callee, function, analysis, index):
                    resolved.append(ResolvedCall(source_id, target_id, confidence, call.line))
    return resolved


# ---------------------------------------------------------------------------
# Módulos: especificador de import -> archivo del proyecto
# ---------------------------------------------------------------------------

def resolve_module(module: str, importer: FileAnalysis, index: ProjectIndex) -> str | None:
    """Ruta absoluta del archivo importado, o None si es externo / no existe."""
    if importer.language == "python":
        return resolve_python_module(module, importer.path, index)
    return resolve_js_module(module, importer.path, index)


def python_module_candidates(base: Path, dotted: str) -> list[Path]:
    """'a.b' bajo base -> [base/a/b.py, base/a/b/__init__.py]."""
    if not dotted:
        return [base / "__init__.py"]
    parts = dotted.split(".")
    return [
        base.joinpath(*parts[:-1], parts[-1] + ".py"),
        base.joinpath(*parts, "__init__.py"),
    ]


def first_known(candidates: list[Path], index: ProjectIndex) -> str | None:
    for candidate in candidates:
        posix = candidate.as_posix()
        if posix in index.files:
            return posix
    return None


def resolve_python_module(module: str, importer_path: str, index: ProjectIndex) -> str | None:
    importer_dir = Path(importer_path).parent

    if module.startswith("."):  # relativo: '.utils', '..pkg.mod', '.'
        dots = len(module) - len(module.lstrip("."))
        base = importer_dir
        for _ in range(dots - 1):
            base = base.parent
        return first_known(python_module_candidates(base, module[dots:]), index)

    # Absoluto: probamos raíz del proyecto, carpeta del importador y raíz/src.
    root = Path(index.root_dir)
    for base in (root, importer_dir, root / "src"):
        found = first_known(python_module_candidates(base, module), index)
        if found is not None:
            return found
    return None


def resolve_js_module(specifier: str, importer_path: str, index: ProjectIndex) -> str | None:
    """Solo imports relativos ('./x', '../y'); paquetes y alias son externos."""
    if not specifier.startswith("."):
        return None
    joined = os.path.normpath(os.path.join(os.path.dirname(importer_path), specifier))
    base = Path(joined)

    candidates = [base]
    candidates += [Path(joined + ext) for ext in JS_EXTENSIONS]
    candidates += [base / f"index{ext}" for ext in JS_EXTENSIONS]
    # TS con ESM escribe './x.js' aunque el archivo real sea './x.ts'.
    if base.suffix in JS_SPECIFIER_EXTENSIONS:
        stem = joined[: -len(base.suffix)]
        candidates += [Path(stem + ext) for ext in JS_EXTENSIONS]
    return first_known(candidates, index)


# ---------------------------------------------------------------------------
# Símbolos: nombre importado -> función del proyecto
# ---------------------------------------------------------------------------

def find_binding(analysis: FileAnalysis, local_name: str) -> ImportBinding | None:
    for binding in analysis.imports:
        if binding.local_name == local_name:
            return binding
    return None


def resolve_binding(
    binding: ImportBinding, importer: FileAnalysis, index: ProjectIndex
) -> tuple[str, str | None] | None:
    """(archivo destino, símbolo) de un import; símbolo None = módulo completo."""
    if binding.imported_name is None:
        target = resolve_module(binding.module, importer, index)
        return (target, None) if target else None

    if importer.language == "python":
        # `from paquete import submodulo` importa un módulo, no un símbolo.
        separator = "" if binding.module.endswith(".") else "."
        submodule = resolve_module(binding.module + separator + binding.imported_name, importer, index)
        if submodule is not None:
            return submodule, None

    target = resolve_module(binding.module, importer, index)
    return (target, binding.imported_name) if target else None


def constructor_qualname(class_name: str, language: str) -> str:
    return f"{class_name}.{CONSTRUCTOR_NAMES.get(language, 'constructor')}"


def find_symbol(file_path: str, symbol: str, index: ProjectIndex, depth: int = 0) -> str | None:
    """ID de la función que `symbol` designa en `file_path`.
    Clases -> su constructor. Sigue re-exports hasta MAX_REEXPORT_DEPTH."""
    analysis = index.files[file_path]
    functions = index.functions_by_file[file_path]
    file_id = index.file_ids[file_path]

    if symbol == "default":
        if analysis.default_export is None:
            return None
        symbol = analysis.default_export

    if symbol in functions:
        return function_id(file_id, symbol)

    if symbol in analysis.class_names:
        constructor = constructor_qualname(symbol, analysis.language)
        return function_id(file_id, constructor) if constructor in functions else None

    if depth >= MAX_REEXPORT_DEPTH:
        return None
    binding = find_binding(analysis, symbol)
    if binding is None:
        return None
    target = resolve_binding(binding, analysis, index)
    if target is None or target[1] is None:
        return None
    return find_symbol(target[0], target[1], index, depth + 1)


# ---------------------------------------------------------------------------
# Llamadas
# ---------------------------------------------------------------------------

def lookup_in_scope(name: str, function: FunctionInfo, functions: dict[str, FunctionInfo]) -> str | None:
    """Busca `name` en las funciones contenedoras (anidadas) y luego en el nivel superior."""
    container = function.container
    while container is not None:
        candidate = f"{container}.{name}"
        if candidate in functions:
            return candidate
        parent = functions.get(container)
        container = parent.container if parent else None
    return name if name in functions else None


def resolve_call(
    callee: str, function: FunctionInfo, analysis: FileAnalysis, index: ProjectIndex
) -> list[tuple[str, str]]:
    """Lista de (target_id, confidence) para una llamada."""
    if "." not in callee:
        return resolve_bare_call(callee, function, analysis, index)
    obj, _, member = callee.rpartition(".")
    return resolve_member_call(obj, member, function, analysis, index)


def resolve_bare_call(
    name: str, function: FunctionInfo, analysis: FileAnalysis, index: ProjectIndex
) -> list[tuple[str, str]]:
    """foo()  /  Clase()  /  new Clase()"""
    functions = index.functions_by_file[analysis.path]
    file_id = index.file_ids[analysis.path]

    local = lookup_in_scope(name, function, functions)
    if local is not None:
        return [(function_id(file_id, local), CONFIRMED)]

    if name in analysis.class_names:
        target = find_symbol(analysis.path, name, index)
        return [(target, CONFIRMED)] if target else []

    binding = find_binding(analysis, name)
    if binding is None:
        return []  # builtin o global desconocido
    resolved = resolve_binding(binding, analysis, index)
    if resolved is None:
        return []  # import externo
    target_file, symbol = resolved
    target = find_symbol(target_file, symbol or "default", index)
    return [(target, CONFIRMED)] if target else []


def resolve_member_call(
    obj: str, member: str, function: FunctionInfo, analysis: FileAnalysis, index: ProjectIndex
) -> list[tuple[str, str]]:
    """obj.metodo()"""
    functions = index.functions_by_file[analysis.path]
    file_id = index.file_ids[analysis.path]

    # self.metodo() / this.metodo() dentro de una clase.
    if obj in SELF_NAMES and function.class_name is not None:
        qualname = f"{function.class_name}.{member}"
        if qualname in functions:
            return [(function_id(file_id, qualname), CONFIRMED)]
        return infer_by_member(member, index)  # heredado: origen incierto

    # Clase.metodo() con clase local.
    if obj in analysis.class_names and f"{obj}.{member}" in functions:
        return [(function_id(file_id, f"{obj}.{member}"), CONFIRMED)]

    # modulo.funcion() o ClaseImportada.metodo().
    root_name = obj.split(".")[0]
    binding = find_binding(analysis, obj) or find_binding(analysis, root_name)
    if binding is not None:
        resolved = resolve_binding(binding, analysis, index)
        if resolved is None:
            return []  # librería externa: os.path.join, np.array...
        target_file, symbol = resolved
        wanted = member if symbol is None else f"{symbol}.{member}"
        target = find_symbol(target_file, wanted, index)
        if target is not None:
            return [(target, CONFIRMED)]
        return infer_by_member(member, index)

    if root_name in KNOWN_GLOBAL_OBJECTS or not IDENTIFIER_PATTERN.match(root_name):
        return []

    # Instancia dinámica sin tipo estático.
    return infer_by_member(member, index)


def infer_by_member(member: str, index: ProjectIndex) -> list[tuple[str, str]]:
    candidates = index.methods_by_name.get(member, [])
    if 1 <= len(candidates) <= MAX_INFERRED_CANDIDATES:
        return [(candidate, INFERRED) for candidate in candidates]
    return []
