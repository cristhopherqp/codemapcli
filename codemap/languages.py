"""Selección de gramática tree-sitter por extensión.

Las gramáticas vienen de `tree-sitter-language-pack` (la primera ejecución
puede descargarlas a su caché de usuario; nunca dentro del proyecto analizado).
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import tree_sitter_language_pack as language_pack
from tree_sitter import Language, Parser, Query

# .jsx se analiza con la gramática de JavaScript (incluye JSX).
# .tsx necesita la gramática "tsx" (TypeScript + JSX); .ts usa "typescript".
EXTENSION_TO_LANGUAGE: dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
}


def language_for_path(path: Path) -> str | None:
    return EXTENSION_TO_LANGUAGE.get(path.suffix.lower())


@lru_cache(maxsize=None)
def get_language(language_name: str) -> Language:
    return language_pack.get_language(language_name)


@lru_cache(maxsize=None)
def get_parser(language_name: str) -> Parser:
    return language_pack.get_parser(language_name)


@lru_cache(maxsize=None)
def compile_query(language_name: str, query_source: str) -> Query:
    """Compila (una sola vez) una consulta S-expression para una gramática."""
    return Query(get_language(language_name), query_source)
