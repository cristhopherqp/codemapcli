"""Construcción de graph.json (esquema §4.A de la especificación).

Jerarquía de nodos (padres antes que hijos):
  module (carpeta)  ->  file  ->  function
Las aristas se agregan por par (origen, destino) con `call_count`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import builtins
import sys
from urllib.parse import quote

from codemap.models import (
    EDGE_CALLBACK_REF,
    EDGE_DIRECT_CALL,
    EDGE_EVENT_LISTENER,
    EDGE_LOADS_SCRIPT,
    EDGE_REACTIVE_SUBSCRIBE,
    EDGE_REACTIVE_TRIGGER,
    EDGE_SERVES_HTML,
    ENTRY_KIND_EVENT,
    ENTRY_KIND_MAIN,
    ENTRY_KIND_ROUTE,
    ENTRY_KIND_UNREFERENCED,
    CallSite,
    FileAnalysis,
    FunctionInfo,
    ImportBinding,
)
from codemap.resolver import (
    CONFIRMED,
    HtmlScriptLink,
    ProjectIndex,
    ResolvedCall,
    ResolvedModuleCall,
    ServerHtmlLink,
    build_index,
    find_binding,
    function_id,
    is_js_local_alias,
    resolve_binding,
    resolve_call,
    resolve_html_bridges,
    resolve_module_calls,
    resolve_project,
    resolve_reactive_triggers,
)
from codemap.roles import (
    classify_role,
    is_boot_event_name,
    is_route_registrar,
)

JS_NATIVE_OBJECTS = frozenset(
    {
        "console",
        "fetch",
        "Promise",
        "JSON",
        "Math",
        "Array",
        "Object",
        "Map",
        "Set",
        "Date",
        "URL",
        "URLSearchParams",
        "Number",
        "String",
        "Boolean",
        "RegExp",
        "Symbol",
        "Reflect",
        "Intl",
        "Error",
        "document",
        "window",
        "navigator",
        "localStorage",
        "sessionStorage",
        "crypto",
        "performance",
        "AbortController",
        "FormData",
        "Headers",
        "Request",
        "Response",
        "WebSocket",
        "WeakMap",
        "WeakSet",
    }
)
JS_NATIVE_GLOBAL_FUNCTIONS = frozenset(
    {
        "fetch",
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "parseInt",
        "parseFloat",
        "isNaN",
        "isFinite",
        "encodeURIComponent",
        "decodeURIComponent",
        "encodeURI",
        "decodeURI",
        "structuredClone",
        "atob",
        "btoa",
        "queueMicrotask",
        "URL",
        "URLSearchParams",
        "Date",
        "Map",
        "Set",
        "Promise",
        "RegExp",
        "Error",
        "FormData",
        "WebSocket",
        "AbortController",
        "Headers",
        "Request",
        "Response",
    }
)
JS_STANDARD_METHODS: dict[str, tuple[str, str]] = {
    # Array
    **{
        m: ("Array", "Array.prototype")
        for m in (
            "forEach", "map", "filter", "reduce", "reduceRight", "find",
            "findIndex", "findLast", "findLastIndex", "some", "every",
            "flat", "flatMap", "push", "pop", "shift", "unshift", "splice",
            "slice", "concat", "join", "reverse", "sort", "toSorted",
            "toReversed", "toSpliced", "includes", "indexOf", "lastIndexOf",
            "at", "fill", "copyWithin", "entries", "keys", "values", "with",
        )
    },
    # String
    **{
        m: ("String", "String.prototype")
        for m in (
            "split", "trim", "trimStart", "trimEnd", "replace", "replaceAll",
            "match", "matchAll", "search", "startsWith", "endsWith",
            "substring", "substr", "padStart", "padEnd", "repeat",
            "toLowerCase", "toUpperCase", "toLocaleLowerCase",
            "toLocaleUpperCase", "charAt", "charCodeAt", "codePointAt",
            "localeCompare", "normalize",
        )
    },
    # Promise
    "then": ("Promise", "Promise.prototype"),
    "catch": ("Promise", "Promise.prototype"),
    "finally": ("Promise", "Promise.prototype"),
    # Object / Function / Number / RegExp
    "hasOwnProperty": ("Object", "Object.prototype"),
    "bind": ("Function", "Function.prototype"),
    "call": ("Function", "Function.prototype"),
    "apply": ("Function", "Function.prototype"),
    "toFixed": ("Number", "Number.prototype"),
    "toPrecision": ("Number", "Number.prototype"),
    "toExponential": ("Number", "Number.prototype"),
    "test": ("RegExp", "RegExp.prototype"),
    "exec": ("RegExp", "RegExp.prototype"),
    # Date
    **{
        m: ("Date", "Date.prototype")
        for m in (
            "getTime", "setTime", "getFullYear", "getMonth", "getDate",
            "getDay", "getHours", "getMinutes", "getSeconds", "toISOString",
            "toLocaleDateString", "toLocaleTimeString", "toLocaleString",
        )
    },
    # Map / Set
    "has": ("Map / Set", "Map.prototype"),
    "delete": ("Map / Set", "Map.prototype"),
    "clear": ("Map / Set", "Map.prototype"),
    "get": ("Map", "Map.prototype"),
    "set": ("Map", "Map.prototype"),
    "add": ("Set", "Set.prototype"),
    # DOM / Web APIs / Fetch / Storage
    **{
        m: ("DOM / Web APIs", "Element")
        for m in (
            "querySelector", "querySelectorAll", "createElement",
            "appendChild", "removeChild", "replaceChild", "insertBefore",
            "setAttribute", "getAttribute", "removeAttribute", "hasAttribute",
            "closest", "matches", "scrollIntoView", "getBoundingClientRect",
        )
    },
    **{
        m: ("DOM / Web APIs", "Document")
        for m in ("getElementById", "getElementsByClassName", "getElementsByTagName", "createTextNode")
    },
    "addEventListener": ("DOM / Web APIs", "EventTarget"),
    "removeEventListener": ("DOM / Web APIs", "EventTarget"),
    "dispatchEvent": ("DOM / Web APIs", "EventTarget"),
    "preventDefault": ("DOM / Web APIs", "Event"),
    "stopPropagation": ("DOM / Web APIs", "Event"),
    "focus": ("DOM / Web APIs", "HTMLElement"),
    "blur": ("DOM / Web APIs", "HTMLElement"),
    "json": ("Fetch Response", "Response.prototype"),
    "text": ("Fetch Response", "Response.prototype"),
    "blob": ("Fetch Response", "Response.prototype"),
    "arrayBuffer": ("Fetch Response", "Response.prototype"),
    "getItem": ("Web Storage", "Storage.prototype"),
    "setItem": ("Web Storage", "Storage.prototype"),
    "removeItem": ("Web Storage", "Storage.prototype"),
}

PYTHON_STR_METHODS = frozenset(
    {
        "split", "rsplit", "splitlines", "join", "strip", "lstrip", "rstrip",
        "replace", "lower", "upper", "title", "capitalize", "startswith",
        "endswith", "find", "rfind", "isdigit", "isalpha", "isalnum", "isspace",
        "format", "encode", "removeprefix", "removesuffix", "partition",
        "rpartition", "zfill", "rjust", "ljust",
    }
)
PYTHON_LIST_METHODS = frozenset({"append", "extend", "insert", "remove", "pop", "clear", "sort", "reverse"})
PYTHON_DICT_METHODS = frozenset({"keys", "values", "items", "setdefault", "update", "popitem", "get"})
PYTHON_SET_METHODS = frozenset(
    {"add", "discard", "union", "intersection", "difference", "symmetric_difference", "issubset", "issuperset"}
)

AMBIGUOUS_RECEIVERS = frozenset({"app", "router", "server", "route", "client", "api", "http", "https", "axios", "request", "req", "ws"})
AMBIGUOUS_METHODS = frozenset({"get", "set", "delete", "add", "clear", "update", "pop", "remove"})
CANVAS_2D_RECEIVERS = frozenset({"ctx", "context", "ctx2d", "c2d", "context2d"})
CANVAS_2D_METHODS = frozenset(
    {
        "fill", "stroke", "beginPath", "closePath", "moveTo", "lineTo",
        "arc", "arcTo", "ellipse", "rect", "roundRect",
        "fillRect", "strokeRect", "clearRect",
        "fillText", "strokeText", "measureText",
        "drawImage", "getImageData", "putImageData", "createImageData",
        "save", "restore", "translate", "rotate", "scale", "transform",
        "setTransform", "resetTransform", "clip", "isPointInPath",
        "quadraticCurveTo", "bezierCurveTo",
        "setLineDash", "getLineDash",
        "createLinearGradient", "createRadialGradient", "createConicGradient", "createPattern",
    }
)
HTML_CANVAS_METHODS = frozenset({"getContext", "toDataURL", "toBlob", "transferControlToOffscreen"})
SELF_RECEIVER_PREFIXES = ("self.", "cls.", "this.")
PYTHON_BUILTINS = frozenset(name for name in dir(builtins) if not name.startswith("_"))

# Niveles de apertura (§3). El Nivel "3+" se codifica como 4 en meta.recommended_level.
LEVEL_ARCHITECTURE = 1
LEVEL_INTERCONNECTION = 2
LEVEL_FILE_FLOW = 3
LEVEL_INTRA_FUNCTION = 4

LARGE_PROJECT_FUNCTIONS = 25
TINY_FILE_FUNCTIONS = 2

ENTRY_FILE_STEMS = frozenset({"main", "index", "app", "server", "cli", "__main__"})
FALLBACK_ENTRY_FN_NAMES = frozenset({"bootstrap", "init", "initApp", "start", "startApp", "run", "setup"})

EDGE_TYPE_PRIORITY: dict[str, int] = {
    EDGE_DIRECT_CALL: 1,
    EDGE_SERVES_HTML: 2,
    EDGE_LOADS_SCRIPT: 2,
    EDGE_EVENT_LISTENER: 3,
    EDGE_REACTIVE_SUBSCRIBE: 4,
    EDGE_CALLBACK_REF: 5,
    EDGE_REACTIVE_TRIGGER: 6,
}


def build_graph(
    analyses: list[FileAnalysis],
    target_path: str,
    root_dir: str,
    is_single_file: bool,
    include_private: bool,
) -> dict:
    """Devuelve el diccionario listo para serializar como graph.json.

    target_path: lo que el usuario pidió analizar (archivo o carpeta).
    root_dir:    carpeta base para los IDs relativos (la carpeta del archivo
                 en modo archivo suelto).
    """
    file_ids = {a.path: Path(a.path).relative_to(Path(root_dir)).as_posix() for a in analyses}
    index = build_index(analyses, file_ids, root_dir)

    fn_calls = resolve_project(index)
    module_calls = resolve_module_calls(index)
    reactive_triggers = resolve_reactive_triggers(fn_calls, module_calls, index)
    html_script_links, server_html_links = resolve_html_bridges(index)

    active_html_paths = {link.html_path for link in html_script_links} | {
        link.html_path for link in server_html_links
    }
    active_analyses = [
        a for a in analyses if a.language != "html" or is_single_file or a.path in active_html_paths
    ]
    active_file_ids = {a.path: file_ids[a.path] for a in active_analyses}
    active_file_id_set = set(active_file_ids.values())

    visible_ids = visible_function_ids(index, include_private)

    # Clasificación semántica de puntos de entrada, rutas y handlers de eventos.
    entry_meta = _classify_entries(
        index=index,
        visible_ids=visible_ids,
        fn_calls=fn_calls,
        reactive_triggers=reactive_triggers,
        module_calls=module_calls,
        html_script_links=html_script_links,
        server_html_links=server_html_links,
        active_file_ids=active_file_ids,
    )

    # Aristas combinadas: llamadas de función + triggers reactivos + puente HTML + top-level entre archivos.
    bridge_calls = _build_bridge_calls(
        index=index,
        visible_ids=visible_ids,
        active_file_id_set=active_file_id_set,
        module_calls=module_calls,
        html_script_links=html_script_links,
        server_html_links=server_html_links,
        module_entry_ids=entry_meta["module_entry_ids"],
        main_entry_fn_ids=entry_meta["main_entry_fn_ids"],
    )
    all_calls = fn_calls + reactive_triggers + bridge_calls
    valid_endpoint_ids = visible_ids | active_file_id_set
    edges = aggregate_edges(all_calls, valid_endpoint_ids)

    # Funciones hoja visibles: llamadas por otra función (no solo cargadas por HTML), sin salidas a otras funciones.
    fn_incoming_ids = {
        edge["target"]
        for edge in edges
        if edge["source"] != edge["target"]
        and edge["target"] in visible_ids
        and edge["source"] in visible_ids
    }
    fn_outgoing_ids = {
        edge["source"]
        for edge in edges
        if edge["source"] != edge["target"] and edge["source"] in visible_ids
    }
    terminal_ids = fn_incoming_ids - fn_outgoing_ids

    function_nodes = build_function_nodes(
        index=index,
        visible_ids=visible_ids,
        called_ids=entry_meta["has_callers_ids"],
        terminal_ids=terminal_ids,
        entry_kinds=entry_meta["entry_kinds"],
        module_entry_ids=entry_meta["module_entry_ids"],
    )
    file_nodes = build_file_nodes(
        active_analyses,
        active_file_ids,
        main_entry_files=entry_meta["main_entry_files"],
        scripts_by_html=entry_meta["scripts_by_html"],
        htmls_by_script=entry_meta["htmls_by_script"],
        module_entries_by_file=entry_meta["module_entries_by_file"],
    )
    module_nodes = build_module_nodes(active_file_ids.values())

    execution_flows = build_execution_flows(
        index=index,
        visible_ids=visible_ids,
        active_file_ids=active_file_ids,
        edges=edges,
        entry_meta=entry_meta,
        fn_calls=fn_calls,
        module_calls=module_calls,
        html_script_links=html_script_links,
        server_html_links=server_html_links,
    )

    total_functions = len(function_nodes)
    return {
        "meta": {
            "project_name": Path(target_path).name,
            "root_path": target_path,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "total_functions": total_functions,
            "recommended_level": recommended_level(total_functions, is_single_file),
            "main_entry_files": sorted(entry_meta["main_entry_files"]),
            "main_entry_functions": sorted(entry_meta["main_entry_fn_ids"]),
        },
        "nodes": module_nodes + file_nodes + function_nodes,
        "edges": edges,
        "execution_flows": execution_flows,
    }


def recommended_level(total_functions: int, is_single_file: bool) -> int:
    """Apertura adaptativa según tamaño (tabla de §3)."""
    if total_functions <= TINY_FILE_FUNCTIONS:
        return LEVEL_INTRA_FUNCTION
    if is_single_file:
        return LEVEL_FILE_FLOW
    if total_functions > LARGE_PROJECT_FUNCTIONS:
        return LEVEL_ARCHITECTURE
    return LEVEL_INTERCONNECTION


# ---------------------------------------------------------------------------
# Nodos
# ---------------------------------------------------------------------------

def is_private(function: FunctionInfo) -> bool:
    """_helper, __init__ (Python) y #metodo (JS) se ocultan sin --include-private."""
    return function.short_name.startswith(("_", "#"))


