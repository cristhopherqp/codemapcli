"""Helpers compartidos por los parsers de Python y JS/TS.

Convenciones:
- Un nodo se identifica por `NodeKey = (start_byte, end_byte)`; así podemos
  usar diccionarios de "nodos que son funciones" sin depender de identidad
  de objetos Python (tree-sitter crea un objeto Node nuevo en cada acceso).
"""

from __future__ import annotations

import re
import textwrap
from collections.abc import Iterator
from dataclasses import dataclass, field

from tree_sitter import Node, QueryCursor

from codemap.languages import compile_query
from codemap.models import ROLE_TRANSFORM, FlowEdge, FlowStep

NodeKey = tuple[int, int]

LABEL_MAX_CHARS = 48
FLOW_LABEL_MAX_CHARS = 120
DOCSTRING_MAX_CHARS = 400
CALLEE_MAX_CHARS = 80
FLOW_MAX_STEPS = 96
FLOW_COMPACT_MIN_RUN = 3

_HTML_FILE_PATTERN = re.compile(r"^[./\\\w\-@]+\.(?:html?|HTM|HTML)$")


def extract_html_path_from_string(raw: str) -> str | None:
    """Devuelve una ruta relativa limpia a un archivo .html/.htm si el literal la representa."""
    cleaned = raw.strip().strip("'\"`").strip()
    if not cleaned or "<" in cleaned or ">" in cleaned or " " in cleaned:
        return None
    lower = cleaned.lower()
    if lower.startswith(("http://", "https://", "//", "data:")):
        return None
    cleaned = cleaned.split("?", 1)[0].split("#", 1)[0]
    if not _HTML_FILE_PATTERN.match(cleaned):
        return None
    return cleaned.replace("\\", "/")


def format_compacted_step_label(category: str, names: list[str], count: int) -> str:
    """Etiqueta resumida para un grupo de sentencias simples contiguas (Nivel 3+)."""
    unique_names: list[str] = []
    for name in names:
        clean = name.strip()
        if clean and clean not in unique_names:
            unique_names.append(clean)
    if not unique_names:
        return f"{count} {category}"
    preview = ", ".join(unique_names[:3])
    if len(unique_names) > 3:
        preview += ", …"
    return f"{count} {category} ({preview})"


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


def flow_label(text: str, max_chars: int = FLOW_LABEL_MAX_CHARS) -> str:
    """Etiqueta en una línea para pasos de flujo, truncada con '…' si excede `max_chars`."""
    cleaned = collapse_whitespace(text)
    if max_chars > 0 and len(cleaned) > max_chars:
        return cleaned[: max_chars - 1].rstrip() + "…"
    return cleaned


def dedent_code(text: str) -> str:
    """Normaliza la indentación de un fragmento de código preservando saltos de línea."""
    normalized = text.replace("\r\n", "\n").strip()
    if "\n" not in normalized:
        return normalized
    dedented = textwrap.dedent(normalized)
    lines = dedented.splitlines()
    if len(lines) > 1 and not lines[0].startswith((" ", "\t")):
        indents = [len(line) - len(line.lstrip(" ")) for line in lines[1:] if line.strip()]
        base = min(indents) if indents else 0
        if base > 0:
            lines = [lines[0]] + [line[base:] if len(line) >= base else line for line in lines[1:]]
    return "\n".join(lines)


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


# --------------------------------------------------------------------------
# Constructor compartido de grafo de flujo intra-función (Nivel 3+)
# --------------------------------------------------------------------------

PendingExit = tuple[str, str, str]


class FlowGraphBuilder:
    """Construye pasos jerárquicos y aristas dirigidas para Nivel 3+."""

    def __init__(self, max_steps: int = FLOW_MAX_STEPS) -> None:
        self.max_steps = max_steps
        self.steps: list[FlowStep] = []
        self._by_id: dict[str, FlowStep] = {}

    def add_step(
        self,
        role: str,
        label: str,
        code: str = "",
        parent_id: str | None = None,
        is_container: bool = False,
        kind: str = "step",
    ) -> FlowStep | None:
        if len(self.steps) > self.max_steps:
            return None
        if len(self.steps) == self.max_steps:
            role = ROLE_TRANSFORM
            label = "… (límite de pasos alcanzado)"
            code = ""
            is_container = False
            kind = "step"
        step = FlowStep(
            id=f"n{len(self.steps) + 1}",
            role=role,
            label=label,
            code=code or label,
            parent_id=parent_id,
            is_container=is_container,
            kind=kind,
        )
        self.steps.append(step)
        self._by_id[step.id] = step
        return step

    def connect(
        self,
        source_id: str,
        target_id: str,
        label: str = "",
        kind: str = "flow",
    ) -> None:
        if source_id == target_id:
            return
        source = self._by_id.get(source_id)
        if source is None or target_id not in self._by_id:
            return
        if any(edge.target == target_id and edge.label == label for edge in source.edges):
            return
        source.edges.append(FlowEdge(target=target_id, label=label, kind=kind))

    def connect_pending(self, pending: list[PendingExit], target_id: str) -> None:
        for src_id, edge_label, edge_kind in pending:
            self.connect(src_id, target_id, label=edge_label, kind=edge_kind)

    def emit_sequential(
        self,
        pending: list[PendingExit],
        role: str,
        label: str,
        code: str = "",
        parent_id: str | None = None,
        is_container: bool = False,
        kind: str = "step",
    ) -> tuple[FlowStep | None, list[PendingExit]]:
        step = self.add_step(
            role,
            label,
            code=code,
            parent_id=parent_id,
            is_container=is_container,
            kind=kind,
        )
        if step is None:
            return None, pending
        self.connect_pending(pending, step.id)
        return step, [(step.id, "", "flow")]

    def close_dangling_branches(
        self,
        pending: list[PendingExit],
        parent_id: str | None,
    ) -> list[PendingExit]:
        has_branch_or_multi = len(pending) > 1 or any(
            lbl in ("Sí", "No") or knd in ("branch_yes", "branch_no", "exception")
            for _, lbl, knd in pending
        )
        if not has_branch_or_multi:
            return pending
        merge_step = self.add_step(
            ROLE_TRANSFORM,
            "fin",
            code="fin",
            parent_id=parent_id,
            is_container=False,
            kind="merge",
        )
        if merge_step is None:
            return pending
        self.connect_pending(pending, merge_step.id)
        return [(merge_step.id, "", "flow")]

    def finalize_container(self, container_step: FlowStep | None) -> None:
        if container_step is None:
            return
        has_children = any(step.parent_id == container_step.id for step in self.steps)
        if not has_children:
            container_step.is_container = False
