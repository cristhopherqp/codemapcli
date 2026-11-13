"""Extractor tree-sitter para Python (.py).

Produce un FileAnalysis con funciones (incluye métodos y funciones anidadas),
llamadas por función, imports, roles base y flujo intra-función.
"""

from __future__ import annotations

import re

from tree_sitter import Node

from codemap.fingerprint import compute_fingerprint
from codemap.languages import get_parser
from codemap.models import (
    ROLE_DECISION,
    ROLE_ENTRY,
    ROLE_IO,
    ROLE_TRANSFORM,
    CallSite,
    FileAnalysis,
    FlowStep,
    FunctionInfo,
    ImportBinding,
)
from codemap.parsers.common import (
    DOCSTRING_MAX_CHARS,
    NodeKey,
    collect_metrics,
    contains_type,
    find_enclosing_key,
    first_capture,
    iter_body_nodes,
    line_of,
    node_key,
    node_text,
    normalize_callee,
    one_line,
    parameter_names,
    run_matches,
    signature_text,
    text_between,
    unique_qualname,
)
from codemap.roles import is_io_call, looks_like_entry_name

LANGUAGE = "python"

# ---------------------------------------------------------------------------
# Consultas AST (S-expressions de tree-sitter)
#   (tipo_nodo campo: (tipo_hijo) @captura)
#   - `campo:` restringe a un hijo con ese nombre de campo en la gramática.
#   - `(_)` acepta cualquier nodo con nombre.
#   - `@captura` etiqueta el nodo para leerlo desde Python.
# ---------------------------------------------------------------------------

# Toda definición `def`/`async def`, a cualquier profundidad (módulo, clase o
# dentro de otra función). @function = nodo completo, @name = identificador.
FUNCTION_QUERY = """
(function_definition
  name: (identifier) @name) @function
"""

# Clases: solo necesitamos su nombre para resolver `Clase()` y `Clase.metodo()`.
CLASS_QUERY = """
(class_definition
  name: (identifier) @name) @class
"""

# Toda invocación `algo(...)`. El campo `function:` es lo invocado:
#   identifier -> foo()      attribute -> obj.metodo()
CALL_QUERY = """
(call
  function: (_) @callee) @call
"""

# Cuatro formas de import; cada patrón genera su propio match y lo
# distinguimos por las capturas presentes (@module / @from_module / @alias).
IMPORT_QUERY = """
; import a.b
(import_statement
  name: (dotted_name) @module)

; import a.b as c
(import_statement
  name: (aliased_import
    name: (dotted_name) @module
    alias: (identifier) @alias))

; from a.b import c      /  from . import c   (module_name puede ser relative_import)
(import_from_statement
  module_name: (_) @from_module
  name: (dotted_name) @name)

; from a.b import c as d
(import_from_statement
  module_name: (_) @from_module
  name: (aliased_import
    name: (dotted_name) @name
    alias: (identifier) @alias))
"""

# Tipos de nodo relevantes de la gramática de Python.
SCOPE_TYPES = frozenset({"function_definition", "class_definition"})
BRANCH_TYPES = frozenset({"if_statement", "elif_clause", "case_clause"})
RETURN_TYPES = frozenset({"return_statement"})
AWAIT_TYPES = frozenset({"await"})
GLOBAL_TYPES = frozenset({"global_statement", "nonlocal_statement"})
CALL_TYPES = frozenset({"call"})

# Flujo intra-función: sentencias que bifurcan (rombo) y cláusulas hijas.
FLOW_DECISION_TYPES = frozenset(
    {
        "if_statement", "elif_clause", "for_statement", "while_statement",
        "match_statement", "case_clause", "except_clause", "except_group_clause",
    }
)
FLOW_CLAUSE_TYPES = frozenset(
    {
        "elif_clause", "else_clause", "except_clause", "except_group_clause",
        "finally_clause", "case_clause",
    }
)
FLOW_SKIP_TYPES = frozenset({"class_definition", "decorated_definition", "comment"})
FLOW_MAX_STEPS = 30

# Decoradores que marcan puntos de entrada (Flask/FastAPI/Click/eventos...).
ENTRY_DECORATOR_PATTERN = re.compile(
    r"\.(route|get|post|put|delete|patch|websocket|command|on_event|event|"
    r"callback|listener|handler|task)\b"
)


# ---------------------------------------------------------------------------
# Punto de entrada del módulo
# ---------------------------------------------------------------------------

def parse_python_file(path: str, source: bytes) -> FileAnalysis:
    root = get_parser(LANGUAGE).parse(source).root_node
    analysis = FileAnalysis(path=path, language=LANGUAGE)

    function_nodes = collect_function_nodes(root)
    calls_by_function = collect_calls(root, source, function_nodes)

    used_names: set[str] = set()
    for key, node in function_nodes.items():
        info = build_function(node, source, function_nodes, calls_by_function.get(key, []))
        info.qualname = unique_qualname(info.qualname, info.line, used_names)
        analysis.functions.append(info)

    analysis.class_names = collect_class_names(root, source)
    analysis.imports = collect_imports(root, source)
    return analysis