def visible_function_ids(index: ProjectIndex, include_private: bool) -> set[str]:
    visible: set[str] = set()
    for path, analysis in index.files.items():
        for function in analysis.functions:
            if include_private or not is_private(function):
                visible.add(function_id(index.file_ids[path], function.qualname))
    return visible


def build_module_nodes(file_ids) -> list[dict]:
    """Un nodo `module` por cada carpeta intermedia: 'src', 'src/core'..."""
    module_ids: set[str] = set()
    for file_id in file_ids:
        parts = file_id.split("/")[:-1]
        for depth in range(1, len(parts) + 1):
            module_ids.add("/".join(parts[:depth]))

    nodes = []
    for module_id in sorted(module_ids):
        parent = module_id.rpartition("/")[0] or None
        nodes.append(
            {
                "id": module_id,
                "type": "module",
                "parent": parent,
                "label": module_id.rpartition("/")[2] + "/",
            }
        )
    return nodes


def build_file_nodes(
    analyses: list[FileAnalysis],
    file_ids: dict[str, str],
    *,
    main_entry_files: set[str] | None = None,
    scripts_by_html: dict[str, list[str]] | None = None,
    htmls_by_script: dict[str, list[str]] | None = None,
    module_entries_by_file: dict[str, list[str]] | None = None,
) -> list[dict]:
    main_files = main_entry_files or set()
    scripts_map = scripts_by_html or {}
    htmls_map = htmls_by_script or {}
    mod_entries_map = module_entries_by_file or {}

    nodes = []
    for analysis in sorted(analyses, key=lambda a: file_ids[a.path]):
        file_id = file_ids[analysis.path]
        node: dict = {
            "id": file_id,
            "type": "file",
            "parent": file_id.rpartition("/")[0] or None,
            "label": file_id.rpartition("/")[2],
            "file_path": analysis.path,
            "language": analysis.language,
            "is_main_entry": file_id in main_files,
        }
        if file_id in scripts_map:
            node["script_targets"] = scripts_map[file_id]
        if file_id in htmls_map:
            node["loaded_by_html"] = htmls_map[file_id]
        if file_id in mod_entries_map:
            node["module_entry_functions"] = mod_entries_map[file_id]
        nodes.append(node)
    return nodes


