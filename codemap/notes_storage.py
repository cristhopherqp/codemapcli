"""Persistencia cognitiva y migración por huella AST (~/.codemap/<hash>/notes.json).

Separa los datos humanos (notas, anclajes, roles manuales, huérfanas) del
`graph.json` efímero generado por el analizador.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from codemap.paths import project_storage_dir

NOTES_FILE_NAME = "notes.json"
ALLOWED_NODE_FIELDS = ("note", "pinned", "x", "y", "custom_role", "last_fingerprint")


def notes_path(target_path: str) -> Path:
    """Ruta a ~/.codemap/<hash-proyecto>/notes.json."""
    return project_storage_dir(target_path) / NOTES_FILE_NAME


def default_node_entry(fingerprint: str = "") -> dict:
    return {
        "note": "",
        "pinned": False,
        "x": None,
        "y": None,
        "custom_role": None,
        "last_fingerprint": fingerprint,
    }


def normalize_node_entry(raw: dict | None, fingerprint: str = "") -> dict:
    """Garantiza exactamente las 6 claves del esquema de notes.json."""
    entry = default_node_entry(fingerprint)
    if not isinstance(raw, dict):
        return entry
    entry["note"] = str(raw.get("note") or "")
    entry["pinned"] = bool(raw.get("pinned", False))
    entry["x"] = raw.get("x") if isinstance(raw.get("x"), (int, float)) else None
    entry["y"] = raw.get("y") if isinstance(raw.get("y"), (int, float)) else None
    custom_role = raw.get("custom_role")
    entry["custom_role"] = str(custom_role) if custom_role else None
    entry["last_fingerprint"] = str(raw.get("last_fingerprint") or fingerprint or "")
    return entry


def has_user_content(entry: dict) -> bool:
    """True si la entrada contiene información humana que merece persistir."""
    return bool(entry.get("note", "").strip()) or bool(entry.get("pinned")) or bool(entry.get("custom_role"))


def load_notes(target_path: str) -> dict:
    """Carga notes.json o devuelve la estructura vacía si aún no existe."""
    path = notes_path(target_path)
    if not path.is_file():
        return {"nodes": {}, "orphans": []}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"nodes": {}, "orphans": []}

    raw_nodes = raw.get("nodes") if isinstance(raw, dict) else {}
    raw_orphans = raw.get("orphans") if isinstance(raw, dict) else []
    nodes = {
        node_id: normalize_node_entry(entry)
        for node_id, entry in (raw_nodes or {}).items()
    }
    orphans = list(raw_orphans) if isinstance(raw_orphans, list) else []
    return {"nodes": nodes, "orphans": orphans}


def save_notes(target_path: str, notes: dict) -> Path:
    """Escribe ~/.codemap/<hash>/notes.json."""
    path = notes_path(target_path)
    clean = {
        "nodes": {
            node_id: normalize_node_entry(entry)
            for node_id, entry in notes.get("nodes", {}).items()
        },
        "orphans": list(notes.get("orphans", [])),
    }
    path.write_text(json.dumps(clean, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_functions_by_key(graph_nodes: dict[str, dict], known_ids: set[str]) -> dict[tuple[str, str], list[dict]]:
    """Agrupa funciones recién aparecidas por (archivo, fingerprint)."""
    buckets: dict[tuple[str, str], list[dict]] = {}
    for node_id, node in graph_nodes.items():
        if node.get("type") != "function" or node_id in known_ids:
            continue
        fp = node.get("fingerprint") or ""
        file_id = node.get("parent") or ""
        if fp and file_id:
            buckets.setdefault((file_id, fp), []).append(node)
    return buckets


def reconcile_notes(target_path: str, graph: dict) -> dict:
    """Sincroniza notes.json tras regenerar graph.json.

    - Actualiza `last_fingerprint` de nodos vigentes.
    - Si una función desaparece y aparece otra en el mismo archivo con idéntico
      `fingerprint` AST, transfiere automáticamente nota, rol y coordenadas.
    - Si desaparece definitivamente y tenía contenido humano, la mueve a `orphans`.
    """
    notes = load_notes(target_path)
    nodes_map: dict[str, dict] = notes["nodes"]
    graph_nodes = {node["id"]: node for node in graph.get("nodes", [])}

    for node_id, entry in nodes_map.items():
        if node_id in graph_nodes:
            fp = graph_nodes[node_id].get("fingerprint") or ""
            if fp:
                entry["last_fingerprint"] = fp

    missing_ids = [node_id for node_id in list(nodes_map) if node_id not in graph_nodes]
    if not missing_ids:
        return notes

    candidates = _new_functions_by_key(graph_nodes, set(nodes_map))
    now_iso = _utc_now_iso()

    for old_id in missing_ids:
        entry = nodes_map.pop(old_id)
        if not has_user_content(entry):
            continue

        old_file = old_id.split("::", 1)[0] if "::" in old_id else ""
        fp = entry.get("last_fingerprint") or ""
        pool = candidates.get((old_file, fp), []) if (old_file and fp) else []

        if pool:
            target_node = pool.pop(0)
            entry["last_fingerprint"] = target_node.get("fingerprint") or fp
            nodes_map[target_node["id"]] = entry
        else:
            notes["orphans"].append(
                {
                    "old_id": old_id,
                    "note": entry["note"],
                    "custom_role": entry["custom_role"],
                    "last_fingerprint": fp,
                    "orphaned_at": now_iso,
                }
            )

    save_notes(target_path, notes)
    return notes


def update_notes(target_path: str, payload: dict, graph: dict) -> dict:
    """Aplica cambios parciales enviados desde el visor web y guarda notes.json."""
    notes = load_notes(target_path)
    nodes_map: dict[str, dict] = notes["nodes"]
    graph_nodes = {node["id"]: node for node in graph.get("nodes", [])}

    if isinstance(payload.get("nodes"), dict):
        for node_id, patch in payload["nodes"].items():
            if not isinstance(patch, dict):
                continue
            graph_fp = graph_nodes.get(node_id, {}).get("fingerprint") or ""
            current = normalize_node_entry(nodes_map.get(node_id), graph_fp)
            for field in ALLOWED_NODE_FIELDS:
                if field in patch:
                    current[field] = patch[field]
            normalized = normalize_node_entry(current, graph_fp)
            if has_user_content(normalized):
                nodes_map[node_id] = normalized
            else:
                nodes_map.pop(node_id, None)

    if isinstance(payload.get("orphans"), list):
        notes["orphans"] = payload["orphans"]

    save_notes(target_path, notes)
    return notes