# ---------------------------------------------------------------------------
# Funciones y ámbitos
# ---------------------------------------------------------------------------

def collect_function_nodes(root: Node) -> dict[NodeKey, Node]:
    """{NodeKey: nodo function_definition} en orden de aparición."""
    functions: dict[NodeKey, Node] = {}
    for captures in run_matches(LANGUAGE, FUNCTION_QUERY, root):
        node = first_capture(captures, "function")
        if node is not None:
            functions[node_key(node)] = node
    return dict(sorted(functions.items()))


def collect_class_names(root: Node, source: bytes) -> set[str]:
    names: set[str] = set()
    for captures in run_matches(LANGUAGE, CLASS_QUERY, root):
        node = first_capture(captures, "class")
        if node is not None:
            names.add(describe_scope(node, source)[0])
    return names


def describe_scope(node: Node, source: bytes) -> tuple[str, str | None, str | None]:
    """Devuelve (qualname, class_name, container) de una def/clase.

    - qualname: nombres de clases/funciones contenedoras + propio ("A.m", "f.inner").
    - class_name: clase contenedora inmediata (solo si es método).
    - container: qualname de la función contenedora más cercana (anidadas).
    """
    ancestors: list[Node] = []
    parent = node.parent
    while parent is not None:
        if parent.type in SCOPE_TYPES:
            ancestors.append(parent)
        parent = parent.parent
    ancestors.reverse()

    names = [node_text(a.child_by_field_name("name"), source) for a in ancestors]
    own_name = node_text(node.child_by_field_name("name"), source)
    qualname = ".".join(names + [own_name])

    class_name = None
    if ancestors and ancestors[-1].type == "class_definition":
        class_name = ".".join(names)

    container = None
    for index in range(len(ancestors) - 1, -1, -1):
        if ancestors[index].type == "function_definition":
            container = ".".join(names[: index + 1])
            break

    return qualname, class_name, container


def build_function(
    node: Node,
    source: bytes,
    function_nodes: dict[NodeKey, Node],
    calls: list[CallSite],
) -> FunctionInfo:
    qualname, class_name, container = describe_scope(node, source)
    short_name = node_text(node.child_by_field_name("name"), source)
    body = node.child_by_field_name("body")
    params = parameter_names(node.child_by_field_name("parameters"), source)

    metrics = collect_metrics(
        body, function_nodes, BRANCH_TYPES, RETURN_TYPES, AWAIT_TYPES, GLOBAL_TYPES
    )
    has_io = (
        metrics.has_await
        or metrics.mutates_global
        or any(is_io_call(call.callee) for call in calls)
    )

    return FunctionInfo(
        qualname=qualname,
        short_name=short_name,
        class_name=class_name,
        container=container,
        line=line_of(node),
        signature=signature_text(source, node, body),
        docstring=extract_docstring(body, source),
        param_count=len(params),
        calls=calls,
        internal_flow=build_flow(params, body, source, function_nodes),
        branch_count=metrics.branch_count,
        return_count=metrics.return_count,
        has_io=has_io,
        is_entry_hint=looks_like_entry_name(short_name) or has_entry_decorator(node, source),
        fingerprint=compute_fingerprint(
            len(params), metrics.node_types, [c.callee for c in calls], short_name
        ),
    )


def has_entry_decorator(node: Node, source: bytes) -> bool:
    """@app.route(...), @router.get(...), @click.command() ..."""
    parent = node.parent
    if parent is None or parent.type != "decorated_definition":
        return False
    for child in parent.named_children:
        if child.type == "decorator" and ENTRY_DECORATOR_PATTERN.search(node_text(child, source)):
            return True
    return False


def extract_docstring(body: Node | None, source: bytes) -> str:
    """Primer literal string del cuerpo (con o sin expression_statement envolvente)."""
    if body is None or body.named_child_count == 0:
        return ""
    first = body.named_children[0]
    if first.type == "expression_statement" and first.named_child_count > 0:
        first = first.named_children[0]
    if first.type != "string":
        return ""
    parts = [node_text(c, source) for c in first.named_children if c.type == "string_content"]
    text = "".join(parts) if parts else node_text(first, source).strip("\"'")
    return text.strip()[:DOCSTRING_MAX_CHARS]


# ---------------------------------------------------------------------------
# Llamadas
# ---------------------------------------------------------------------------

def collect_calls(
    root: Node,
    source: bytes,
    function_nodes: dict[NodeKey, Node],
) -> dict[NodeKey, list[CallSite]]:
    """Asigna cada llamada a la función que la contiene más de cerca.
    Las llamadas a nivel de módulo (sin función contenedora) se descartan."""
    calls: dict[NodeKey, list[CallSite]] = {}
    for captures in run_matches(LANGUAGE, CALL_QUERY, root):
        call_node = first_capture(captures, "call")
        callee_node = first_capture(captures, "callee")
        if call_node is None or callee_node is None:
            continue
        owner = find_enclosing_key(call_node, function_nodes)
        if owner is None:
            continue
        callee = normalize_callee(node_text(callee_node, source))
        calls.setdefault(owner, []).append(CallSite(callee=callee, line=line_of(call_node)))
    return calls