def match_import_binding(analysis: FileAnalysis, callee: str) -> ImportBinding | None:
    """Find the most specific import binding matching a callee expression."""
    if "(" in callee or "[" in callee:
        # Chained call on a return value (e.g. re.sub(...).strip) is not an import attribute.
        prefix_before_call = callee.split("(", 1)[0].split("[", 1)[0]
        if "." in callee[len(prefix_before_call):]:
            return None
    parts = callee.split(".")
    for end in range(len(parts), 0, -1):
        binding = find_binding(analysis, ".".join(parts[:end]))
        if binding is not None:
            return binding
    return None


def _canonical_python_symbol(callee: str, binding: ImportBinding) -> str:
    if binding.imported_name:
        if callee == binding.local_name:
            return f"{binding.module}.{binding.imported_name}"
        if callee.startswith(binding.local_name + "."):
            suffix = callee[len(binding.local_name) + 1 :]
            return f"{binding.module}.{binding.imported_name}.{suffix}"
    if callee == binding.local_name:
        return binding.module
    if callee.startswith(binding.local_name + "."):
        suffix = callee[len(binding.local_name) + 1 :]
        return f"{binding.module}.{suffix}"
    return callee


def _is_ambiguous_receiver(obj: str, member: str) -> bool:
    if member not in AMBIGUOUS_METHODS:
        return False
    receiver_tail = obj.rsplit(".", 1)[-1].split("[", 1)[0].split("(", 1)[0].lower()
    return receiver_tail in AMBIGUOUS_RECEIVERS


def _is_canvas_context_receiver(obj: str) -> bool:
    receiver_tail = obj.rsplit(".", 1)[-1].split("[", 1)[0].split("(", 1)[0].lower()
    return receiver_tail in CANVAS_2D_RECEIVERS or receiver_tail.endswith(("ctx", "ctx2d", "context2d"))


def _is_canvas_element_receiver(obj: str) -> bool:
    receiver_tail = obj.rsplit(".", 1)[-1].split("[", 1)[0].split("(", 1)[0].lower()
    return receiver_tail == "canvas" or receiver_tail.endswith("canvas")


