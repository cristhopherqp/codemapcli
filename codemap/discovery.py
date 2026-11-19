"""Descubrimiento de archivos fuente (solo lectura).

- Ignora directorios de ruido fijos.
- Respeta `.gitignore` de la raíz y de cada subdirectorio anidado mediante `pathspec`.
- Solo devuelve extensiones soportadas por los parsers (incluye `.html`/`.htm`).
"""

from __future__ import annotations

import os
from pathlib import Path

import pathspec

IGNORED_DIRS: frozenset[str] = frozenset(
    {".git", "node_modules", "__pycache__", ".venv", "dist", "build"}
)

SUPPORTED_EXTENSIONS: frozenset[str] = frozenset(
    {".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".htm"}
)

# Archivos mayores suelen ser bundles minificados o código generado.
MAX_FILE_BYTES = 1_000_000


def is_supported_file(path: Path) -> bool:
    """True si la extensión está soportada (excluye declaraciones TypeScript .d.ts)."""
    if path.name.endswith(".d.ts"):
        return False
    return path.suffix.lower() in SUPPORTED_EXTENSIONS


def load_gitignore(directory: Path) -> pathspec.GitIgnoreSpec | None:
    """Carga las reglas del .gitignore dentro de `directory`, si existe."""
    gitignore = directory / ".gitignore"
    if not gitignore.is_file():
        return None
    try:
        lines = gitignore.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    return pathspec.GitIgnoreSpec.from_lines(lines)


def is_ignored(relative_posix: str, spec: pathspec.PathSpec | None) -> bool:
    """Evalúa una ruta relativa POSIX contra un único spec .gitignore (dirs terminan en '/')."""
    if spec is None:
        return False
    return spec.match_file(relative_posix)


class GitIgnoreMatcher:
    """Evalúa reglas `.gitignore` jerárquicas desde `root` hasta cada subdirectorio.

    Cada `.gitignore` en un subdirectorio aplica únicamente a las rutas bajo ese
    subdirectorio con patrones relativos a él, respetando negaciones (`!`) en
    niveles más profundos y el bloqueo de directorios ancestros ignorados.
    """

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self._specs: dict[Path, pathspec.GitIgnoreSpec | None] = {}
        self.load_dir(self.root)

    def load_dir(self, directory: Path) -> pathspec.GitIgnoreSpec | None:
        resolved = directory.resolve()
        if resolved not in self._specs:
            self._specs[resolved] = load_gitignore(resolved)
        return self._specs[resolved]

    def reload_dir(self, directory: Path) -> None:
        resolved = directory.resolve()
        self._specs[resolved] = load_gitignore(resolved)

    def _ancestor_dirs(self, scope_dir: Path) -> list[Path]:
        """Devuelve [root, ..., scope_dir] de fuera hacia dentro."""
        resolved = scope_dir.resolve()
        try:
            rel_parts = resolved.relative_to(self.root).parts
        except ValueError:
            return []
        chain = [self.root]
        cursor = self.root
        for part in rel_parts:
            cursor = cursor / part
            chain.append(cursor)
        return chain

    def is_entry_ignored(self, entry: Path, parent_dir: Path, *, is_dir: bool = False) -> bool:
        """Evalúa una entrada directa de `parent_dir` contra todos los `.gitignore` ancestros."""
        resolved_entry = entry.resolve()
        chain = self._ancestor_dirs(parent_dir)
        if not chain:
            return False

        ignored = False
        for scope in chain:
            spec = self.load_dir(scope)
            if spec is None:
                continue
            try:
                rel = resolved_entry.relative_to(scope).as_posix()
            except ValueError:
                continue
            if is_dir:
                rel += "/"
            result = spec.check_file(rel)
            if result.include is not None:
                ignored = result.include
        return ignored

    def is_path_ignored(self, path: Path, *, is_dir: bool = False) -> bool:
        """Evalúa una ruta arbitraria bajo `root`, incluyendo si algún directorio padre está ignorado."""
        resolved = path.resolve()
        try:
            rel_parts = resolved.relative_to(self.root).parts
        except ValueError:
            return False
        if not rel_parts:
            return False

        # En Git, si un directorio ancestro está ignorado, nada en su interior se inspecciona.
        cursor = self.root
        for part in rel_parts[:-1]:
            next_dir = cursor / part
            if self.is_entry_ignored(next_dir, cursor, is_dir=True):
                return True
            cursor = next_dir

        return self.is_entry_ignored(resolved, resolved.parent, is_dir=is_dir)


def discover_files(root: Path) -> list[Path]:
    """Lista ordenada de archivos fuente analizables bajo `root`."""
    resolved_root = root.resolve()
    matcher = GitIgnoreMatcher(resolved_root)
    found: list[Path] = []

    for current_dir, dir_names, file_names in os.walk(resolved_root):
        current = Path(current_dir)
        matcher.load_dir(current)

        # Poda in-place: os.walk no descenderá a los directorios eliminados.
        kept_dirs = []
        for name in dir_names:
            if name in IGNORED_DIRS or matcher.is_entry_ignored(current / name, current, is_dir=True):
                continue
            kept_dirs.append(name)
        dir_names[:] = sorted(kept_dirs)

        for name in sorted(file_names):
            path = current / name
            if not is_supported_file(path) or matcher.is_entry_ignored(path, current, is_dir=False):
                continue
            try:
                if path.stat().st_size > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            found.append(path)

    return found