# ---------------------------------------------------------------------------
# Imports
# ---------------------------------------------------------------------------

def collect_imports(root: Node, source: bytes) -> list[ImportBinding]:
    bindings: list[ImportBinding] = []
    for captures in run_matches(LANGUAGE, IMPORT_QUERY, root):
        alias = node_text(first_capture(captures, "alias"), source) or None
        module_node = first_capture(captures, "module")
        from_node = first_capture(captures, "from_module")

        if module_node is not None:  # import a.b [as c]
            module = node_text(module_node, source)
            bindings.append(
                ImportBinding(
                    local_name=alias or module,
                    module=module,
                    imported_name=None,
                    line=line_of(module_node),
                )
            )
        elif from_node is not None:  # from x import y [as z]
            name = node_text(first_capture(captures, "name"), source)
            bindings.append(
                ImportBinding(
                    local_name=alias or name,
                    module=node_text(from_node, source),
                    imported_name=name,
                    line=line_of(from_node),
                )
            )
    return bindings


# ---------------------------------------------------------------------------
# Flujo intra-función (Nivel 3+)
# ---------------------------------------------------------------------------

def build_flow(
    params: list[str],
    body: Node | None,
    source: bytes,
    function_nodes: dict[NodeKey, Node],
) -> list[FlowStep]:
    """Secuencia en orden de código: entrada, bifurcaciones, bucles,
    llamadas clave y retornos."""
    steps: list[FlowStep] = []
    add_step(steps, ROLE_ENTRY, "in: " + (", ".join(params) or "∅"))
    if body is not None:
        walk_flow_block(body, source, function_nodes, steps)
    return steps


def add_step(steps: list[FlowStep], role: str, label: str) -> None:
    if len(steps) > FLOW_MAX_STEPS:
        return
    if len(steps) == FLOW_MAX_STEPS:
        role, label = ROLE_TRANSFORM, "…"
    steps.append(FlowStep(id=f"n{len(steps) + 1}", role=role, label=label))


def walk_flow_block(
    block: Node, source: bytes, function_nodes: dict[NodeKey, Node], steps: list[FlowStep]
) -> None:
    for statement in block.named_children:
        walk_flow_statement(statement, source, function_nodes, steps)


def walk_flow_statement(
    node: Node, source: bytes, function_nodes: dict[NodeKey, Node], steps: list[FlowStep]
) -> None:
    if node_key(node) in function_nodes or node.type in FLOW_SKIP_TYPES:
        return

    if node.type in FLOW_DECISION_TYPES:
        add_step(steps, ROLE_DECISION, header_text(node, source))
        walk_flow_children(node, source, function_nodes, steps)
    elif node.type == "with_statement":
        add_step(steps, step_role(node, source, function_nodes), header_text(node, source))
        walk_flow_children(node, source, function_nodes, steps)
    elif node.type in ("try_statement", "else_clause", "finally_clause", "block"):
        walk_flow_children(node, source, function_nodes, steps)
    elif node.type in ("return_statement", "raise_statement"):
        add_step(steps, step_role(node, source, function_nodes), one_line(node_text(node, source)))
    elif contains_type(node, CALL_TYPES, function_nodes):
        add_step(steps, step_role(node, source, function_nodes), one_line(node_text(node, source)))


def walk_flow_children(
    node: Node, source: bytes, function_nodes: dict[NodeKey, Node], steps: list[FlowStep]
) -> None:
    """Desciende solo a bloques y cláusulas (no a condiciones ni expresiones)."""
    for child in node.named_children:
        if child.type == "block":
            walk_flow_block(child, source, function_nodes, steps)
        elif child.type in FLOW_CLAUSE_TYPES:
            walk_flow_statement(child, source, function_nodes, steps)


def header_text(node: Node, source: bytes) -> str:
    """Cabecera de una sentencia compuesta: 'for v in reversed(topo)'."""
    block = next((c for c in node.named_children if c.type == "block"), None)
    raw = text_between(source, node, block) if block is not None else node_text(node, source)
    return one_line(raw).rstrip(":").rstrip()


def step_role(node: Node, source: bytes, function_nodes: dict[NodeKey, Node]) -> str:
    """io si el paso contiene await o una llamada de I/O conocida."""
    for item in iter_body_nodes(node, function_nodes):
        if item.type in AWAIT_TYPES:
            return ROLE_IO
        if item.type == "call":
            callee = normalize_callee(node_text(item.child_by_field_name("function"), source))
            if is_io_call(callee):
                return ROLE_IO
    return ROLE_TRANSFORM
