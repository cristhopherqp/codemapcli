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
    FlowGraphBuilder,
    NodeKey,
    PendingExit,
    collect_metrics,
    collapse_whitespace,
    contains_type,
    dedent_code,
    find_enclosing_key,
    first_capture,
    flow_label,
    iter_body_nodes,
    line_of,
    node_key,
    node_text,
    normalize_callee,
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

# Flujo intra-función: bucles, decisiones, asignaciones y saltos.
FLOW_LOOP_TYPES = frozenset({"for_statement", "while_statement"})
FLOW_DECISION_TYPES = frozenset({"if_statement", "match_statement"})
FLOW_ASSIGNMENT_TYPES = frozenset({"assignment", "augmented_assignment"})
FLOW_JUMP_TYPES = frozenset(
    {"return_statement", "raise_statement", "break_statement", "continue_statement", "pass_statement"}
)
FLOW_SKIP_TYPES = frozenset({"class_definition", "decorated_definition", "comment"})
FLOW_MAX_STEPS = 40

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
    """Construye el grafo intra-función con sub-contenedores, ramas Sí/No y try/except."""
    builder = FlowGraphBuilder(FLOW_MAX_STEPS)
    param_summary = ", ".join(params) or "∅"
    _, pending = builder.emit_sequential(
        [], ROLE_ENTRY, f"in: {param_summary}", code=f"({param_summary})"
    )
    if body is not None:
        pending = walk_flow_block(body, source, function_nodes, builder, pending, parent_id=None)
    builder.close_dangling_branches(pending, parent_id=None)
    return builder.steps


def _is_docstring_statement(stmt: Node) -> bool:
    if stmt.type == "string":
        return True
    if stmt.type == "expression_statement" and stmt.named_child_count == 1:
        return stmt.named_children[0].type == "string"
    return False


def walk_flow_block(
    block: Node | None,
    source: bytes,
    function_nodes: dict[NodeKey, Node],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None = None,
) -> list[PendingExit]:
    if block is None:
        return pending
    current = pending
    for statement in block.named_children:
        if _is_docstring_statement(statement):
            continue
        current = walk_flow_statement(statement, source, function_nodes, builder, current, parent_id)
    return current


def collect_inline_lambdas(root: Node, function_nodes: dict[NodeKey, Node]) -> list[tuple[Node, Node]]:
    """Localiza en orden de ejecución pares (call, lambda) dentro de una sentencia."""
    found: list[tuple[Node, Node]] = []

    def scan_arg_for_lambdas(arg: Node, call_node: Node) -> None:
        if arg.type == "lambda":
            found.append((call_node, arg))
            return
        if arg.type == "keyword_argument":
            val = arg.child_by_field_name("value")
            if val is not None:
                scan_arg_for_lambdas(val, call_node)
            return
        visit(arg)

    def visit(node: Node) -> None:
        if node_key(node) in function_nodes or node.type == "lambda":
            return
        if node.type == "call":
            callee = node.child_by_field_name("function")
            if callee is not None:
                visit(callee)
            args = node.child_by_field_name("arguments")
            if args is not None:
                for arg in args.named_children:
                    scan_arg_for_lambdas(arg, node)
            return
        for child in node.named_children:
            visit(child)

    visit(root)
    return found


def emit_lambda_steps(
    stmt: Node,
    lambdas: list[tuple[Node, Node]],
    source: bytes,
    function_nodes: dict[NodeKey, Node],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None = None,
) -> list[PendingExit]:
    current = pending
    for idx, (call_node, lambda_node) in enumerate(lambdas):
        callee_node = call_node.child_by_field_name("function")
        callee_name = normalize_callee(node_text(callee_node, source)) if callee_node else "lambda"
        lam_params = parameter_names(lambda_node.child_by_field_name("parameters"), source)
        params_label = ", ".join(lam_params) or "∅"

        lead = ""
        if idx == 0 and stmt is not call_node:
            raw_lead = collapse_whitespace(text_between(source, stmt, call_node))
            if raw_lead and len(raw_lead) <= 40:
                lead = f"{raw_lead} "

        header_label = f"🔁 {lead}{callee_name}({params_label})"
        code_node = stmt if (idx == 0 and len(lambdas) == 1) else call_node
        lam_step, current = builder.emit_sequential(
            current,
            step_role(callee_node or call_node, source, function_nodes),
            header_label,
            code=dedent_code(node_text(code_node, source)),
            parent_id=parent_id,
            is_container=True,
            kind="loop",
        )
        if lam_step is None:
            return current

        body_node = lambda_node.child_by_field_name("body")
        if body_node is not None:
            builder.emit_sequential(
                [],
                step_role(body_node, source, function_nodes),
                flow_label(node_text(body_node, source)),
                code=dedent_code(node_text(body_node, source)),
                parent_id=lam_step.id,
            )
        builder.finalize_container(lam_step)
    return current


