"""Construcción de graph.json (esquema §4.A de la especificación).

Jerarquía de nodos (padres antes que hijos):
  module (carpeta)  ->  file  ->  function
Las aristas se agregan por par (origen, destino) con `call_count`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from codemap.models import FileAnalysis, FunctionInfo
from codemap.resolver import (
    CONFIRMED,
    ProjectIndex,
    ResolvedCall,
    build_index,
    function_id,
    resolve_project,
)
from codemap.roles import classify_role

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

    function_nodes = build_function_nodes(index, visible_ids, called_ids)
    file_nodes = build_file_nodes(analyses, file_ids)
    module_nodes = build_module_nodes(file_ids.values())
    edges = aggregate_edges(calls, visible_ids)

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


def build_function_nodes(index: ProjectIndex, visible_ids: set[str], called_ids: set[str]) -> list[dict]:
    nodes = []
    for path in sorted(index.files, key=lambda p: index.file_ids[p]):
        file_id = index.file_ids[path]
        for function in index.files[path].functions:
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
                    "signature": function.signature,
                    "docstring": function.docstring,
                    "line": function.line,
                    "fingerprint": function.fingerprint,
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
