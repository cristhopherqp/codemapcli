"""Resolución de imports, alias de rutas, llamadas, triggers reactivos y puente HTML.

Orden de búsqueda para cada llamada (especificación §5.2):
  1. Ámbito del mismo archivo (funciones anidadas, luego nivel superior,
     clases locales y `self.`/`this.` sobre la clase actual)  -> confirmed
  2. Símbolos importados explícitamente (incluye alias TS/JS) -> confirmed
  3. `obj.metodo()` sobre instancias sin tipo: se buscan métodos del
     proyecto con ese nombre (1..MAX_INFERRED_CANDIDATES)      -> inferred
Las llamadas a librerías externas o builtins no generan aristas.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from codemap.models import (
    EDGE_DIRECT_CALL,
    EDGE_EVENT_LISTENER,
    EDGE_REACTIVE_SUBSCRIBE,
    EDGE_REACTIVE_TRIGGER,
    EDGE_READS_VAR,
    FileAnalysis,
    FunctionInfo,
    ImportBinding,
    VariableInfo,
)
from codemap.roles import is_notifier_name, is_reactive_registrar

CONFIRMED = "confirmed"
INFERRED = "inferred"

MAX_INFERRED_CANDIDATES = 3
MAX_REEXPORT_DEPTH = 3
MAX_TSCONFIG_EXTENDS_DEPTH = 5

SELF_NAMES = frozenset({"self", "cls", "this"})
JS_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx")
JS_SPECIFIER_EXTENSIONS = (".js", ".jsx", ".mjs", ".cjs")
CONSTRUCTOR_NAMES = {"python": "__init__"}  # JS/TS: "constructor"
JS_ALIAS_PREFIXES = ("@/", "~/")

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
class JsPathConfig:
    """Configuración de alias/baseUrl extraída de tsconfig.json o jsconfig.json."""

    config_dir: Path
    base_dir: Path
    has_base_url: bool
    paths: list[tuple[str, list[str]]] = field(default_factory=list)


@dataclass
class ProjectIndex:
    """Tablas de búsqueda construidas una vez por análisis."""

    files: dict[str, FileAnalysis]                         # ruta abs -> análisis
    file_ids: dict[str, str]                               # ruta abs -> ID relativo
    functions_by_file: dict[str, dict[str, FunctionInfo]]  # ruta abs -> qualname -> info
    methods_by_name: dict[str, list[str]]                  # nombre corto -> IDs de métodos
    root_dir: str
    variables_by_file: dict[str, dict[str, VariableInfo]] = field(default_factory=dict)
    path_by_file_id: dict[str, str] = field(default_factory=dict)
    js_configs_by_dir: dict[str, JsPathConfig | None] = field(default_factory=dict)
    _js_config_cache: dict[str, JsPathConfig | None] = field(default_factory=dict)


@dataclass
class ResolvedCall:
    source_id: str
    target_id: str
    confidence: str
    line: int
    edge_type: str = EDGE_DIRECT_CALL
    event: str = ""
    via: str = ""
    is_invocation: bool = True


@dataclass
class ResolvedModuleCall:
    """Llamada o registro de callback a nivel de módulo resuelto a una función del proyecto."""

    file_path: str
    file_id: str
    target_id: str
    confidence: str
    line: int
    edge_type: str = EDGE_DIRECT_CALL
    event: str = ""
    via: str = ""
    is_invocation: bool = True
    is_top_level_stmt: bool = False
    is_main_guard: bool = False


@dataclass
class HtmlScriptLink:
    """Conexión resuelta `<script src="...">` desde un archivo HTML hacia un script local."""

    html_path: str
    html_id: str
    script_path: str
    script_id: str
    line: int
    is_module: bool = False


@dataclass
class ServerHtmlLink:
    """Conexión resuelta desde un archivo o función de servidor hacia un archivo HTML local."""

    source_file_path: str
    source_file_id: str
    source_function_id: str | None
    html_path: str
    html_id: str
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
        path_by_file_id={fid: path for path, fid in file_ids.items()},
    )
    for analysis in analyses:
        functions = {f.qualname: f for f in analysis.functions}
        index.functions_by_file[analysis.path] = functions
        index.variables_by_file[analysis.path] = {v.qualname: v for v in analysis.variables}
        for function in analysis.functions:
            if function.class_name is not None:
                fid = function_id(file_ids[analysis.path], function.qualname)
                index.methods_by_name.setdefault(function.short_name, []).append(fid)
    return index


def resolve_project(index: ProjectIndex) -> list[ResolvedCall]:
    """Todas las llamadas y callbacks resueltos dentro de funciones (sin agregar)."""
    resolved: list[ResolvedCall] = []
    for path, analysis in index.files.items():
        if analysis.language == "html":
            continue
        file_id = index.file_ids[path]
        for function in analysis.functions:
            source_id = function_id(file_id, function.qualname)
            for call in function.calls:
                allow_ctor = call.is_invocation
                allow_inferred = call.is_invocation or call.kind in (
                    EDGE_EVENT_LISTENER,
                    EDGE_REACTIVE_SUBSCRIBE,
                )
                targets = resolve_call(
                    call.callee,
                    function,
                    analysis,
                    index,
                    allow_class_constructor=allow_ctor,
                    allow_inferred_member=allow_inferred,
                )
                for target_id, confidence in targets:
                    resolved.append(
                        ResolvedCall(
                            source_id=source_id,
                            target_id=target_id,
                            confidence=confidence,
                            line=call.line,
                            edge_type=call.kind,
                            event=call.event,
                            via=call.via,
                            is_invocation=call.is_invocation,
                        )
                    )
    return resolved


def resolve_module_calls(index: ProjectIndex) -> list[ResolvedModuleCall]:
    """Resuelve llamadas y callbacks de nivel superior (top-level) en cada archivo."""
    resolved: list[ResolvedModuleCall] = []
    for path, analysis in index.files.items():
        if analysis.language == "html" or not analysis.module_calls:
            continue
        file_id = index.file_ids[path]
        for call in analysis.module_calls:
            allow_ctor = call.is_invocation
            allow_inferred = call.is_invocation or call.kind in (
                EDGE_EVENT_LISTENER,
                EDGE_REACTIVE_SUBSCRIBE,
            )
            targets = resolve_call(
                call.callee,
                None,
                analysis,
                index,
                allow_class_constructor=allow_ctor,
                allow_inferred_member=allow_inferred,
            )
            for target_id, confidence in targets:
                resolved.append(
                    ResolvedModuleCall(
                        file_path=path,
                        file_id=file_id,
                        target_id=target_id,
                        confidence=confidence,
                        line=call.line,
                        edge_type=call.kind,
                        event=call.event,
                        via=call.via,
                        is_invocation=call.is_invocation,
                        is_top_level_stmt=call.is_top_level_stmt,
                        is_main_guard=call.is_main_guard,
                    )
                )
    return resolved


def _find_notifiers_for_registrar(registrar_id: str, index: ProjectIndex) -> list[str]:
    """Dado `archivo::subscribeState` o `store.tsx::Store.subscribe`, ubica sus notificadores."""
    if "::" not in registrar_id:
        return []
    reg_file_id, reg_qualname = registrar_id.split("::", 1)
    reg_path = index.path_by_file_id.get(reg_file_id)
    if reg_path is None:
        return []
    reg_analysis = index.files.get(reg_path)
    reg_fn = index.functions_by_file.get(reg_path, {}).get(reg_qualname)
    if reg_analysis is None or reg_fn is None:
        return []

    notifiers: list[str] = []
    for fn in reg_analysis.functions:
        if fn.qualname == reg_qualname:
            continue
        if reg_fn.class_name is not None:
            if fn.class_name != reg_fn.class_name:
                continue
        else:
            if fn.class_name is not None or fn.container is not None:
                continue
        if is_notifier_name(fn.short_name):
            notifiers.append(function_id(reg_file_id, fn.qualname))
    return notifiers or [registrar_id]


def resolve_reactive_triggers(
    calls: list[ResolvedCall],
    module_calls: list[ResolvedModuleCall],
    index: ProjectIndex,
) -> list[ResolvedCall]:
    """Deduce aristas de disparo reactivo (`notifier -> subscriber`) en patrones Observer/Pub-Sub.

    Ejemplo: cuando `app.js::initApp` llama `subscribeState(updateUI)` o
    `subscribeState(() => updateUI())`, el flujo real de ejecución al cambiar el estado
    va desde `state.js::notifyStateChange` (o `subscribeState`) hacia `app.js::updateUI`.
    """
    triggers: list[ResolvedCall] = []
    seen: set[tuple[str, str]] = set()

    def _emit_for_registrar(via_callee: str, fn_ctx: FunctionInfo | None, analysis: FileAnalysis, subscriber_id: str, line: int) -> None:
        if not via_callee:
            return
        registrars = resolve_call(via_callee, fn_ctx, analysis, index)
        for reg_id, _conf in registrars:
            for notifier_id in _find_notifiers_for_registrar(reg_id, index):
                if notifier_id == subscriber_id:
                    continue
                pair = (notifier_id, subscriber_id)
                if pair in seen:
                    continue
                seen.add(pair)
                triggers.append(
                    ResolvedCall(
                        source_id=notifier_id,
                        target_id=subscriber_id,
                        confidence=INFERRED,
                        line=line,
                        edge_type=EDGE_REACTIVE_TRIGGER,
                        via=reg_id,
                        is_invocation=False,
                    )
                )

    # 1. Suscripciones desde dentro de funciones.
    for call in calls:
        if call.edge_type != EDGE_REACTIVE_SUBSCRIBE or not call.via:
            continue
        if "::" not in call.source_id:
            continue
        src_file_id, src_qn = call.source_id.split("::", 1)
        src_path = index.path_by_file_id.get(src_file_id)
        if src_path is None:
            continue
        src_analysis = index.files.get(src_path)
        src_fn = index.functions_by_file.get(src_path, {}).get(src_qn)
        if src_analysis is None:
            continue
        _emit_for_registrar(call.via, src_fn, src_analysis, call.target_id, call.line)

    # 2. Suscripciones desde el nivel de módulo (referencia directa).
    for mc in module_calls:
        if mc.edge_type != EDGE_REACTIVE_SUBSCRIBE or not mc.via:
            continue
        src_analysis = index.files.get(mc.file_path)
        if src_analysis is None:
            continue
        _emit_for_registrar(mc.via, None, src_analysis, mc.target_id, mc.line)

    # 3. Callbacks anónimos de nivel de módulo pasados a `subscribe*(() => ...)`.
    for path, analysis in index.files.items():
        if analysis.language == "html":
            continue
        file_id = index.file_ids[path]
        for fn in analysis.functions:
            if fn.callback_via and is_reactive_registrar(fn.callback_via):
                sub_id = function_id(file_id, fn.qualname)
                _emit_for_registrar(fn.callback_via, None, analysis, sub_id, fn.line)

    return triggers


# ---------------------------------------------------------------------------
# Configuración tsconfig.json / jsconfig.json (JSONC) y alias JS/TS
# ---------------------------------------------------------------------------

def _strip_jsonc(raw: str) -> str:
    """Elimina comentarios `//` y `/* ... */` y comas finales fuera de strings JSON."""
    out: list[str] = []
    i = 0
    n = len(raw)
    in_string = False
    while i < n:
        ch = raw[i]
        if in_string:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(raw[i + 1])
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < n and raw[i + 1] == "/":
            i += 2
            while i < n and raw[i] not in ("\n", "\r"):
                i += 1
            continue
        if ch == "/" and i + 1 < n and raw[i + 1] == "*":
            i += 2
            while i + 1 < n and not (raw[i] == "*" and raw[i + 1] == "/"):
                i += 1
            i = min(n, i + 2)
            continue
        out.append(ch)
        i += 1

    # Quitar comas colgantes antes de `}` o `]` fuera de strings.
    no_comments = "".join(out)
    cleaned: list[str] = []
    in_string = False
    j = 0
    m = len(no_comments)
    while j < m:
        ch = no_comments[j]
        if in_string:
            cleaned.append(ch)
            if ch == "\\" and j + 1 < m:
                cleaned.append(no_comments[j + 1])
                j += 2
                continue
            if ch == '"':
                in_string = False
            j += 1
            continue
        if ch == '"':
            in_string = True
            cleaned.append(ch)
            j += 1
            continue
        if ch == ",":
            k = j + 1
            while k < m and no_comments[k] in " \t\r\n":
                k += 1
            if k < m and no_comments[k] in "}]":
                j += 1
                continue
        cleaned.append(ch)
        j += 1
    return "".join(cleaned)


def _read_jsonc_object(path: Path) -> dict | None:
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
        data = json.loads(_strip_jsonc(raw))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _sort_path_patterns(paths_map: dict[str, list[str]]) -> list[tuple[str, list[str]]]:
    """Ordena patrones de mayor especificidad a menor (exactos primero, luego prefijo+sufijo más largo)."""
    def sort_key(item: tuple[str, list[str]]) -> tuple[int, int, str]:
        pattern = item[0]
        has_wild = 1 if "*" in pattern else 0
        static_len = len(pattern.replace("*", ""))
        return (has_wild, -static_len, pattern)

    return sorted(paths_map.items(), key=sort_key)


def _load_js_path_config(
    config_path: Path,
    cache: dict[str, JsPathConfig | None],
    depth: int = 0,
    root_dir: Path | None = None,
) -> JsPathConfig | None:
    try:
        resolved_config = config_path.resolve()
    except OSError:
        return None
    key = resolved_config.as_posix()
    if key in cache:
        return cache[key]
    if root_dir is not None and not resolved_config.is_relative_to(root_dir):
        cache[key] = None
        return None
    if depth > MAX_TSCONFIG_EXTENDS_DEPTH or not resolved_config.is_file():
        cache[key] = None
        return None

    data = _read_jsonc_object(resolved_config)
    if data is None:
        cache[key] = None
        return None

    config_dir = resolved_config.parent
    merged_paths: dict[str, list[str]] = {}
    base_dir = config_dir
    has_base_url = False

    extends_raw = data.get("extends")
    if isinstance(extends_raw, str) and extends_raw.strip():
        ext_spec = extends_raw.strip()
        if ext_spec.startswith("."):
            ext_candidates = [config_dir / ext_spec]
            if not ext_spec.endswith(".json"):
                ext_candidates.append(config_dir / f"{ext_spec}.json")
            for ext_path in ext_candidates:
                try:
                    resolved_ext = ext_path.resolve()
                except OSError:
                    continue
                if root_dir is not None and not resolved_ext.is_relative_to(root_dir):
                    continue
                if resolved_ext.is_file():
                    parent_cfg = _load_js_path_config(
                        resolved_ext, cache, depth + 1, root_dir=root_dir
                    )
                    if parent_cfg is not None:
                        base_dir = parent_cfg.base_dir
                        has_base_url = parent_cfg.has_base_url
                        for pat, targets in parent_cfg.paths:
                            merged_paths[pat] = list(targets)
                    break

    compiler_options = data.get("compilerOptions")
    if isinstance(compiler_options, dict):
        raw_base = compiler_options.get("baseUrl")
        if isinstance(raw_base, str) and raw_base.strip():
            base_dir = (config_dir / raw_base.strip()).resolve()
            has_base_url = True
        raw_paths = compiler_options.get("paths")
        if isinstance(raw_paths, dict):
            for pat, targets in raw_paths.items():
                if not isinstance(pat, str) or not isinstance(targets, list):
                    continue
                valid_targets = [t.strip() for t in targets if isinstance(t, str) and t.strip()]
                if valid_targets:
                    merged_paths[pat] = valid_targets

    cfg = JsPathConfig(
        config_dir=config_dir,
        base_dir=base_dir,
        has_base_url=has_base_url,
        paths=_sort_path_patterns(merged_paths),
    )
    cache[key] = cfg
    return cfg


def _find_js_path_config(importer_path: str, index: ProjectIndex) -> JsPathConfig | None:
    """Busca el `tsconfig.json` o `jsconfig.json` más cercano subiendo hasta `root_dir`."""
    importer_dir = Path(importer_path).resolve().parent
    dir_key = importer_dir.as_posix()
    if dir_key in index.js_configs_by_dir:
        return index.js_configs_by_dir[dir_key]

    root = Path(index.root_dir).resolve()
    visited: list[str] = []
    cursor = importer_dir
    found: JsPathConfig | None = None

    while True:
        c_key = cursor.as_posix()
        if c_key in index.js_configs_by_dir:
            found = index.js_configs_by_dir[c_key]
            break
        visited.append(c_key)

        for cfg_name in ("tsconfig.json", "jsconfig.json"):
            candidate = cursor / cfg_name
            if candidate.is_file():
                found = _load_js_path_config(candidate, index._js_config_cache, root_dir=root)
                break
        if found is not None:
            break
        if cursor == root or cursor.parent == cursor:
            break
        try:
            cursor.relative_to(root)
        except ValueError:
            break
        cursor = cursor.parent

    for v_key in visited:
        index.js_configs_by_dir[v_key] = found
    return found


def _match_ts_path_pattern(specifier: str, pattern: str) -> str | None:
    """Empareja un patrón de `compilerOptions.paths` (exacto o con un `*`)."""
    if "*" not in pattern:
        return "" if specifier == pattern else None
    prefix, suffix = pattern.split("*", 1)
    if not specifier.startswith(prefix) or not specifier.endswith(suffix):
        return None
    if len(specifier) < len(prefix) + len(suffix):
        return None
    end_idx = len(specifier) - len(suffix) if suffix else len(specifier)
    return specifier[len(prefix):end_idx]


def is_js_local_alias(specifier: str, importer_path: str, index: ProjectIndex) -> bool:
    """True si el especificador JS/TS corresponde a una ruta local o alias (nunca paquete npm)."""
    if specifier.startswith(("./", "../", "/", *JS_ALIAS_PREFIXES, "#")):
        return True
    if specifier.startswith(("http://", "https://", "node:", "data:")):
        return True
    cfg = _find_js_path_config(importer_path, index)
    if cfg is not None:
        for pattern, _targets in cfg.paths:
            if _match_ts_path_pattern(specifier, pattern) is not None:
                return True
    return False


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
        try:
            resolved_posix = candidate.resolve().as_posix()
        except OSError:
            continue
        if resolved_posix in index.files:
            return resolved_posix
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


def _js_file_candidates(base: Path) -> list[Path]:
    joined = base.as_posix()
    candidates = [base]
    candidates += [Path(joined + ext) for ext in JS_EXTENSIONS]
    candidates += [base / f"index{ext}" for ext in JS_EXTENSIONS]
    # TS con ESM escribe './x.js' aunque el archivo real sea './x.ts'.
    if base.suffix in JS_SPECIFIER_EXTENSIONS:
        stem = joined[: -len(base.suffix)]
        candidates += [Path(stem + ext) for ext in JS_EXTENSIONS]
    return candidates


def _fallback_js_bases(importer_path: str, index: ProjectIndex, *, include_public: bool = False) -> list[Path]:
    """Bases ordenadas para resolver alias de respaldo (`@/`, `~/`, `/`) incluso en monorepos."""
    root = Path(index.root_dir).resolve()
    importer_dir = Path(importer_path).resolve().parent
    bases: list[Path] = []

    def _add(p: Path) -> None:
        if p not in bases:
            bases.append(p)

    # 1. Raíz de paquete más cercana (package.json / tsconfig.json / jsconfig.json) y ancestros `src`.
    cursor = importer_dir
    while True:
        if cursor.name == "src":
            _add(cursor)
            _add(cursor.parent)
        if any((cursor / marker).is_file() for marker in ("tsconfig.json", "jsconfig.json", "package.json")):
            _add(cursor / "src")
            _add(cursor)
            if include_public:
                _add(cursor / "public")
        if cursor == root or cursor.parent == cursor:
            break
        try:
            cursor.relative_to(root)
        except ValueError:
            break
        cursor = cursor.parent

    # 2. Raíz del proyecto y `root/src`.
    _add(root / "src")
    _add(root)
    if include_public:
        _add(root / "public")
    return bases


def resolve_js_module(specifier: str, importer_path: str, index: ProjectIndex) -> str | None:
    """Resuelve imports relativos (`./`, `../`), `tsconfig.json`/`jsconfig.json` y alias `@/`, `~/`, `/`."""
    # 1. Relativos estándar.
    if specifier.startswith("."):
        joined = os.path.normpath(os.path.join(os.path.dirname(importer_path), specifier))
        return first_known(_js_file_candidates(Path(joined)), index)

    # 2. Alias / baseUrl declarados en tsconfig.json o jsconfig.json.
    cfg = _find_js_path_config(importer_path, index)
    if cfg is not None:
        for pattern, targets in cfg.paths:
            matched = _match_ts_path_pattern(specifier, pattern)
            if matched is None:
                continue
            for target_pattern in targets:
                substituted = (
                    target_pattern.replace("*", matched, 1) if "*" in target_pattern else target_pattern
                )
                joined = os.path.normpath(os.path.join(str(cfg.base_dir), substituted))
                found = first_known(_js_file_candidates(Path(joined)), index)
                if found is not None:
                    return found
        if cfg.has_base_url and not specifier.startswith(("/", *JS_ALIAS_PREFIXES)):
            joined = os.path.normpath(os.path.join(str(cfg.base_dir), specifier))
            found = first_known(_js_file_candidates(Path(joined)), index)
            if found is not None:
                return found

    # 3. Respaldo para alias comunes `@/...` y `~/...`.
    for prefix in JS_ALIAS_PREFIXES:
        if specifier.startswith(prefix):
            subpath = specifier[len(prefix):]
            for base in _fallback_js_bases(importer_path, index):
                joined = os.path.normpath(os.path.join(str(base), subpath))
                found = first_known(_js_file_candidates(Path(joined)), index)
                if found is not None:
                    return found
            return None

    # 4. Respaldo para rutas absolutas relativas a la raíz (`/src/...`, `/js/...`).
    if specifier.startswith("/") and not specifier.startswith("//"):
        subpath = specifier.lstrip("/")
        for base in _fallback_js_bases(importer_path, index, include_public=True):
            joined = os.path.normpath(os.path.join(str(base), subpath))
            found = first_known(_js_file_candidates(Path(joined)), index)
            if found is not None:
                return found
        return None

    return None


# ---------------------------------------------------------------------------
# Puente HTML: `<script src="...">` y referencias servidor -> `.html`
# ---------------------------------------------------------------------------

def _resolve_html_script_path(src: str, html_path: str, index: ProjectIndex) -> str | None:
    html_dir = Path(html_path).resolve().parent
    cleaned = src.strip()
    if not cleaned:
        return None

    candidates_bases: list[Path] = []
    if cleaned.startswith("/"):
        subpath = cleaned.lstrip("/")
        for base in _fallback_js_bases(html_path, index, include_public=True):
            candidates_bases.append(Path(os.path.normpath(os.path.join(str(base), subpath))))
        candidates_bases.append(Path(os.path.normpath(os.path.join(str(html_dir), subpath))))
    else:
        candidates_bases.append(Path(os.path.normpath(os.path.join(str(html_dir), cleaned))))
        for base in _fallback_js_bases(html_path, index, include_public=True):
            candidates_bases.append(Path(os.path.normpath(os.path.join(str(base), cleaned))))

    for base in candidates_bases:
        found = first_known(_js_file_candidates(base), index)
        if found is not None and index.files[found].language != "html":
            return found
    return None


def _path_distance(path_a: Path, path_b: Path) -> int:
    parts_a = path_a.resolve().parent.parts
    parts_b = path_b.resolve().parent.parts
    common = 0
    for a, b in zip(parts_a, parts_b):
        if a == b:
            common += 1
        else:
            break
    return (len(parts_a) - common) + (len(parts_b) - common)


def _match_html_target(
    ref_target: str,
    importer_path: str,
    static_dirs: list[str],
    html_paths: list[str],
    index: ProjectIndex,
) -> str | None:
    if not html_paths:
        return None
    html_set = set(html_paths)
    importer_dir = Path(importer_path).resolve().parent
    root = Path(index.root_dir).resolve()
    cleaned = ref_target.strip().lstrip("/")

    # 1. Coincidencia exacta relativa a la carpeta del archivo, dirs estáticos o raíz.
    search_bases = [importer_dir, root]
    for sdir in static_dirs:
        search_bases.append((importer_dir / sdir).resolve())
        search_bases.append((root / sdir).resolve())
    for base in search_bases:
        candidate = Path(os.path.normpath(os.path.join(str(base), cleaned)))
        found = first_known([candidate], index)
        if found in html_set:
            return found

    # 2. Coincidencia por sufijo de ruta POSIX o nombre base (priorizando el más cercano).
    suffix_matches = [
        hp for hp in html_paths
        if index.file_ids[hp] == cleaned or index.file_ids[hp].endswith("/" + cleaned)
    ]
    if suffix_matches:
        suffix_matches.sort(key=lambda hp: (_path_distance(Path(importer_path), Path(hp)), index.file_ids[hp]))
        return suffix_matches[0]

    target_name = Path(cleaned).name.lower()
    name_matches = [hp for hp in html_paths if Path(hp).name.lower() == target_name]
    if len(name_matches) == 1:
        return name_matches[0]
    if len(name_matches) > 1:
        name_matches.sort(key=lambda hp: (_path_distance(Path(importer_path), Path(hp)), index.file_ids[hp]))
        if _path_distance(Path(importer_path), Path(name_matches[0])) < _path_distance(
            Path(importer_path), Path(name_matches[1])
        ):
            return name_matches[0]
    return None


def resolve_html_bridges(index: ProjectIndex) -> tuple[list[HtmlScriptLink], list[ServerHtmlLink]]:
    """Resuelve conexiones `HTML -> <script src>` y `servidor -> HTML`."""
    html_paths = sorted(
        (p for p, a in index.files.items() if a.language == "html"),
        key=lambda p: index.file_ids[p],
    )
    script_links: list[HtmlScriptLink] = []
    server_links: list[ServerHtmlLink] = []

    if not html_paths:
        return script_links, server_links

    # 1. HTML -> scripts locales.
    for html_path in html_paths:
        html_analysis = index.files[html_path]
        html_id = index.file_ids[html_path]
        seen_scripts: set[str] = set()
        for ref in html_analysis.script_refs:
            script_path = _resolve_html_script_path(ref.src, html_path, index)
            if script_path is None or script_path in seen_scripts:
                continue
            seen_scripts.add(script_path)
            script_links.append(
                HtmlScriptLink(
                    html_path=html_path,
                    html_id=html_id,
                    script_path=script_path,
                    script_id=index.file_ids[script_path],
                    line=ref.line,
                    is_module=ref.is_module,
                )
            )

    # 2. Servidor / código -> HTML (solo archivos de servidor o montaje estático).
    explicitly_served_htmls: set[str] = set()
    deferred_server_files: list[tuple[str, str, FileAnalysis]] = []

    for path, analysis in index.files.items():
        if analysis.language == "html":
            continue
        if not (analysis.is_server_file or analysis.serves_static_dirs):
            continue
        file_id = index.file_ids[path]
        matched_any = False
        seen_pairs: set[tuple[str | None, str]] = set()

        for href in analysis.html_refs:
            html_path = _match_html_target(
                href.target, path, analysis.serves_static_dirs, html_paths, index
            )
            if html_path is None:
                continue
            src_fn_id = function_id(file_id, href.owner_qualname) if href.owner_qualname else None
            pair = (src_fn_id, html_path)
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            matched_any = True
            explicitly_served_htmls.add(html_path)
            server_links.append(
                ServerHtmlLink(
                    source_file_path=path,
                    source_file_id=file_id,
                    source_function_id=src_fn_id,
                    html_path=html_path,
                    html_id=index.file_ids[html_path],
                    line=href.line,
                )
            )

        if not matched_any:
            deferred_server_files.append((path, file_id, analysis))

    # Heurística de servidor estático cuando no hubo literal `.html` explícito.
    for path, file_id, analysis in deferred_server_files:
        html_path = _match_html_target(
            "index.html", path, analysis.serves_static_dirs or [".", "public", "static"], html_paths, index
        )
        if html_path is None:
            continue
        if html_path in explicitly_served_htmls and not analysis.serves_static_dirs:
            continue
        server_links.append(
            ServerHtmlLink(
                source_file_path=path,
                source_file_id=file_id,
                source_function_id=None,
                html_path=html_path,
                html_id=index.file_ids[html_path],
                line=1,
            )
        )

    return script_links, server_links


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


def find_symbol(
    file_path: str,
    symbol: str,
    index: ProjectIndex,
    depth: int = 0,
    *,
    allow_class_constructor: bool = True,
) -> str | None:
    """ID de la función que `symbol` designa en `file_path`.
    Clases -> su constructor (si `allow_class_constructor`). Sigue re-exports hasta MAX_REEXPORT_DEPTH."""
    analysis = index.files[file_path]
    functions = index.functions_by_file[file_path]
    file_id = index.file_ids[file_path]

    if symbol == "default":
        if analysis.default_export is None:
            return None
        symbol = analysis.default_export

    if symbol in functions:
        return function_id(file_id, symbol)

    if allow_class_constructor and symbol in analysis.class_names:
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
    return find_symbol(
        target[0],
        target[1],
        index,
        depth + 1,
        allow_class_constructor=allow_class_constructor,
    )


# ---------------------------------------------------------------------------
# Llamadas
# ---------------------------------------------------------------------------

def lookup_in_scope(
    name: str, function: FunctionInfo | None, functions: dict[str, FunctionInfo]
) -> str | None:
    """Busca `name` en funciones anidadas directas, contenedoras y nivel superior."""
    if function is not None:
        direct_nested = f"{function.qualname}.{name}"
        if direct_nested in functions:
            return direct_nested
    container = function.container if function is not None else None
    while container is not None:
        candidate = f"{container}.{name}"
        if candidate in functions:
            return candidate
        parent = functions.get(container)
        container = parent.container if parent else None
    return name if name in functions else None


def resolve_call(
    callee: str,
    function: FunctionInfo | None,
    analysis: FileAnalysis,
    index: ProjectIndex,
    *,
    allow_class_constructor: bool = True,
    allow_inferred_member: bool = True,
) -> list[tuple[str, str]]:
    """Lista de (target_id, confidence) para una llamada o callback."""
    if "." not in callee:
        return resolve_bare_call(
            callee,
            function,
            analysis,
            index,
            allow_class_constructor=allow_class_constructor,
        )
    obj, _, member = callee.rpartition(".")
    return resolve_member_call(
        obj,
        member,
        function,
        analysis,
        index,
        allow_inferred_member=allow_inferred_member,
    )


def resolve_bare_call(
    name: str,
    function: FunctionInfo | None,
    analysis: FileAnalysis,
    index: ProjectIndex,
    *,
    allow_class_constructor: bool = True,
) -> list[tuple[str, str]]:
    """foo()  /  Clase()  /  new Clase()  /  callback_ref"""
    functions = index.functions_by_file[analysis.path]
    file_id = index.file_ids[analysis.path]

    local = lookup_in_scope(name, function, functions)
    if local is not None:
        return [(function_id(file_id, local), CONFIRMED)]

    if allow_class_constructor and name in analysis.class_names:
        target = find_symbol(analysis.path, name, index, allow_class_constructor=True)
        return [(target, CONFIRMED)] if target else []

    binding = find_binding(analysis, name)
    if binding is None:
        return []  # builtin o global desconocido
    resolved = resolve_binding(binding, analysis, index)
    if resolved is None:
        return []  # import externo
    target_file, symbol = resolved
    target = find_symbol(
        target_file,
        symbol or "default",
        index,
        allow_class_constructor=allow_class_constructor,
    )
    return [(target, CONFIRMED)] if target else []


def resolve_member_call(
    obj: str,
    member: str,
    function: FunctionInfo | None,
    analysis: FileAnalysis,
    index: ProjectIndex,
    *,
    allow_inferred_member: bool = True,
) -> list[tuple[str, str]]:
    """obj.metodo()  /  self.metodo  /  mod.funcion"""
    functions = index.functions_by_file[analysis.path]
    file_id = index.file_ids[analysis.path]

    # self.metodo() / this.metodo() dentro de una clase.
    if obj in SELF_NAMES and function is not None and function.class_name is not None:
        qualname = f"{function.class_name}.{member}"
        if qualname in functions:
            return [(function_id(file_id, qualname), CONFIRMED)]
        return infer_by_member(member, index) if allow_inferred_member else []

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
        target = find_symbol(target_file, wanted, index, allow_class_constructor=allow_inferred_member)
        if target is not None:
            return [(target, CONFIRMED)]
        return infer_by_member(member, index) if allow_inferred_member else []

    if root_name in KNOWN_GLOBAL_OBJECTS or not IDENTIFIER_PATTERN.match(root_name):
        return []

    # Instancia dinámica sin tipo estático.
    return infer_by_member(member, index) if allow_inferred_member else []


def infer_by_member(member: str, index: ProjectIndex) -> list[tuple[str, str]]:
    candidates = index.methods_by_name.get(member, [])
    if 1 <= len(candidates) <= MAX_INFERRED_CANDIDATES:
        return [(candidate, INFERRED) for candidate in candidates]
    return []


# ---------------------------------------------------------------------------
# Variables / constantes top-level (`edge_type: "reads_var"`)
# ---------------------------------------------------------------------------

def find_variable_symbol(
    file_path: str,
    symbol: str,
    index: ProjectIndex,
    depth: int = 0,
) -> str | None:
    """Resuelve un nombre de variable/constante top-level en `file_path` siguiendo re-exports."""
    analysis = index.files.get(file_path)
    if analysis is None:
        return None
    variables = index.variables_by_file.get(file_path, {})
    file_id = index.file_ids[file_path]

    if symbol == "default":
        if analysis.default_export is None:
            return None
        symbol = analysis.default_export

    if symbol in variables:
        return function_id(file_id, symbol)

    if depth >= MAX_REEXPORT_DEPTH:
        return None
    binding = find_binding(analysis, symbol)
    if binding is None:
        return None
    target = resolve_binding(binding, analysis, index)
    if target is None or target[1] is None:
        return None
    return find_variable_symbol(target[0], target[1], index, depth + 1)


def resolve_variable_refs(index: ProjectIndex) -> list[ResolvedCall]:
    """Resuelve referencias de lectura desde funciones hacia variables/constantes top-level."""
    resolved: list[ResolvedCall] = []
    for path, analysis in index.files.items():
        if analysis.language == "html":
            continue
        file_id = index.file_ids[path]
        local_vars = index.variables_by_file.get(path, {})

        for function in analysis.functions:
            if not function.var_refs:
                continue
            source_id = function_id(file_id, function.qualname)
            for ref in function.var_refs:
                target_id: str | None = None
                if "." in ref.name:
                    obj, _, member = ref.name.partition(".")
                    binding = find_binding(analysis, obj)
                    if binding is not None:
                        bound = resolve_binding(binding, analysis, index)
                        if bound is not None and bound[1] is None:
                            target_id = find_variable_symbol(bound[0], member, index)
                else:
                    if ref.name in local_vars:
                        target_id = function_id(file_id, ref.name)
                    else:
                        binding = find_binding(analysis, ref.name)
                        if binding is not None:
                            bound = resolve_binding(binding, analysis, index)
                            if bound is not None:
                                target_id = find_variable_symbol(bound[0], bound[1] or "default", index)

                if target_id is not None and target_id != source_id:
                    resolved.append(
                        ResolvedCall(
                            source_id=source_id,
                            target_id=target_id,
                            confidence=CONFIRMED,
                            line=ref.line,
                            edge_type=EDGE_READS_VAR,
                            is_invocation=False,
                        )
                    )
    return resolved
