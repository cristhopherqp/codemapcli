"""Persistencia global del inventario de APIs conocidas (~/.codemap/known_apis.json).

Este almacenamiento es compartido entre todos los proyectos analizados por CodeMap
y nunca modifica los repositorios objetivo.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from codemap import paths as _paths
from codemap.paths import atomic_write_text

KNOWN_APIS_FILE_NAME = "known_apis.json"
KNOWN_APIS_SCHEMA_VERSION = 1
_KNOWN_APIS_LOCK = threading.RLock()


def known_apis_path() -> Path:
    """Ruta a ~/.codemap/known_apis.json."""
    return _paths.storage_root() / KNOWN_APIS_FILE_NAME


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _default_state() -> dict:
    return {"version": KNOWN_APIS_SCHEMA_VERSION, "known": {}}


def _derive_symbol(api_id: str) -> str:
    return api_id.split(":", 1)[1] if ":" in api_id else api_id


def sanitize_docs_url(raw: object) -> str:
    """Permite únicamente URLs http:// o https:// con host válido."""
    url = str(raw or "").strip()
    if not url:
        return ""
    try:
        parsed = urlsplit(url)
    except ValueError:
        return ""
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        return ""
    return url


def normalize_api_entry(api_id: str, raw: dict | None) -> dict | None:
    """Normaliza una entrada del inventario global de APIs conocidas."""
    clean_id = str(api_id or "").strip()
    if not clean_id or not isinstance(raw, dict):
        return None
    symbol = str(raw.get("symbol") or _derive_symbol(clean_id)).strip()
    module = str(raw.get("module") or "").strip()
    kind = str(raw.get("kind") or "external").strip()
    docs_url = sanitize_docs_url(raw.get("docs_url"))
    marked_at = str(raw.get("marked_at") or _utc_now_iso()).strip()
    return {
        "api_id": clean_id,
        "symbol": symbol,
        "module": module,
        "kind": kind,
        "docs_url": docs_url,
        "marked_at": marked_at,
    }


def load_known_apis() -> dict:
    """Carga ~/.codemap/known_apis.json o devuelve el esquema vacío."""
    path = known_apis_path()
    if not path.is_file():
        return _default_state()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _default_state()

    if not isinstance(raw, dict):
        return _default_state()

    raw_known = raw.get("known")
    known: dict[str, dict] = {}
    if isinstance(raw_known, dict):
        for api_id, entry in raw_known.items():
            normalized = normalize_api_entry(api_id, entry)
            if normalized is not None:
                known[normalized["api_id"]] = normalized
    return {"version": KNOWN_APIS_SCHEMA_VERSION, "known": known}


def save_known_apis(data: dict) -> Path:
    """Escribe ~/.codemap/known_apis.json de forma atómica garantizando el directorio raíz."""
    with _KNOWN_APIS_LOCK:
        path = known_apis_path()
        raw_known = data.get("known") if isinstance(data, dict) else {}
        known: dict[str, dict] = {}
        if isinstance(raw_known, dict):
            for api_id in sorted(raw_known):
                normalized = normalize_api_entry(api_id, raw_known[api_id])
                if normalized is not None:
                    known[normalized["api_id"]] = normalized
        payload = {"version": KNOWN_APIS_SCHEMA_VERSION, "known": known}
        atomic_write_text(path, json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        return path


def _mark_item(known: dict[str, dict], item: object) -> None:
    if not isinstance(item, dict):
        return
    api_id = str(item.get("api_id") or "").strip()
    if not api_id and item.get("symbol"):
        api_id = str(item["symbol"]).strip()
    normalized = normalize_api_entry(api_id, item)
    if normalized is not None:
        known[normalized["api_id"]] = normalized


def update_known_apis(payload: dict) -> dict:
    """Aplica operaciones sobre ~/.codemap/known_apis.json y devuelve el estado final.

    Formatos soportados:
    - {"action": "mark", "api": {...}} o {"mark": [{...}, ...]}
    - {"action": "unmark", "api_id": "..."} o {"unmark": ["...", ...]}
    - {"known": {"<api_id>": {...} | false | null}, "replace": bool}
    """
    with _KNOWN_APIS_LOCK:
        state = load_known_apis()
        known: dict[str, dict] = state["known"]
        action = payload.get("action")

        if action == "mark":
            _mark_item(known, payload.get("api"))
            for item in payload.get("apis") or []:
                _mark_item(known, item)
        elif action == "unmark":
            single_id = payload.get("api_id")
            if isinstance(single_id, str) and single_id:
                known.pop(single_id, None)
            for api_id in payload.get("api_ids") or []:
                if isinstance(api_id, str):
                    known.pop(api_id, None)

        if isinstance(payload.get("mark"), list):
            for item in payload["mark"]:
                _mark_item(known, item)

        if isinstance(payload.get("unmark"), list):
            for api_id in payload["unmark"]:
                if isinstance(api_id, str):
                    known.pop(api_id, None)

        if isinstance(payload.get("known"), dict):
            if payload.get("replace"):
                known.clear()
            for api_id, raw_entry in payload["known"].items():
                if raw_entry in (None, False):
                    known.pop(str(api_id), None)
                else:
                    normalized = normalize_api_entry(api_id, raw_entry if isinstance(raw_entry, dict) else {})
                    if normalized is not None:
                        known[normalized["api_id"]] = normalized

        save_known_apis({"version": KNOWN_APIS_SCHEMA_VERSION, "known": known})
        return load_known_apis()
