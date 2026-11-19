"""Extractor ligero de puntos de entrada HTML (.html, .htm).

Usa `html.parser.HTMLParser` de la biblioteca estándar (sin dependencias
adicionales) para detectar etiquetas `<script src="...">` locales y enlazar
el archivo HTML con los scripts de entrada del proyecto.
"""

from __future__ import annotations

from html.parser import HTMLParser
from urllib.parse import urlparse

from codemap.models import FileAnalysis, ScriptRef

EXTERNAL_SCHEMES = ("http://", "https://", "//", "data:", "javascript:", "blob:")


def _is_local_script_src(src: str) -> bool:
    cleaned = src.strip()
    if not cleaned:
        return False
    lower = cleaned.lower()
    if lower.startswith(EXTERNAL_SCHEMES):
        return False
    parsed = urlparse(cleaned)
    if parsed.scheme or parsed.netloc:
        return False
    return bool(parsed.path.strip())


def _clean_script_src(src: str) -> str:
    """Elimina query strings o fragmentos (?v=123, #hash) de un atributo src."""
    parsed = urlparse(src.strip())
    return parsed.path.strip()


class _ScriptRefHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.refs: list[ScriptRef] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        attr_map = {k.lower(): (v or "") for k, v in attrs if k}
        raw_src = attr_map.get("src", "").strip()
        if not raw_src or not _is_local_script_src(raw_src):
            return
        cleaned = _clean_script_src(raw_src)
        if not cleaned:
            return
        script_type = attr_map.get("type", "").strip().lower()
        line = self.getpos()[0] or 1
        self.refs.append(ScriptRef(src=cleaned, line=line, is_module=(script_type == "module")))


def parse_html_file(path: str, source: bytes) -> FileAnalysis:
    """Extrae etiquetas `<script src="...">` locales de un documento HTML."""
    analysis = FileAnalysis(path=path, language="html")
    parser = _ScriptRefHTMLParser()
    text = source.decode("utf-8", errors="replace")
    parser.feed(text)
    parser.close()
    analysis.script_refs = parser.refs
    return analysis