def classify_python_external(call: CallSite, analysis: FileAnalysis, index: ProjectIndex) -> dict | None:
    """Resolve an unresolved Python call to stdlib, PyPI, builtins, or std method docs."""
    binding = match_import_binding(analysis, call.callee)
    if binding is not None:
        if binding.module.startswith(".") or resolve_binding(binding, analysis, index) is not None:
            return None
        module = binding.module.split(".")[0]
        canonical = _canonical_python_symbol(call.callee, binding)
        if module in sys.stdlib_module_names:
            return {
                "api_id": f"py:{canonical}",
                "symbol": call.callee,
                "call_expr": call.callee,
                "module": module,
                "kind": "stdlib",
                "docs_url": f"https://docs.python.org/3/library/{module}.html",
                "line": call.line,
            }
        return {
            "api_id": f"py:{canonical}",
            "symbol": call.callee,
            "call_expr": call.callee,
            "module": module,
            "kind": "package",
            "docs_url": f"https://pypi.org/project/{module}/",
            "line": call.line,
        }

    if "." not in call.callee and call.callee not in analysis.class_names and call.callee in PYTHON_BUILTINS:
        return {
            "api_id": f"py:builtins.{call.callee}",
            "symbol": call.callee,
            "call_expr": call.callee,
            "module": "builtins",
            "kind": "stdlib",
            "docs_url": "https://docs.python.org/3/library/builtins.html",
            "line": call.line,
        }

    if "." in call.callee and not call.callee.startswith(SELF_RECEIVER_PREFIXES):
        obj, _, member = call.callee.rpartition(".")
        if _is_ambiguous_receiver(obj, member):
            return None
        if member == "decode":
            return {
                "api_id": "py:bytes.decode",
                "symbol": "bytes.decode",
                "call_expr": call.callee,
                "module": "bytes",
                "kind": "method",
                "docs_url": "https://docs.python.org/3/library/stdtypes.html#bytes.decode",
                "line": call.line,
            }
        if member in PYTHON_STR_METHODS:
            return {
                "api_id": f"py:str.{member}",
                "symbol": f"str.{member}",
                "call_expr": call.callee,
                "module": "str",
                "kind": "method",
                "docs_url": f"https://docs.python.org/3/library/stdtypes.html#str.{member}",
                "line": call.line,
            }
        if member in PYTHON_LIST_METHODS:
            return {
                "api_id": f"py:list.{member}",
                "symbol": f"list.{member}",
                "call_expr": call.callee,
                "module": "list",
                "kind": "method",
                "docs_url": "https://docs.python.org/3/library/stdtypes.html#mutable-sequence-types",
                "line": call.line,
            }
        if member in PYTHON_DICT_METHODS:
            return {
                "api_id": f"py:dict.{member}",
                "symbol": f"dict.{member}",
                "call_expr": call.callee,
                "module": "dict",
                "kind": "method",
                "docs_url": f"https://docs.python.org/3/library/stdtypes.html#dict.{member}",
                "line": call.line,
            }
        if member in PYTHON_SET_METHODS:
            return {
                "api_id": f"py:set.{member}",
                "symbol": f"set.{member}",
                "call_expr": call.callee,
                "module": "set",
                "kind": "method",
                "docs_url": "https://docs.python.org/3/library/stdtypes.html#set-types-set-frozenset",
                "line": call.line,
            }
    return None


def npm_package_name(module_specifier: str) -> str:
    """Extract the npm package root (preserving @scope/pkg) from an import specifier.
    Returns empty string for non-npm alias specifiers such as `@/...`."""
    if not module_specifier or module_specifier.startswith(("@/", "~/", "/", ".", "#")):
        return ""
    parts = module_specifier.split("/")
    if module_specifier.startswith("@"):
        if len(parts) < 2 or len(parts[0]) <= 1 or not parts[1]:
            return ""
        return f"{parts[0]}/{parts[1]}"
    return parts[0]


def classify_js_external(call: CallSite, analysis: FileAnalysis, index: ProjectIndex) -> dict | None:
    """Resolve an unresolved JS/TS call to native MDN globals, std methods, or npm docs."""
    binding = match_import_binding(analysis, call.callee)
    if binding is not None:
        if (
            is_js_local_alias(binding.module, analysis.path, index)
            or resolve_binding(binding, analysis, index) is not None
        ):
            return None
        package = npm_package_name(binding.module)
        if not package:
            return None
        return {
            "api_id": f"npm:{package}:{call.callee}",
            "symbol": call.callee,
            "call_expr": call.callee,
            "module": package,
            "kind": "package",
            "docs_url": f"https://www.npmjs.com/package/{quote(package, safe='@/')}",
            "line": call.line,
        }

    root = call.callee.split(".")[0]
    has_chained_call = "(" in call.callee or "[" in call.callee
    if not has_chained_call and (
        ("." in call.callee and root in JS_NATIVE_OBJECTS)
        or ("." not in call.callee and call.callee in JS_NATIVE_GLOBAL_FUNCTIONS)
    ):
        return {
            "api_id": f"js:{call.callee}",
            "symbol": call.callee,
            "call_expr": call.callee,
            "module": root,
            "kind": "native",
            "docs_url": f"https://developer.mozilla.org/en-US/search?q={quote(call.callee)}",
            "line": call.line,
        }

    if "." in call.callee and not call.callee.startswith(SELF_RECEIVER_PREFIXES):
        obj, _, member = call.callee.rpartition(".")
        if (obj == "classList" or obj.endswith(".classList")) and member in {
            "add", "remove", "toggle", "contains", "replace"
        }:
            symbol = f"DOMTokenList.{member}"
            return {
                "api_id": f"js:{symbol}",
                "symbol": symbol,
                "call_expr": call.callee,
                "module": "DOM / Web APIs",
                "kind": "method",
                "docs_url": f"https://developer.mozilla.org/en-US/search?q={quote(symbol)}",
                "line": call.line,
            }

        if _is_canvas_context_receiver(obj):
            if member in CANVAS_2D_METHODS:
                symbol = f"CanvasRenderingContext2D.{member}"
                return {
                    "api_id": f"js:{symbol}",
                    "symbol": symbol,
                    "call_expr": call.callee,
                    "module": "Canvas 2D",
                    "kind": "method",
                    "docs_url": f"https://developer.mozilla.org/en-US/search?q={quote(symbol)}",
                    "line": call.line,
                }
            # Evitar falsas clasificaciones (p. ej. ctx.fill / ctx.clear como Array o Map).
            if member in ("fill", "clear", "at", "keys", "values", "entries", "set", "get"):
                return None

        if _is_canvas_element_receiver(obj):
            if member in HTML_CANVAS_METHODS:
                symbol = f"HTMLCanvasElement.{member}"
                return {
                    "api_id": f"js:{symbol}",
                    "symbol": symbol,
                    "call_expr": call.callee,
                    "module": "Canvas 2D",
                    "kind": "method",
                    "docs_url": f"https://developer.mozilla.org/en-US/search?q={quote(symbol)}",
                    "line": call.line,
                }
            if member in ("fill", "clear"):
                return None

        if _is_ambiguous_receiver(obj, member):
            return None

        spec = JS_STANDARD_METHODS.get(member)
        if spec is not None:
            module_name, doc_prefix = spec
            if obj.startswith(('"', "'", "`")) and member in ("slice", "includes", "indexOf", "concat", "at"):
                module_name, doc_prefix = "String", "String.prototype"
            symbol = f"{doc_prefix}.{member}"
            return {
                "api_id": f"js:{symbol}",
                "symbol": symbol,
                "call_expr": call.callee,
                "module": module_name,
                "kind": "method",
                "docs_url": f"https://developer.mozilla.org/en-US/search?q={quote(symbol)}",
                "line": call.line,
            }
    return None


