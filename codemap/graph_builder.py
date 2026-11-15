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

from codemap.models import CallSite, FileAnalysis, FunctionInfo, ImportBinding
from codemap.resolver import (
    CONFIRMED,
    ProjectIndex,
    ResolvedCall,
    build_index,
    find_binding,
    function_id,
    resolve_binding,
    resolve_call,
    resolve_project,
)
from codemap.roles import classify_role

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
SELF_RECEIVER_PREFIXES = ("self.", "cls.", "this.")
PYTHON_BUILTINS = frozenset(name for name in dir(builtins) if not name.startswith("_"))

# Niveles de apertura (§3). El Nivel "3+" se codifica como 4 en meta.recommended_level.
LEVEL_ARCHITECTURE = 1
LEVEL_INTERCONNECTION = 2
LEVEL_FILE_FLOW = 3
LEVEL_INTRA_FUNCTION = 4

LARGE_PROJECT_FUNCTIONS = 25
TINY_FILE_FUNCTIONS = 2


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
    calls = resolve_project(index)

    visible_ids = visible_function_ids(index, include_private)
    called_ids = {c.target_id for c in calls if c.source_id != c.target_id}
    edges = aggregate_edges(calls, visible_ids)
    # Leaf functions in the visible project graph: called internally, 0 calls to other project functions.
    incoming_ids = {edge["target"] for edge in edges if edge["source"] != edge["target"]}
    outgoing_ids = {edge["source"] for edge in edges if edge["source"] != edge["target"]}
    terminal_ids = incoming_ids - outgoing_ids

    function_nodes = build_function_nodes(index, visible_ids, called_ids, terminal_ids)
    file_nodes = build_file_nodes(analyses, file_ids)
    module_nodes = build_module_nodes(file_ids.values())

    total_functions = len(function_nodes)
    return {
        "meta": {
            "project_name": Path(target_path).name,
            "root_path": target_path,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "total_functions": total_functions,
            "recommended_level": recommended_level(total_functions, is_single_file),
        },
        "nodes": module_nodes + file_nodes + function_nodes,
        "edges": edges,
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


def build_file_nodes(analyses: list[FileAnalysis], file_ids: dict[str, str]) -> list[dict]:
    nodes = []
    for analysis in sorted(analyses, key=lambda a: file_ids[a.path]):
        file_id = file_ids[analysis.path]
        nodes.append(
            {
                "id": file_id,
                "type": "file",
                "parent": file_id.rpartition("/")[0] or None,
                "label": file_id.rpartition("/")[2],
                "file_path": analysis.path,
            }
        )
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
    """Extract the npm package root (preserving @scope/pkg) from an import specifier."""
    parts = module_specifier.split("/")
    if module_specifier.startswith("@") and len(parts) >= 2:
        return f"{parts[0]}/{parts[1]}"
    return parts[0]


def classify_js_external(call: CallSite, analysis: FileAnalysis, index: ProjectIndex) -> dict | None:
    """Resolve an unresolved JS/TS call to native MDN globals, std methods, or npm docs."""
    binding = match_import_binding(analysis, call.callee)
    if binding is not None:
        if binding.module.startswith(("./", "../", "/")) or resolve_binding(binding, analysis, index) is not None:
            return None
        package = npm_package_name(binding.module)
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
) -> list[dict]:
    nodes = []
    for path in sorted(index.files, key=lambda p: index.file_ids[p]):
        file_id = index.file_ids[path]
        analysis = index.files[path]
        for function in analysis.functions:
            fid = function_id(file_id, function.qualname)
            if fid not in visible_ids:
                continue
            nodes.append(
                {
                    "id": fid,
                    "type": "function",
                    "parent": file_id,
                    "label": f"{function.qualname}()",
                    "role": classify_role(function, has_callers=fid in called_ids),
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
# Aristas
# ---------------------------------------------------------------------------

def aggregate_edges(calls: list[ResolvedCall], visible_ids: set[str]) -> list[dict]:
    """Una arista por par (origen, destino). Es `confirmed` si al menos una
    de sus llamadas lo es; `line` es la primera aparición."""
    grouped: dict[tuple[str, str], dict] = {}
    for call in calls:
        if call.source_id not in visible_ids or call.target_id not in visible_ids:
            continue
        key = (call.source_id, call.target_id)
        edge = grouped.get(key)
        if edge is None:
            grouped[key] = {
                "source": call.source_id,
                "target": call.target_id,
                "confidence": call.confidence,
                "call_count": 1,
                "line": call.line,
            }
            continue
        edge["call_count"] += 1
        edge["line"] = min(edge["line"], call.line)
        if call.confidence == CONFIRMED:
            edge["confidence"] = CONFIRMED

    edges = []
    for number, edge in enumerate(grouped.values(), start=1):
        edges.append({"id": f"e_{number}", **edge})
    return edges
