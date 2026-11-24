"""Persistencia cognitiva y migración por huella AST (~/.codemap/<hash>/notes.json).

Separa los datos humanos (notas, anclajes, roles manuales, huérfanas) del
`graph.json` efímero generado por el analizador.
"""

from __future__ import annotations

import json
import math
import threading
from datetime import datetime, timezone
from pathlib import Path

from codemap.paths import atomic_write_text, project_storage_dir

NOTES_FILE_NAME = "notes.json"
_NOTES_LOCK = threading.RLock()
ALLOWED_NODE_FIELDS = (
    "note",
    "pinned",
    "x",
    "y",
    "pinned_positions",
    "custom_role",
    "last_fingerprint",
)
VALID_LAYOUT_LEVELS = frozenset(
    {
        # Claves semánticas por escala (modo Ejecución / Carpetas y Capas)
        "modules",
        "files",
        "functions",
        "intra",
        "layers_modules",
        "layers_files",
        "layers_functions",
        "layers_intra",
        # Claves semánticas independientes para modo Orden de Creación (↑ Creación)
        "creation_modules",
        "creation_files",
        "creation_functions",
        "creation_intra",
        "creation_layers_modules",
        "creation_layers_files",
        "creation_layers_functions",
        "creation_layers_intra",
        # Retrocompatibilidad con notes.json previos
        "level_1",
        "level_2",
        "level_3",
        "level_4",
    }
)


def notes_path(target_path: str) -> Path:
    """Ruta a ~/.codemap/<hash-proyecto>/notes.json."""
    return project_storage_dir(target_path) / NOTES_FILE_NAME


def default_node_entry(fingerprint: str = "") -> dict:
    return {
        "note": "",
        "pinned": False,
        "x": None,
        "y": None,
        "pinned_positions": {},
        "custom_role": None,
        "last_fingerprint": fingerprint,
    }