def walk_flow_statement(
    node: Node,
    source: bytes,
    function_nodes: dict[NodeKey, Node],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None = None,
) -> list[PendingExit]:
    if node_key(node) in function_nodes or node.type in FLOW_SKIP_TYPES:
        return pending

    if node.type == "block":
        return walk_flow_block(node, source, function_nodes, builder, pending, parent_id)

    if node.type in FLOW_LOOP_TYPES:
        return walk_loop_statement(node, source, function_nodes, builder, pending, parent_id)

    if node.type == "if_statement":
        return walk_if_statement(node, source, function_nodes, builder, pending, parent_id)

    if node.type == "match_statement":
        return walk_match_statement(node, source, function_nodes, builder, pending, parent_id)

    if node.type == "try_statement":
        return walk_try_statement(node, source, function_nodes, builder, pending, parent_id)

    if node.type == "with_statement":
        _, next_pending = builder.emit_sequential(
            pending,
            step_role(node, source, function_nodes),
            header_text(node, source),
            code=dedent_code(node_text(node, source)),
            parent_id=parent_id,
        )
        body = next((c for c in node.named_children if c.type == "block"), None)
        return walk_flow_block(body, source, function_nodes, builder, next_pending, parent_id)

    lambdas = collect_inline_lambdas(node, function_nodes)
    if lambdas:
        return emit_lambda_steps(node, lambdas, source, function_nodes, builder, pending, parent_id)

    is_standard = (
        node.type in FLOW_JUMP_TYPES
        or contains_type(node, CALL_TYPES | AWAIT_TYPES | FLOW_ASSIGNMENT_TYPES, function_nodes)
    )
    if not is_standard:
        return pending

    _, next_pending = builder.emit_sequential(
        pending,
        step_role(node, source, function_nodes),
        flow_label(node_text(node, source)),
        code=dedent_code(node_text(node, source)),
        parent_id=parent_id,
    )
    return next_pending


def walk_loop_statement(
    node: Node,
    source: bytes,
    function_nodes: dict[NodeKey, Node],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None,
) -> list[PendingExit]:
    loop_step, next_pending = builder.emit_sequential(
        pending,
        step_role(node, source, function_nodes),
        f"🔁 {header_text(node, source)}",
        code=dedent_code(node_text(node, source)),
        parent_id=parent_id,
        is_container=True,
        kind="loop",
    )
    if loop_step is None:
        return next_pending

    body = node.child_by_field_name("body") or next(
        (c for c in node.named_children if c.type == "block"), None
    )
    if body is not None:
        inner_pending = walk_flow_block(
            body, source, function_nodes, builder, [], parent_id=loop_step.id
        )
        builder.close_dangling_branches(inner_pending, parent_id=loop_step.id)
    builder.finalize_container(loop_step)

    else_clause = next((c for c in node.named_children if c.type == "else_clause"), None)
    if else_clause is not None:
        else_block = next((c for c in else_clause.named_children if c.type == "block"), None)
        return walk_flow_block(else_block, source, function_nodes, builder, next_pending, parent_id)
    return next_pending


def walk_if_statement(
    node: Node,
    source: bytes,
    function_nodes: dict[NodeKey, Node],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None,
) -> list[PendingExit]:
    if_step, _ = builder.emit_sequential(
        pending,
        ROLE_DECISION,
        header_text(node, source),
        code=dedent_code(node_text(node, source)),
        parent_id=parent_id,
    )
    if if_step is None:
        return pending

    consequence = node.child_by_field_name("consequence")
    end_exits = walk_flow_block(
        consequence,
        source,
        function_nodes,
        builder,
        [(if_step.id, "Sí", "branch_yes")],
        parent_id=parent_id,
    )
    no_pending: list[PendingExit] = [(if_step.id, "No", "branch_no")]

    for alt in node.children_by_field_name("alternative"):
        if alt.type == "elif_clause":
            elif_step, _ = builder.emit_sequential(
                no_pending,
                ROLE_DECISION,
                header_text(alt, source),
                code=dedent_code(node_text(alt, source)),
                parent_id=parent_id,
            )
            if elif_step is None:
                continue
            elif_body = alt.child_by_field_name("consequence")
            end_exits.extend(
                walk_flow_block(
                    elif_body,
                    source,
                    function_nodes,
                    builder,
                    [(elif_step.id, "Sí", "branch_yes")],
                    parent_id=parent_id,
                )
            )
            no_pending = [(elif_step.id, "No", "branch_no")]
        elif alt.type == "else_clause":
            else_body = next((c for c in alt.named_children if c.type == "block"), None)
            end_exits.extend(
                walk_flow_block(
                    else_body,
                    source,
                    function_nodes,
                    builder,
                    no_pending,
                    parent_id=parent_id,
                )
            )
            no_pending = []

    end_exits.extend(no_pending)
    return end_exits


