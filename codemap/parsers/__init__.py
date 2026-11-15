"""Despacho por extensión hacia el parser de cada lenguaje."""

from __future__ import annotations

from pathlib import Path

from codemap.languages import language_for_path
from codemap.models import FileAnalysis
from codemap.parsers.js_parser import parse_js_file
from codemap.parsers.python_parser import parse_python_file
from codemap.paths import normalize_path


def parse_file(path: Path) -> FileAnalysis | None:
    """Analiza un archivo en solo lectura. None si la extensión no está soportada."""
    language = language_for_path(path)
    if language is None:
        return None
    source = path.read_bytes()
    posix_path = normalize_path(path)
    if language == "python":
        return parse_python_file(posix_path, source)
    return parse_js_file(posix_path, source, language)
