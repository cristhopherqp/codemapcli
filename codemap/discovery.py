"""Descubrimiento de archivos fuente (solo lectura).

- Ignora directorios de ruido fijos.
- Respeta el `.gitignore` de la raíz del proyecto mediante `pathspec`.
- Solo devuelve extensiones soportadas por los parsers.
"""

from __future__ import annotations

import os
from pathlib import Path

import pathspec

IGNORED_DIRS: frozenset[str] = frozenset(
    {".git", "node_modules", "__pycache__", ".venv", "dist", "build"}
)

SUPPORTED_EXTENSIONS: frozenset[str] = frozenset({".py", ".js", ".jsx", ".ts", ".tsx"})

# Archivos mayores suelen ser bundles minificados o código generado.
MAX_FILE_BYTES = 1_000_000


def is_supported_file(path: Path) -> bool:
    """True si la extensión está soportada (excluye declaraciones TypeScript .d.ts)."""
    if path.name.endswith(".d.ts"):
        return False
    return path.suffix.lower() in SUPPORTED_EXTENSIONS


def load_gitignore(root: Path) -> pathspec.PathSpec | None:
    """Carga las reglas del .gitignore de la raíz, si existe."""
    gitignore = root / ".gitignore"
    if not gitignore.is_file():
        return None
    lines = gitignore.read_text(encoding="utf-8", errors="replace").splitlines()
    return pathspec.GitIgnoreSpec.from_lines(lines)


def is_ignored(relative_posix: str, spec: pathspec.PathSpec | None) -> bool:
    """Evalúa una ruta relativa POSIX contra el .gitignore (dirs terminan en '/')."""
    if spec is None:
        return False
    return spec.match_file(relative_posix)


def discover_files(root: Path) -> list[Path]:
    """Lista ordenada de archivos fuente analizables bajo `root`."""
    spec = load_gitignore(root)
    found: list[Path] = []

    for current_dir, dir_names, file_names in os.walk(root):
        current = Path(current_dir)

        # Poda in-place: os.walk no descenderá a los directorios eliminados.
        kept_dirs = []
        for name in dir_names:
            rel_dir = (current / name).relative_to(root).as_posix() + "/"
            if name in IGNORED_DIRS or is_ignored(rel_dir, spec):
                continue
            kept_dirs.append(name)
        dir_names[:] = sorted(kept_dirs)

        for name in sorted(file_names):
            path = current / name
            rel_file = path.relative_to(root).as_posix()
            if not is_supported_file(path) or is_ignored(rel_file, spec):
                continue
            if path.stat().st_size > MAX_FILE_BYTES:
                continue
            found.append(path)

    return found