def collect_external_calls(function: FunctionInfo, analysis: FileAnalysis, index: ProjectIndex) -> list[dict]:
    """Collect deduplicated external library and native runtime calls for a function."""
    results: list[dict] = []
    seen: set[str] = set()
    is_python = analysis.language == "python"
    is_js = analysis.language in {"javascript", "typescript", "tsx"}

    for call in function.calls:
        if not call.is_invocation:
            continue
        if resolve_call(call.callee, function, analysis, index):
            continue
        entry = (
            classify_python_external(call, analysis, index)
            if is_python
            else classify_js_external(call, analysis, index)
            if is_js
            else None
        )
        if entry is None:
            continue
        api_key = entry["api_id"]
        if api_key in seen:
            continue
        seen.add(api_key)
        results.append(entry)
    return results


def build_function_nodes(
    index: ProjectIndex,
    visible_ids: set[str],
    called_ids: set[str],
    terminal_ids: set[str],
    *,
    entry_kinds: dict[str, str | None] | None = None,
    module_entry_ids: set[str] | None = None,
) -> list[dict]:
    kinds_map = entry_kinds or {}
    mod_entries = module_entry_ids or set()
    nodes = []
    for path in sorted(index.files, key=lambda p: index.file_ids[p]):
        file_id = index.file_ids[path]
        analysis = index.files[path]
        for function in analysis.functions:
            fid = function_id(file_id, function.qualname)
            if fid not in visible_ids:
                continue
            e_kind = kinds_map.get(fid)
            nodes.append(
                {
                    "id": fid,
                    "type": "function",
                    "parent": file_id,
                    "label": f"{function.qualname}()",
                    "role": classify_role(function, has_callers=fid in called_ids, entry_kind=e_kind),
                    "entry_kind": e_kind,
                    "is_main_entry": e_kind == ENTRY_KIND_MAIN,
                    "is_event_handler": e_kind in (ENTRY_KIND_EVENT, ENTRY_KIND_ROUTE),
                    "is_unreferenced": e_kind == ENTRY_KIND_UNREFERENCED,
                    "is_module_entry": fid in mod_entries,
                    "is_terminal": fid in terminal_ids,
                    "signature": function.signature,
                    "docstring": function.docstring,
                    "line": function.line,
                    "fingerprint": function.fingerprint,
                    "external_calls": collect_external_calls(function, analysis, index),
                    "internal_flow": [
                        {
                            "id": step.id,
                            "role": step.role,
                            "label": step.label,
                            "code": step.code or step.label,
                            "parent_id": step.parent_id,
                            "is_container": step.is_container,
                            "kind": step.kind,
                            "edges": [
                                {"target": edge.target, "label": edge.label, "kind": edge.kind}
                                for edge in step.edges
                            ],
                        }
                        for step in function.internal_flow
                    ],
                }
            )
    return nodes


# ---------------------------------------------------------------------------
# Clasificación de puntos de entrada, puente HTML y aristas
# ---------------------------------------------------------------------------

