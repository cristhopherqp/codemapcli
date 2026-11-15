"""Helpers compartidos por los parsers de Python y JS/TS.

Convenciones:
- Un nodo se identifica por `NodeKey = (start_byte, end_byte)`; así podemos
  usar diccionarios de "nodos que son funciones" sin depender de identidad
  de objetos Python (tree-sitter crea un objeto Node nuevo en cada acceso).
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass, field

from tree_sitter import Node, QueryCursor

from codemap.languages import compile_query

NodeKey = tuple[int, int]

LABEL_MAX_CHARS = 48
DOCSTRING_MAX_CHARS = 400
CALLEE_MAX_CHARS = 80


# --------------------------------------------------------------------------
# Texto y posiciones
# --------------------------------------------------------------------------

def node_key(node: Node) -> NodeKey:
    return (node.start_byte, node.end_byte)


def node_text(node: Node | None, source: bytes) -> str:
    if node is None:
        return ""
    return source[node.start_byte:node.end_byte].decode("utf-8", errors="replace")


def line_of(node: Node) -> int:
    """Línea 1-based (tree-sitter usa filas 0-based)."""
    return node.start_point[0] + 1


def collapse_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def one_line(text: str, max_chars: int = LABEL_MAX_CHARS) -> str:
    """Primera línea, espacios colapsados y truncada con '…'."""
    first = collapse_whitespace(text.strip().splitlines()[0]) if text.strip() else ""
    if len(first) > max_chars:
        return first[: max_chars - 1] + "…"
    return first


def text_between(source: bytes, start_node: Node, end_node: Node) -> str:
    """Texto desde el inicio de `start_node` hasta el inicio de `end_node`."""
    return source[start_node.start_byte:end_node.start_byte].decode("utf-8", errors="replace")


def signature_text(source: bytes, start_node: Node, body: Node | None) -> str:
    """Firma = todo lo que precede al cuerpo (sin '{' ni ':' finales)."""
    if body is None:
        return collapse_whitespace(node_text(start_node, source))
    raw = collapse_whitespace(text_between(source, start_node, body))
    return raw.rstrip(" {:")


def normalize_callee(text: str) -> str:
    """'obj?.method' -> 'obj.method'; quita espacios y '!' de TypeScript."""
    cleaned = re.sub(r"\s+", "", text).replace("?.", ".").replace("!", "")
    return cleaned[:CALLEE_MAX_CHARS]


def parameter_names(params: Node | None, source: bytes) -> list[str]:
    """Nombres de parámetros: 'x: int = 1' -> 'x'. Omite separadores '/' y '*'."""
    if params is None:
        return []
    if params.type == "identifier":  # arrow function sin paréntesis: x => ...
        return [node_text(params, source)]
    names: list[str] = []
    for child in params.named_children:
        if child.type == "comment":
            continue
        name = re.split(r"[:=]", node_text(child, source))[0].strip()
        if name and name not in ("/", "*"):
            names.append(name)
    return names


def unique_qualname(qualname: str, line: int, used: set[str]) -> str:
    """Evita IDs duplicados (p.ej. @property + @x.setter con el mismo nombre)."""
    if qualname not in used:
        used.add(qualname)
        return qualname
    candidate = f"{qualname}@L{line}"
    used.add(candidate)
    return candidate


# --------------------------------------------------------------------------
# Consultas tree-sitter
# --------------------------------------------------------------------------

def run_matches(language_name: str, query_source: str, node: Node) -> list[dict[str, list[Node]]]:
    """Ejecuta una consulta y devuelve, por cada coincidencia, {captura: [nodos]}.

    Cada patrón de la consulta que encaja produce un "match" independiente;
    los nombres de captura (@name, @function...) sirven para leer sus partes.
    """
    query = compile_query(language_name, query_source)
    cursor = QueryCursor(query)
    return [captures for _pattern_index, captures in cursor.matches(node)]


def first_capture(captures: dict[str, list[Node]], name: str) -> Node | None:
    nodes = captures.get(name)
    return nodes[0] if nodes else None


# --------------------------------------------------------------------------
# Recorrido de árboles
# --------------------------------------------------------------------------

def find_enclosing_key(node: Node, keys: dict[NodeKey, object]) -> NodeKey | None:
    """Sube por los ancestros hasta encontrar uno registrado en `keys`."""
    parent = node.parent
    while parent is not None:
        key = node_key(parent)
        if key in keys:
            return key
        parent = parent.parent
    return None


def iter_body_nodes(body: Node | None, function_keys: dict[NodeKey, object]) -> Iterator[Node]:
    """Pre-orden de nodos con nombre del cuerpo, SIN entrar en funciones anidadas
    (esas se analizan como funciones independientes)."""
    if body is None:
        return
    stack = [body]
    while stack:
        current = stack.pop()
        yield current
        children = [
            child for child in current.named_children
            if node_key(child) not in function_keys
        ]
        stack.extend(reversed(children))


def contains_type(node: Node, types: frozenset[str], function_keys: dict[NodeKey, object]) -> bool:
    return any(item.type in types for item in iter_body_nodes(node, function_keys))


@dataclass
class BodyMetrics:
    """Métricas de un cuerpo de función usadas para roles y huella."""

    node_types: list[str] = field(default_factory=list)
    branch_count: int = 0
    return_count: int = 0
    has_await: bool = False
    mutates_global: bool = False


def collect_metrics(
    body: Node | None,
    function_keys: dict[NodeKey, object],
    branch_types: frozenset[str],
    return_types: frozenset[str],
    await_types: frozenset[str],
    global_types: frozenset[str],
) -> BodyMetrics:
    metrics = BodyMetrics()
    for item in iter_body_nodes(body, function_keys):
        metrics.node_types.append(item.type)
        if item.type in branch_types:
            metrics.branch_count += 1
        elif item.type in return_types:
            metrics.return_count += 1
        elif item.type in await_types:
            metrics.has_await = True
        elif item.type in global_types:
            metrics.mutates_global = True
    return metrics