def walk_match_statement(
    node: Node,
    source: bytes,
    function_nodes: dict[NodeKey, Node],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None,
) -> list[PendingExit]:
    match_step, _ = builder.emit_sequential(
        pending,
        ROLE_DECISION,
        header_text(node, source),
        code=dedent_code(node_text(node, source)),
        parent_id=parent_id,
    )
    if match_step is None:
        return pending

    body = node.child_by_field_name("body") or next(
        (c for c in node.named_children if c.type == "block"), None
    )
    exits: list[PendingExit] = []
    has_wildcard = False
    if body is not None:
        for clause in body.named_children:
            if clause.type != "case_clause":
                continue
            clause_lbl = header_text(clause, source)
            if re.match(r"^case\s+_\b", clause_lbl):
                has_wildcard = True
            clause_block = next((c for c in clause.named_children if c.type == "block"), None)
            clause_exits = walk_flow_block(
                clause_block,
                source,
                function_nodes,
                builder,
                [(match_step.id, clause_lbl, "branch_yes")],
                parent_id=parent_id,
            )
            exits.extend(clause_exits)
    if not has_wildcard:
        exits.append((match_step.id, "No", "branch_no"))
    return exits or [(match_step.id, "", "flow")]


def walk_try_statement(
    node: Node,
    source: bytes,
    function_nodes: dict[NodeKey, Node],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None,
) -> list[PendingExit]:
    try_body = node.child_by_field_name("body") or next(
        (c for c in node.named_children if c.type == "block"), None
    )
    before_try = len(builder.steps)
    try_exits = walk_flow_block(try_body, source, function_nodes, builder, pending, parent_id)
    if len(builder.steps) == before_try:
        anchor_step, try_exits = builder.emit_sequential(
            pending,
            ROLE_TRANSFORM,
            "try",
            code=dedent_code(node_text(try_body, source)) or "try",
            parent_id=parent_id,
        )
        try_anchor_id = anchor_step.id if anchor_step else None
    else:
        try_anchor_id = builder.steps[before_try].id

    combined_exits = list(try_exits)
    for child in node.named_children:
        if child.type not in ("except_clause", "except_group_clause") or try_anchor_id is None:
            continue
        exc_label = header_text(child, source)
        edge_label = f"⚠️ {exc_label}"
        exc_start: list[PendingExit] = [(try_anchor_id, edge_label, "exception")]
        clause_block = next((c for c in child.named_children if c.type == "block"), None)
        before_exc = len(builder.steps)
        exc_exits = walk_flow_block(
            clause_block, source, function_nodes, builder, exc_start, parent_id
        )
        if len(builder.steps) == before_exc:
            exc_step, exc_exits = builder.emit_sequential(
                exc_start,
                ROLE_TRANSFORM,
                exc_label,
                code=dedent_code(node_text(child, source)),
                parent_id=parent_id,
                kind="except",
            )
            if exc_step is None:
                exc_exits = exc_start
        else:
            for step in builder.steps[before_exc:]:
                if step.kind == "step":
                    step.kind = "except"
        combined_exits.extend(exc_exits)

    else_clause = next((c for c in node.named_children if c.type == "else_clause"), None)
    if else_clause is not None:
        else_block = next((c for c in else_clause.named_children if c.type == "block"), None)
        else_exits = walk_flow_block(
            else_block, source, function_nodes, builder, try_exits, parent_id
        )
        combined_exits.extend(else_exits)

    finally_clause = next((c for c in node.named_children if c.type == "finally_clause"), None)
    if finally_clause is not None:
        fin_block = next((c for c in finally_clause.named_children if c.type == "block"), None)
        combined_exits = walk_flow_block(
            fin_block, source, function_nodes, builder, combined_exits, parent_id
        )

    return combined_exits


def header_text(node: Node, source: bytes) -> str:
    """Cabecera de una sentencia compuesta: 'for v in reversed(topo)'."""
    block = next((c for c in node.named_children if c.type == "block"), None)
    raw = text_between(source, node, block) if block is not None else node_text(node, source)
    return flow_label(raw).rstrip(":").rstrip()


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