def _classify_entries(
    *,
    index: ProjectIndex,
    visible_ids: set[str],
    fn_calls: list[ResolvedCall],
    reactive_triggers: list[ResolvedCall],
    module_calls: list[ResolvedModuleCall],
    html_script_links: list[HtmlScriptLink],
    server_html_links: list[ServerHtmlLink],
    active_file_ids: dict[str, str],
) -> dict:
    """Clasifica funciones y archivos en puntos de arranque principal, rutas, handlers o huérfanas."""
    module_entry_ids: set[str] = set()
    module_entry_triggers: dict[str, str] = {}
    module_entries_by_file: dict[str, list[str]] = {}
    module_called_ids: set[str] = set()

    route_handler_ids: set[str] = set()
    event_handler_ids: set[str] = set()
    explicit_feature_roots: set[str] = set()
    feature_triggers: dict[str, str] = {}
    registered_by: dict[str, str | None] = {}

    def _register_feature(fid: str, is_route: bool, trigger: str, registrar: str | None) -> None:
        if fid not in visible_ids:
            return
        if is_route:
            route_handler_ids.add(fid)
        else:
            event_handler_ids.add(fid)
        explicit_feature_roots.add(fid)
        if fid not in feature_triggers or (trigger and not feature_triggers[fid]):
            feature_triggers[fid] = trigger
        if fid not in registered_by:
            registered_by[fid] = registrar

    # 1. Llamadas a nivel de módulo (top-level).
    for mc in module_calls:
        if mc.target_id not in visible_ids:
            continue
        module_called_ids.add(mc.target_id)
        is_boot_event = mc.edge_type == EDGE_EVENT_LISTENER and is_boot_event_name(mc.event)
        if mc.is_main_guard or is_boot_event or (mc.edge_type == EDGE_DIRECT_CALL and mc.is_top_level_stmt):
            module_entry_ids.add(mc.target_id)
            trig = (
                "main_guard"
                if mc.is_main_guard
                else (f"event:{mc.event}" if is_boot_event else "top_level")
            )
            module_entry_triggers.setdefault(mc.target_id, trig)
            entries_list = module_entries_by_file.setdefault(mc.file_id, [])
            if mc.target_id not in entries_list:
                entries_list.append(mc.target_id)
        elif mc.edge_type == EDGE_EVENT_LISTENER:
            is_route = is_route_registrar(mc.via, mc.event)
            trig = (
                f"route:{mc.event}"
                if (is_route and mc.event)
                else ("route" if is_route else (f"event:{mc.event}" if mc.event else "event"))
            )
            _register_feature(mc.target_id, is_route, trig, mc.file_id)

    # 2. Listeners y rutas registrados desde dentro de funciones (en dos pasadas
    # para no marcar como `event_handler` helpers locales o invocados directamente).
    fn_info_by_id: dict[str, FunctionInfo] = {}
    for path, analysis in index.files.items():
        if analysis.language == "html":
            continue
        fid_prefix = index.file_ids[path]
        for fn in analysis.functions:
            fid = function_id(fid_prefix, fn.qualname)
            if fid in visible_ids:
                fn_info_by_id[fid] = fn

    direct_caller_targets: set[str] = set()
    has_callers_ids: set[str] = set()
    for call in fn_calls + reactive_triggers:
        if call.source_id not in visible_ids or call.target_id not in visible_ids:
            continue
        if call.source_id != call.target_id:
            has_callers_ids.add(call.target_id)
            if call.edge_type == EDGE_DIRECT_CALL:
                direct_caller_targets.add(call.target_id)

    for call in fn_calls + reactive_triggers:
        if call.source_id not in visible_ids or call.target_id not in visible_ids:
            continue
        if call.edge_type != EDGE_EVENT_LISTENER:
            continue
        if is_boot_event_name(call.event):
            module_entry_ids.add(call.target_id)
            module_entry_triggers.setdefault(call.target_id, f"event:{call.event}")
            continue
        target_fn = fn_info_by_id.get(call.target_id)
        is_nested_helper = target_fn is not None and target_fn.container is not None
        if call.is_invocation:
            if call.target_id in direct_caller_targets or is_nested_helper:
                continue
        elif is_nested_helper and call.target_id in direct_caller_targets:
            continue
        is_route = is_route_registrar(call.via, call.event)
        trig = (
            f"route:{call.event}"
            if (is_route and call.event)
            else ("route" if is_route else (f"event:{call.event}" if call.event else "event"))
        )
        _register_feature(call.target_id, is_route, trig, call.source_id)

    # 3. Pistas sintácticas de los parsers (`main`, decoradores, callbacks de módulo).
    main_hint_ids: set[str] = set()
    module_callback_ids: set[str] = set()
    for path, analysis in index.files.items():
        if analysis.language == "html":
            continue
        file_id = index.file_ids[path]
        for fn in analysis.functions:
            fid = function_id(file_id, fn.qualname)
            if fid not in visible_ids:
                continue
            if fn.callback_via:
                module_callback_ids.add(fid)
            if fn.entry_kind_hint == ENTRY_KIND_MAIN:
                main_hint_ids.add(fid)
                module_entry_triggers.setdefault(
                    fid, f"event:{fn.event_trigger}" if fn.event_trigger else "explicit_main"
                )
            elif fn.entry_kind_hint == ENTRY_KIND_ROUTE:
                trig = f"route:{fn.event_trigger}" if fn.event_trigger else "route"
                _register_feature(fid, True, trig, None)
            elif fn.entry_kind_hint == ENTRY_KIND_EVENT:
                if fn.event_trigger:
                    _register_feature(fid, False, f"event:{fn.event_trigger}", None)
                elif fn.callback_via:
                    _register_feature(fid, False, "event", None)
                elif fid not in direct_caller_targets and fid not in has_callers_ids:
                    event_handler_ids.add(fid)

    # 4. Asignación final de `entry_kind` por función visible.
    entry_kinds: dict[str, str | None] = {}
    main_entry_fn_ids: set[str] = set()
    for fid in visible_ids:
        if fid in module_entry_ids or fid in main_hint_ids:
            entry_kinds[fid] = ENTRY_KIND_MAIN
            main_entry_fn_ids.add(fid)
        elif fid in route_handler_ids:
            entry_kinds[fid] = ENTRY_KIND_ROUTE
        elif fid in event_handler_ids:
            entry_kinds[fid] = ENTRY_KIND_EVENT
        elif (
            fid not in has_callers_ids
            and fid not in module_called_ids
            and fid not in module_callback_ids
        ):
            entry_kinds[fid] = ENTRY_KIND_UNREFERENCED
        else:
            entry_kinds[fid] = None

    # 5. Mapas HTML <-> scripts y archivos gestores (`is_main_entry`).
    scripts_by_html: dict[str, list[str]] = {}
    htmls_by_script: dict[str, list[str]] = {}
    html_module_scripts: set[str] = set()
    for link in html_script_links:
        scripts_by_html.setdefault(link.html_id, [])
        if link.script_id not in scripts_by_html[link.html_id]:
            scripts_by_html[link.html_id].append(link.script_id)
        htmls_by_script.setdefault(link.script_id, [])
        if link.html_id not in htmls_by_script[link.script_id]:
            htmls_by_script[link.script_id].append(link.html_id)
        if link.is_module:
            html_module_scripts.add(link.script_id)

    main_entry_files: set[str] = set()
    for html_id, targets in scripts_by_html.items():
        if targets:
            main_entry_files.add(html_id)
            module_targets = [t for t in targets if t in html_module_scripts]
            chosen = module_targets or [
                t for t in targets if not t.endswith(".min.js") and "/vendor/" not in f"/{t}"
            ] or targets
            for script_id in chosen:
                main_entry_files.add(script_id)

    for fid in main_entry_fn_ids:
        main_entry_files.add(fid.split("::", 1)[0])

    for mc in module_calls:
        if mc.target_id in visible_ids and (mc.is_main_guard or mc.is_top_level_stmt):
            main_entry_files.add(mc.file_id)

    for link in server_html_links:
        main_entry_files.add(link.source_file_id)
        main_entry_files.add(link.html_id)

    for path, file_id in active_file_ids.items():
        analysis = index.files[path]
        if analysis.is_server_file and any(
            mc.is_top_level_stmt for mc in analysis.module_calls if mc.is_invocation
        ):
            main_entry_files.add(file_id)

    return {
        "entry_kinds": entry_kinds,
        "has_callers_ids": has_callers_ids,
        "module_entry_ids": module_entry_ids,
        "module_entry_triggers": module_entry_triggers,
        "module_entries_by_file": module_entries_by_file,
        "main_entry_fn_ids": main_entry_fn_ids,
        "main_entry_files": main_entry_files,
        "explicit_feature_roots": explicit_feature_roots,
        "route_handler_ids": route_handler_ids,
        "feature_triggers": feature_triggers,
        "registered_by": registered_by,
        "scripts_by_html": scripts_by_html,
        "htmls_by_script": htmls_by_script,
    }


def _build_bridge_calls(
    *,
    index: ProjectIndex,
    visible_ids: set[str],
    active_file_id_set: set[str],
    module_calls: list[ResolvedModuleCall],
    html_script_links: list[HtmlScriptLink],
    server_html_links: list[ServerHtmlLink],
    module_entry_ids: set[str],
    main_entry_fn_ids: set[str],
) -> list[ResolvedCall]:
    """Genera aristas estructurales de puente HTML (`serves_html`, `loads_script`) y llamadas
    top-level entre archivos, evitando siempre aristas de contención padre -> hijo."""
    bridge: list[ResolvedCall] = []

    # 1. Servidor -> HTML.
    for link in server_html_links:
        if link.html_id not in active_file_id_set:
            continue
        source_id = (
            link.source_function_id
            if (link.source_function_id and link.source_function_id in visible_ids)
            else link.source_file_id
        )
        if source_id not in (visible_ids | active_file_id_set) or source_id == link.html_id:
            continue
        bridge.append(
            ResolvedCall(
                source_id=source_id,
                target_id=link.html_id,
                confidence=CONFIRMED,
                line=link.line,
                edge_type=EDGE_SERVES_HTML,
                is_invocation=False,
            )
        )

    # 2. HTML -> scripts locales (apunta a las funciones de arranque del script si existen).
    for link in html_script_links:
        if link.html_id not in active_file_id_set or link.script_id not in active_file_id_set:
            continue
        script_analysis = index.files.get(link.script_path)
        entry_targets: list[str] = []
        if script_analysis is not None:
            for fn in script_analysis.functions:
                fid = function_id(link.script_id, fn.qualname)
                if fid in visible_ids and (fid in module_entry_ids or fid in main_entry_fn_ids):
                    entry_targets.append(fid)
        if entry_targets:
            for target_fid in entry_targets:
                bridge.append(
                    ResolvedCall(
                        source_id=link.html_id,
                        target_id=target_fid,
                        confidence=CONFIRMED,
                        line=link.line,
                        edge_type=EDGE_LOADS_SCRIPT,
                        is_invocation=False,
                    )
                )
        else:
            bridge.append(
                ResolvedCall(
                    source_id=link.html_id,
                    target_id=link.script_id,
                    confidence=CONFIRMED,
                    line=link.line,
                    edge_type=EDGE_LOADS_SCRIPT,
                    is_invocation=False,
                )
            )

    # 3. Llamadas top-level entre archivos distintos (ej. `__main__.py` -> `cli.py::main`).
    for mc in module_calls:
        if mc.target_id not in visible_ids or mc.file_id not in active_file_id_set:
            continue
        target_file_id = mc.target_id.split("::", 1)[0]
        if target_file_id == mc.file_id:
            # Misma hoja/contenedor: nunca crear arista padre->hijo; se refleja en `is_module_entry`.
            continue
        bridge.append(
            ResolvedCall(
                source_id=mc.file_id,
                target_id=mc.target_id,
                confidence=mc.confidence,
                line=mc.line,
                edge_type=mc.edge_type,
                event=mc.event,
                via=mc.via,
                is_invocation=mc.is_invocation,
            )
        )

    return bridge


