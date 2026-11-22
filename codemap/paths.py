"""Normalización de rutas y ubicación del almacenamiento central (~/.codemap/).

Regla de la especificación: toda ruta interna pasa por
`Path(ruta).resolve().as_posix()` antes de calcular hashes o construir IDs.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

STORAGE_DIR_NAME = ".codemap"


def atomic_write_text(path: Path, content: str, encoding: str = "utf-8") -> None:
    """Escribe `content` en `path` de forma atómica (archivo temporal + os.replace)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding=encoding) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def normalize_path(path: str | Path) -> str:
    """Ruta absoluta en formato POSIX (C:/dev/proyecto/archivo.py)."""
    return Path(path).resolve().as_posix()


def project_hash(root_path: str) -> str:
    """SHA-256 de la ruta absoluta normalizada del proyecto."""
    return hashlib.sha256(root_path.encode("utf-8")).hexdigest()


def storage_root() -> Path:
    """Directorio central fuera de cualquier proyecto analizado: ~/.codemap/"""
    return Path.home() / STORAGE_DIR_NAME


def project_storage_dir(root_path: str) -> Path:
    """Directorio ~/.codemap/<hash-proyecto>/ (se crea si no existe)."""
    directory = storage_root() / project_hash(root_path)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def relative_id(file_path: str, root_path: str) -> str:
    """ID de archivo relativo a la raíz del proyecto, en POSIX: 'src/engine.py'."""
    return Path(file_path).relative_to(Path(root_path)).as_posix()
