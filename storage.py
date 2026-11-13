"""Escritura de graph.json e index.json en ~/.codemap/ (nunca en el proyecto)."""

from __future__ import annotations

import json
from pathlib import Path

from codemap.paths import project_hash, project_storage_dir, storage_root

GRAPH_FILE_NAME = "graph.json"
INDEX_FILE_NAME = "index.json"


def write_graph(target_path: str, graph: dict) -> Path:
    """Sobrescribe ~/.codemap/<hash>/graph.json y registra el proyecto en index.json."""
    graph_path = project_storage_dir(target_path) / GRAPH_FILE_NAME
    graph_path.write_text(json.dumps(graph, indent=2, ensure_ascii=False), encoding="utf-8")
    register_project(target_path, graph["meta"])
    return graph_path


def register_project(target_path: str, meta: dict) -> None:
    """Registro de proyectos mapeados (lo usarán `codemap list/clean` en la Etapa 4)."""
    index_path = storage_root() / INDEX_FILE_NAME
    index: dict = {"projects": {}}
    if index_path.is_file():
        index = json.loads(index_path.read_text(encoding="utf-8"))
    index.setdefault("projects", {})[project_hash(target_path)] = {
        "root_path": target_path,
        "project_name": meta["project_name"],
        "last_generated": meta["generated_at"],
    }
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