def _pick_primary_edge_type(current: str, candidate: str) -> str:
    cur_prio = EDGE_TYPE_PRIORITY.get(current, 99)
    cand_prio = EDGE_TYPE_PRIORITY.get(candidate, 99)
    return candidate if cand_prio < cur_prio else current


def aggregate_edges(calls: list[ResolvedCall], valid_ids: set[str]) -> list[dict]:
    """Una arista por par (origen, destino). Preserva campos base y añade `edge_type`."""
    grouped: dict[tuple[str, str], dict] = {}
    edge_types_seen: dict[tuple[str, str], list[str]] = {}

    for call in calls:
        if call.source_id not in valid_ids or call.target_id not in valid_ids:
            continue
        key = (call.source_id, call.target_id)
        edge = grouped.get(key)
        if edge is None:
            entry: dict = {
                "source": call.source_id,
                "target": call.target_id,
                "confidence": call.confidence,
                "call_count": 1,
                "line": call.line,
                "edge_type": call.edge_type,
            }
            if call.event:
                entry["event"] = call.event
            grouped[key] = entry
            edge_types_seen[key] = [call.edge_type]
            continue

        edge["call_count"] += 1
        edge["line"] = min(edge["line"], call.line)
        if call.confidence == CONFIRMED:
            edge["confidence"] = CONFIRMED
        edge["edge_type"] = _pick_primary_edge_type(edge["edge_type"], call.edge_type)
        if call.event and not edge.get("event"):
            edge["event"] = call.event
        if call.edge_type not in edge_types_seen[key]:
            edge_types_seen[key].append(call.edge_type)

    edges = []
    for number, (key, edge) in enumerate(grouped.items(), start=1):
        extra_types = edge_types_seen[key]
        if len(extra_types) > 1:
            edge["edge_types"] = sorted(extra_types, key=lambda t: EDGE_TYPE_PRIORITY.get(t, 99))
        edges.append({"id": f"e_{number}", **edge})
    return edges


# ---------------------------------------------------------------------------
# Hilos de ejecución deterministas (`execution_flows`)
# ---------------------------------------------------------------------------

def _short_flow_node_name(node_id: str) -> str:
    if "::" in node_id:
        file_part, fn_part = node_id.split("::", 1)
        return f"{Path(file_part).name}::{fn_part}"
    return node_id


def _trace_flow_tree(
    root_id: str,
    out_edges: dict[str, list[dict]],
    allowed_edge_types: frozenset[str],
    *,
    blocked_pairs: set[tuple[str, str]] | None = None,
    allow_boot_event_edges: bool = False,
) -> tuple[list[str], list[str], list[dict]]:
    """Recorrido DFS determinista (ordenado por línea) sin ciclos desde `root_id`."""
    blocked = blocked_pairs or set()
    visited: set[str] = {root_id}
    node_ids: list[str] = [root_id]
    edge_ids: list[str] = []
    edge_id_set: set[str] = set()
    steps: list[dict] = [
        {"order": 1, "node_id": root_id, "depth": 0, "edge_id": None, "edge_type": None}
    ]

    def dfs(current_id: str, depth: int) -> None:
        for edge in out_edges.get(current_id, []):
            e_type = edge.get("edge_type", EDGE_DIRECT_CALL)
            pair = (current_id, edge["target"])
            if pair in blocked:
                continue
            is_allowed = e_type in allowed_edge_types or (
                allow_boot_event_edges
                and e_type == EDGE_EVENT_LISTENER
                and is_boot_event_name(edge.get("event", ""))
            )
            if not is_allowed:
                continue
            target_id = edge["target"]
            if target_id == current_id:
                continue
            if edge["id"] not in edge_id_set:
                edge_id_set.add(edge["id"])
                edge_ids.append(edge["id"])
            if target_id in visited:
                continue
            visited.add(target_id)
            node_ids.append(target_id)
            steps.append(
                {
                    "order": len(steps) + 1,
                    "node_id": target_id,
                    "depth": depth + 1,
                    "edge_id": edge["id"],
                    "edge_type": e_type,
                }
            )
            dfs(target_id, depth + 1)

    dfs(root_id, 0)
    return node_ids, edge_ids, steps


