"""Escritura de graph.json e index.json en ~/.codemap/ (nunca en el proyecto)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from codemap.paths import project_hash, project_storage_dir, storage_root

GRAPH_FILE_NAME = "graph.json"
INDEX_FILE_NAME = "index.json"


def _index_path() -> Path:
    return storage_root() / INDEX_FILE_NAME


def _read_index() -> dict:
    path = _index_path()
    if not path.is_file():
        return {"projects": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {"projects": {}}
    except (OSError, json.JSONDecodeError):
        return {"projects": {}}


def _write_index(index: dict) -> None:
    path = _index_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")


def write_graph(target_path: str, graph: dict) -> Path:
    """Sobrescribe ~/.codemap/<hash>/graph.json y registra el proyecto en index.json."""
    graph_path = project_storage_dir(target_path) / GRAPH_FILE_NAME
    graph_path.write_text(json.dumps(graph, indent=2, ensure_ascii=False), encoding="utf-8")
    register_project(target_path, graph["meta"])
    return graph_path


def write_ai_export(target_path: str, content: str, ext: str) -> Path:
    """Escribe ~/.codemap/<hash>/graph.ai.<ext> sin tocar el repositorio analizado."""
    clean_ext = ext.lstrip(".").lower() or "json"
    export_path = project_storage_dir(target_path) / f"graph.ai.{clean_ext}"
    export_path.write_text(content, encoding="utf-8")
    return export_path


def register_project(target_path: str, meta: dict) -> None:
    """Registra o actualiza un proyecto mapeado en ~/.codemap/index.json."""
    index = _read_index()
    index.setdefault("projects", {})[project_hash(target_path)] = {
        "root_path": target_path,
        "project_name": meta["project_name"],
        "last_generated": meta["generated_at"],
    }
    _write_index(index)


def list_registered_projects() -> list[dict]:
    """Devuelve los proyectos registrados en ~/.codemap/index.json."""
    index = _read_index()
    projects: list[dict] = []
    for key, info in index.get("projects", {}).items():
        root_path = info.get("root_path", "")
        projects.append(
            {
                "hash": key,
                "project_name": info.get("project_name", ""),
                "root_path": root_path,
                "last_generated": info.get("last_generated", ""),
                "exists": bool(root_path) and Path(root_path).exists(),
            }
        )
    return projects


def clean_orphan_projects() -> list[str]:
    """Elimina cachés de ~/.codemap/ cuya ruta origen ya no existe en disco."""
    index = _read_index()
    projects = index.get("projects", {})
    removed: list[str] = []
    kept: dict = {}

    for key, info in projects.items():
        root_path = info.get("root_path", "")
        if root_path and Path(root_path).exists():
            kept[key] = info
            continue
        cache_dir = storage_root() / key
        if cache_dir.is_dir():
            shutil.rmtree(cache_dir, ignore_errors=True)
        removed.append(root_path or key)

    if removed:
        index["projects"] = kept
        _write_index(index)

    root = storage_root()
    if root.is_dir():
        for entry in root.iterdir():
            if entry.is_dir() and entry.name not in kept:
                shutil.rmtree(entry, ignore_errors=True)
                removed.append(entry.name)

    return removed