def _finite_float(value: object) -> float | None:
    """Devuelve float finito o None (rechaza bool, NaN e Infinity)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    fval = float(value)
    return fval if math.isfinite(fval) else None


def _normalize_pinned_positions(raw_positions: object) -> dict[str, dict[str, float]]:
    if not isinstance(raw_positions, dict):
        return {}
    clean: dict[str, dict[str, float]] = {}
    for level_key, coords in raw_positions.items():
        if level_key not in VALID_LAYOUT_LEVELS or not isinstance(coords, dict):
            continue
        x = _finite_float(coords.get("x"))
        y = _finite_float(coords.get("y"))
        if x is not None and y is not None:
            clean[level_key] = {"x": x, "y": y}
    return clean


def normalize_node_entry(raw: dict | None, fingerprint: str = "") -> dict:
    """Normaliza una entrada de notes.json preservando retrocompatibilidad con x/y."""
    entry = default_node_entry(fingerprint)
    if not isinstance(raw, dict):
        return entry
    entry["note"] = str(raw.get("note") or "")
    entry["pinned"] = bool(raw.get("pinned", False))
    entry["x"] = _finite_float(raw.get("x"))
    entry["y"] = _finite_float(raw.get("y"))
    entry["pinned_positions"] = _normalize_pinned_positions(raw.get("pinned_positions"))
    custom_role = raw.get("custom_role")
    entry["custom_role"] = str(custom_role) if custom_role else None
    entry["last_fingerprint"] = str(raw.get("last_fingerprint") or fingerprint or "")
    return entry


def has_user_content(entry: dict) -> bool:
    """True si la entrada contiene información humana que merece persistir."""
    return (
        bool(entry.get("note", "").strip())
        or bool(entry.get("pinned"))
        or bool(entry.get("pinned_positions"))
        or bool(entry.get("custom_role"))
    )


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
    """Escribe ~/.codemap/<hash>/notes.json de forma atómica."""
    with _NOTES_LOCK:
        path = notes_path(target_path)
        clean = {
            "nodes": {
                node_id: normalize_node_entry(entry)
                for node_id, entry in notes.get("nodes", {}).items()
            },
            "orphans": list(notes.get("orphans", [])),
        }
        atomic_write_text(path, json.dumps(clean, indent=2, ensure_ascii=False), encoding="utf-8")
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


def _collect_valid_flow_steps(graph: dict) -> tuple[set[str], dict[str, set[str]]]:
    """Construye el conjunto de IDs válidos `fn_id::step_id` desde `internal_flow`."""
    valid_ids: set[str] = set()
    by_fn: dict[str, set[str]] = {}
    for node in graph.get("nodes", []):
        if node.get("type") != "function":
            continue
        fn_id = node.get("id") or ""
        if not fn_id:
            continue
        step_ids: set[str] = set()
        for step in node.get("internal_flow") or []:
            if not isinstance(step, dict):
                continue
            sid = step.get("id")
            if isinstance(sid, str) and sid:
                step_ids.add(sid)
                valid_ids.add(f"{fn_id}::{sid}")
        if step_ids:
            by_fn[fn_id] = step_ids
    return valid_ids, by_fn


def _is_layer_container_id(node_id: str) -> bool:
    return isinstance(node_id, str) and node_id.startswith("layer::")


def _split_flow_step_id(node_id: str) -> tuple[str, str] | None:
    """Separa `file::fn::step` en `(file::fn, step)` si tiene al menos 2 separadores `::`."""
    if not isinstance(node_id, str) or "::" not in node_id:
        return None
    owner_id, step_id = node_id.rsplit("::", 1)
    if "::" in owner_id and step_id:
        return owner_id, step_id
    return None


def reconcile_notes(target_path: str, graph: dict) -> dict:
    """Sincroniza notes.json tras regenerar graph.json.

    - Actualiza `last_fingerprint` de nodos vigentes.
    - Preserva pines/notas en contenedores de capa (`layer::*`) y pasos intra-función
      (`fn_id::step_id`) presentes en `internal_flow`.
    - Si una función desaparece y aparece otra en el mismo archivo con idéntico
      `fingerprint` AST, transfiere automáticamente nota, rol, coordenadas y también
      las entradas `old_fn::step` → `new_fn::step` de pasos que sigan existiendo.
    - Si un paso intra-función desaparece tras refactorizar y solo tenía posición
      fijada (sin nota ni rol manual), se descarta silenciosamente sin ensuciar `orphans`.
    - Si un nodo con contenido humano desaparece definitivamente, se mueve a `orphans`.
    """
    with _NOTES_LOCK:
        notes = load_notes(target_path)
        nodes_map: dict[str, dict] = notes["nodes"]
        graph_nodes = {node["id"]: node for node in graph.get("nodes", [])}
        valid_flow_step_ids, flow_steps_by_fn = _collect_valid_flow_steps(graph)

        for node_id, entry in nodes_map.items():
            if node_id in graph_nodes:
                fp = graph_nodes[node_id].get("fingerprint") or ""
                if fp:
                    entry["last_fingerprint"] = fp

        missing_ids = [
            node_id
            for node_id in list(nodes_map)
            if node_id not in graph_nodes
            and node_id not in valid_flow_step_ids
            and not _is_layer_container_id(node_id)
        ]
        if not missing_ids:
            return notes

        candidates = _new_functions_by_key(graph_nodes, set(nodes_map))
        now_iso = _utc_now_iso()

        # Separar nodos de nivel superior de pasos intra-función para migrar primero funciones
        # y luego trasladar sus pasos `old_fn::step` → `new_fn::step`.
        missing_regular: list[str] = []
        missing_flow_steps: list[tuple[str, str, str]] = []
        for old_id in missing_ids:
            split_step = _split_flow_step_id(old_id)
            if split_step is not None:
                missing_flow_steps.append((old_id, split_step[0], split_step[1]))
            else:
                missing_regular.append(old_id)

        migrated_fn_ids: dict[str, str] = {}

        for old_id in missing_regular:
            entry = nodes_map.pop(old_id)
            if not has_user_content(entry):
                continue

            old_file = old_id.split("::", 1)[0] if "::" in old_id else ""
            fp = entry.get("last_fingerprint") or ""
            pool = candidates.get((old_file, fp), []) if (old_file and fp) else []

            if pool:
                target_node = pool.pop(0)
                target_id = target_node["id"]
                entry["last_fingerprint"] = target_node.get("fingerprint") or fp
                nodes_map[target_id] = entry
                migrated_fn_ids[old_id] = target_id
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

        for old_id, old_fn_id, step_id in missing_flow_steps:
            entry = nodes_map.pop(old_id)
            if not has_user_content(entry):
                continue

            migrated_fn = migrated_fn_ids.get(old_fn_id)
            if migrated_fn and step_id in flow_steps_by_fn.get(migrated_fn, set()):
                new_step_id = f"{migrated_fn}::{step_id}"
                if new_step_id not in nodes_map:
                    nodes_map[new_step_id] = entry
                continue

            # Si el paso intra-función solo tenía posición fijada (sin texto ni rol), descartar sin ensuciar orphans.
            if not entry.get("note", "").strip() and not entry.get("custom_role"):
                continue

            notes["orphans"].append(
                {
                    "old_id": old_id,
                    "note": entry["note"],
                    "custom_role": entry["custom_role"],
                    "last_fingerprint": entry.get("last_fingerprint") or "",
                    "orphaned_at": now_iso,
                }
            )

        save_notes(target_path, notes)
        return notes


def update_notes(target_path: str, payload: dict, graph: dict) -> dict:
    """Aplica cambios parciales enviados desde el visor web y guarda notes.json."""
    with _NOTES_LOCK:
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