def build_execution_flows(
    *,
    index: ProjectIndex,
    visible_ids: set[str],
    active_file_ids: dict[str, str],
    edges: list[dict],
    entry_meta: dict,
    fn_calls: list[ResolvedCall],
    module_calls: list[ResolvedModuleCall],
    html_script_links: list[HtmlScriptLink],
    server_html_links: list[ServerHtmlLink],
) -> list[dict]:
    """Precalcula hilos deterministas (`main` de arranque y `feature` por evento/ruta)."""
    out_edges: dict[str, list[dict]] = {}
    in_degree: dict[str, int] = {}
    for edge in edges:
        out_edges.setdefault(edge["source"], []).append(edge)
        if edge["source"] != edge["target"]:
            in_degree[edge["target"]] = in_degree.get(edge["target"], 0) + 1
    for edge_list in out_edges.values():
        edge_list.sort(key=lambda e: (e["line"], e["target"], e["id"]))

    # Pares (caller, subscriber) registrados en `subscribe*(cb)` no se ejecutan sincrónicamente en arranque.
    direct_pairs = {
        (c.source_id, c.target_id)
        for c in fn_calls
        if c.edge_type == EDGE_DIRECT_CALL and c.is_invocation
    }
    reactive_subscriber_pairs = {
        (c.source_id, c.target_id)
        for c in fn_calls
        if c.edge_type == EDGE_REACTIVE_SUBSCRIBE
        and c.via != ""
        and (c.source_id, c.target_id) not in direct_pairs
    }

    main_edge_types = frozenset(
        {
            EDGE_DIRECT_CALL,
            EDGE_SERVES_HTML,
            EDGE_LOADS_SCRIPT,
            EDGE_CALLBACK_REF,
            EDGE_REACTIVE_SUBSCRIBE,
        }
    )
    feature_edge_types = frozenset(
        {
            EDGE_DIRECT_CALL,
            EDGE_CALLBACK_REF,
            EDGE_REACTIVE_TRIGGER,
            EDGE_SERVES_HTML,
            EDGE_LOADS_SCRIPT,
        }
    )

    # 1. Candidatos a raíz del Hilo Principal (`main`).
    main_candidates: list[tuple[str, str]] = []  # (root_id, trigger)
    seen_main_candidates: set[str] = set()

    def _add_main_candidate(root_id: str, trigger: str) -> None:
        if root_id in seen_main_candidates:
            return
        seen_main_candidates.add(root_id)
        main_candidates.append((root_id, trigger))

    # 1a. Archivos servidor con `serves_html` a nivel de archivo (no handlers de ruta).
    for link in sorted(server_html_links, key=lambda x: (x.source_file_id, x.html_id)):
        if link.source_function_id is None and link.source_file_id in out_edges:
            _add_main_candidate(link.source_file_id, "server_html")

    # 1b. Archivos HTML de entrada que cargan scripts locales.
    for html_id in sorted(entry_meta["scripts_by_html"]):
        if html_id in out_edges:
            _add_main_candidate(html_id, "html_entry")

    # 1c. Archivos lanzadores con llamada top-level a otro archivo (ej. `__main__.py`).
    for mc in sorted(module_calls, key=lambda x: (x.file_id, x.line, x.target_id)):
        if mc.target_id in visible_ids and (mc.is_main_guard or mc.is_top_level_stmt):
            if mc.target_id.split("::", 1)[0] != mc.file_id and mc.file_id in out_edges:
                _add_main_candidate(mc.file_id, "module_launcher")

    # 1d. Funciones marcadas explícitamente como `main` / top-level boot.
    for fid in sorted(entry_meta["main_entry_fn_ids"]):
        _add_main_candidate(fid, entry_meta["module_entry_triggers"].get(fid, "main"))

    # Pre-trazar y podar raíces subsumidas por otra raíz principal (ej. `index.html` -> `app.js::initApp`).
    traced_mains: dict[str, tuple[str, list[str], list[str], list[dict]]] = {}
    for root_id, trigger in main_candidates:
        n_ids, e_ids, steps = _trace_flow_tree(
            root_id,
            out_edges,
            main_edge_types,
            blocked_pairs=reactive_subscriber_pairs,
            allow_boot_event_edges=True,
        )
        traced_mains[root_id] = (trigger, n_ids, e_ids, steps)

    subsumed_roots: set[str] = set()
    for root_a, (_, nodes_a, _, _) in traced_mains.items():
        nodes_a_set = set(nodes_a)
        for root_b in traced_mains:
            if root_b != root_a and root_b in nodes_a_set:
                subsumed_roots.add(root_b)

    flows: list[dict] = []
    covered_by_main: set[str] = set()
    main_idx = 0
    for root_id, _trigger in main_candidates:
        if root_id in subsumed_roots:
            continue
        trigger, n_ids, e_ids, steps = traced_mains[root_id]
        covered_by_main.update(n_ids)
        main_idx += 1
        flows.append(
            {
                "id": f"flow_main_{main_idx}",
                "kind": "main",
                "label": f"Hilo Principal · {_short_flow_node_name(root_id)}",
                "root_id": root_id,
                "trigger": trigger,
                "registered_by": None,
                "node_ids": n_ids,
                "edge_ids": e_ids,
                "steps": steps,
            }
        )

    # 1e. Respaldo para módulos de entrada independientes sin llamada top-level (ej. `main.ts::bootstrap`).
    files_with_main_flow = {
        nid.split("::", 1)[0] for nid in covered_by_main
    } | set(entry_meta["main_entry_files"])
    for path in sorted(active_file_ids, key=lambda p: active_file_ids[p]):
        analysis = index.files[path]
        if analysis.language == "html":
            continue
        file_id = active_file_ids[path]
        if file_id in files_with_main_flow:
            continue
        file_stem = Path(file_id).stem.lower()
        for fn in analysis.functions:
            fid = function_id(file_id, fn.qualname)
            if (
                fid not in visible_ids
                or fid in covered_by_main
                or fn.class_name is not None
                or fn.container is not None
            ):
                continue
            if fid in entry_meta["explicit_feature_roots"]:
                continue
            if in_degree.get(fid, 0) > 0 or not out_edges.get(fid):
                continue
            if file_stem in ENTRY_FILE_STEMS or fn.short_name in FALLBACK_ENTRY_FN_NAMES:
                n_ids, e_ids, steps = _trace_flow_tree(
                    fid,
                    out_edges,
                    main_edge_types,
                    blocked_pairs=reactive_subscriber_pairs,
                    allow_boot_event_edges=True,
                )
                covered_by_main.update(n_ids)
                files_with_main_flow.add(file_id)
                main_idx += 1
                flows.append(
                    {
                        "id": f"flow_main_{main_idx}",
                        "kind": "main",
                        "label": f"Hilo Principal · {_short_flow_node_name(fid)}",
                        "root_id": fid,
                        "trigger": "entry_module",
                        "registered_by": None,
                        "node_ids": n_ids,
                        "edge_ids": e_ids,
                        "steps": steps,
                    }
                )

    # 2. Hilos por Feature / Evento / Ruta (`feature`).
    feature_roots_sorted = sorted(
        entry_meta["explicit_feature_roots"],
        key=lambda fid: (
            fid.split("::", 1)[0],
            index.functions_by_file.get(index.path_by_file_id.get(fid.split("::", 1)[0], ""), {})
            .get(fid.split("::", 1)[1], FunctionInfo("", "", None, None, 0, "", "", 0))
            .line,
            fid,
        ),
    )

    feature_idx = 0
    for root_id in feature_roots_sorted:
        if root_id not in visible_ids:
            continue
        n_ids, e_ids, steps = _trace_flow_tree(
            root_id,
            out_edges,
            feature_edge_types,
            blocked_pairs=reactive_subscriber_pairs,
        )
        trigger = entry_meta["feature_triggers"].get(root_id, "event")
        reg_by = entry_meta["registered_by"].get(root_id)
        short_name = _short_flow_node_name(root_id)
        if trigger.startswith("route:"):
            label = f"Ruta {trigger[6:]} · {short_name}"
        elif trigger == "route":
            label = f"Ruta · {short_name}"
        elif trigger.startswith("event:"):
            label = f"Evento {trigger[6:]} · {short_name}"
        else:
            label = f"Feature · {short_name}"
        feature_idx += 1
        flows.append(
            {
                "id": f"flow_feature_{feature_idx}",
                "kind": "feature",
                "label": label,
                "root_id": root_id,
                "trigger": trigger,
                "registered_by": reg_by,
                "node_ids": n_ids,
                "edge_ids": e_ids,
                "steps": steps,
            }
        )

    return flows
