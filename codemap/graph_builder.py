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

JS_NATIVE_GLOBALS = frozenset(
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
    }
)
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
    parts = callee.split(".")
    for end in range(len(parts), 0, -1):
        binding = find_binding(analysis, ".".join(parts[:end]))
        if binding is not None:
            return binding
    return None


def classify_python_external(call: CallSite, analysis: FileAnalysis, index: ProjectIndex) -> dict | None:
    """Resolve an unresolved Python call to stdlib, PyPI, or builtins docs."""
    binding = match_import_binding(analysis, call.callee)
    if binding is not None:
        if binding.module.startswith(".") or resolve_binding(binding, analysis, index) is not None:
            return None
        module = binding.module.split(".")[0]
        if module in sys.stdlib_module_names:
            return {
                "symbol": call.callee,
                "module": module,
                "kind": "stdlib",
                "docs_url": f"https://docs.python.org/3/library/{module}.html",
                "line": call.line,
            }
        return {
            "symbol": call.callee,
            "module": module,
            "kind": "package",
            "docs_url": f"https://pypi.org/project/{module}/",
            "line": call.line,
        }

    if "." not in call.callee and call.callee not in analysis.class_names and call.callee in PYTHON_BUILTINS:
        return {
            "symbol": call.callee,
            "module": "builtins",
            "kind": "stdlib",
            "docs_url": "https://docs.python.org/3/library/builtins.html",
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
    """Resolve an unresolved JS/TS call to native MDN globals or npm package docs."""
    binding = match_import_binding(analysis, call.callee)
    if binding is not None:
        if binding.module.startswith(("./", "../", "/")) or resolve_binding(binding, analysis, index) is not None:
            return None
        package = npm_package_name(binding.module)
        return {
            "symbol": call.callee,
            "module": package,
            "kind": "package",
            "docs_url": f"https://www.npmjs.com/package/{quote(package, safe='@/')}",
            "line": call.line,
        }

    root = call.callee.split(".")[0]
    if root in JS_NATIVE_GLOBALS:
        return {
            "symbol": call.callee,
            "module": root,
            "kind": "native",
            "docs_url": f"https://developer.mozilla.org/en-US/search?q={quote(call.callee)}",
            "line": call.line,
        }
    return None


def collect_external_calls(function: FunctionInfo, analysis: FileAnalysis, index: ProjectIndex) -> list[dict]:
    """Collect deduplicated external library and native runtime calls for a function."""
    results: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
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
        key = (entry["symbol"], entry["module"], entry["docs_url"])
        if key in seen:
            continue
        seen.add(key)
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
                        {"id": step.id, "role": step.role, "label": step.label}
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
