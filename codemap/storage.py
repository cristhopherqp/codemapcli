"""Escritura de graph.json e index.json en ~/.codemap/ (nunca en el proyecto)."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from codemap import paths as _paths
from codemap.paths import atomic_write_text, project_hash, project_storage_dir

GRAPH_FILE_NAME = "graph.json"
INDEX_FILE_NAME = "index.json"
_SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")


def _index_path() -> Path:
    return _paths.storage_root() / INDEX_FILE_NAME


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
    atomic_write_text(path, json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")


def write_graph(target_path: str, graph: dict) -> Path:
    """Sobrescribe ~/.codemap/<hash>/graph.json y registra el proyecto en index.json."""
    graph_path = project_storage_dir(target_path) / GRAPH_FILE_NAME
    atomic_write_text(graph_path, json.dumps(graph, indent=2, ensure_ascii=False), encoding="utf-8")
    register_project(target_path, graph["meta"])
    return graph_path


def write_ai_export(target_path: str, content: str, ext: str) -> Path:
    """Escribe ~/.codemap/<hash>/graph.ai.<ext> sin tocar el repositorio analizado."""
    clean_ext = ext.lstrip(".").lower() or "json"
    export_path = project_storage_dir(target_path) / f"graph.ai.{clean_ext}"
    atomic_write_text(export_path, content, encoding="utf-8")
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


def _safe_cache_subdir(root: Path, key: str) -> Path | None:
    """Valida que `key` sea un hash SHA-256 puro y permanezca dentro de `root`."""
    if not isinstance(key, str) or not _SHA256_HEX_RE.match(key):
        return None
    resolved_root = root.resolve()
    candidate = (resolved_root / key).resolve()
    if candidate.parent != resolved_root:
        return None
    return candidate


def clean_orphan_projects() -> list[str]:
    """Elimina cachés de ~/.codemap/ cuya ruta origen ya no existe en disco."""
    index = _read_index()
    projects = index.get("projects", {})
    removed: list[str] = []
    kept: dict = {}
    root = _paths.storage_root()

    for key, info in projects.items():
        if not isinstance(info, dict) or not _SHA256_HEX_RE.match(str(key)):
            continue
        root_path = info.get("root_path", "")
        if root_path and Path(root_path).exists():
            kept[key] = info
            continue
        cache_dir = _safe_cache_subdir(root, key)
        if cache_dir is not None and cache_dir.is_dir():
            shutil.rmtree(cache_dir, ignore_errors=True)
        removed.append(root_path or key)

    if removed or len(kept) != len(projects):
        index["projects"] = kept
        _write_index(index)

    if root.is_dir():
        for entry in root.iterdir():
            if entry.is_dir() and _SHA256_HEX_RE.match(entry.name) and entry.name not in kept:
                safe_dir = _safe_cache_subdir(root, entry.name)
                if safe_dir is not None:
                    shutil.rmtree(safe_dir, ignore_errors=True)
                    removed.append(entry.name)

    return removed
