"""Extractor tree-sitter para JavaScript y TypeScript (.js, .jsx, .ts, .tsx).

Las cuatro gramáticas comparten casi todos los nombres de nodo; la única
diferencia que nos afecta es la de los campos de clase:
  JS: (field_definition property: ...)    TS: (public_field_definition name: ...)
"""

from __future__ import annotations

import re
from dataclasses import dataclass

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

# ---------------------------------------------------------------------------
# Consultas AST (S-expressions de tree-sitter)
#   - `[(a) (b)]` es una alternativa: encaja con cualquiera de los tipos.
#   - `?` marca un hijo opcional.
#   - `((patrón) (#eq? @cap "texto"))` filtra el match por el texto capturado.
# ---------------------------------------------------------------------------

# Funciones con nombre propio o heredado del contexto:
#   function foo() {}          function* gen() {}
#   class A { foo() {} }       const foo = () => {} / function () {}
# @function = nodo que tiene parámetros y cuerpo.
# @anchor   = nodo desde el que se lee la firma (incluye el nombre de la variable).
_FUNCTION_QUERY_COMMON = """
(function_declaration
  name: (identifier) @name) @function

(generator_function_declaration
  name: (identifier) @name) @function

(method_definition
  name: (_) @name) @function

(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression) (generator_function)] @function) @anchor
"""

# Campo de clase con función: class A { handle = () => {} }
_FIELD_QUERY_JS = """
(field_definition
  property: (_) @name
  value: [(arrow_function) (function_expression)] @function) @anchor
"""
_FIELD_QUERY_TS = """
(public_field_definition
  name: (_) @name
  value: [(arrow_function) (function_expression)] @function) @anchor
"""

FUNCTION_QUERIES: dict[str, str] = {
    "javascript": _FUNCTION_QUERY_COMMON + _FIELD_QUERY_JS,
    "typescript": _FUNCTION_QUERY_COMMON + _FIELD_QUERY_TS,
    "tsx": _FUNCTION_QUERY_COMMON + _FIELD_QUERY_TS,
}

# Callbacks anónimos pasados como argumento: app.get('/u', (req, res) => {...}).
# Solo los de nivel de módulo se convierten en nodos (manejadores de rutas/eventos).
CALLBACK_QUERY = """
(call_expression
  function: (_) @callee
  arguments: (arguments [(arrow_function) (function_expression)] @callback)) @call
"""

# Clases (JS y TS; las abstractas solo existen en TS, por eso van aparte).
CLASS_QUERY_JS = """
(class_declaration name: (_) @name) @class
"""
CLASS_QUERY_TS = """
(class_declaration name: (_) @name) @class
(abstract_class_declaration name: (_) @name) @class
"""

# Invocaciones normales y constructores: foo(), obj.m(), new Foo().
CALL_QUERY = """
(call_expression
  function: (_) @callee) @call

(new_expression
  constructor: (_) @callee) @call
"""

# Imports ES, re-exports y require() de CommonJS. Cada patrón se distingue
# por el nombre de sus capturas.
IMPORT_QUERY = """
; import d from './m'
(import_statement
  (import_clause (identifier) @default_name)
  source: (string (string_fragment) @source))

; import * as ns from './m'
(import_statement
  (import_clause (namespace_import (identifier) @namespace_name))
  source: (string (string_fragment) @source))

; import { a, b as c } from './m'
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (_) @name
        alias: (_)? @alias)))
  source: (string (string_fragment) @source))

; export { a, b as c } from './m'   (re-export: permite seguir la cadena)
(export_statement
  (export_clause
    (export_specifier
      name: (_) @name
      alias: (_)? @alias))
  source: (string (string_fragment) @source))

; const m = require('./m')
((variable_declarator
   name: (identifier) @namespace_name
   value: (call_expression
     function: (identifier) @_require
     arguments: (arguments (string (string_fragment) @source))))
 (#eq? @_require "require"))

; const { a, b } = require('./m')
((variable_declarator
   name: (object_pattern (shorthand_property_identifier_pattern) @name)
   value: (call_expression
     function: (identifier) @_require
     arguments: (arguments (string (string_fragment) @source))))
 (#eq? @_require "require"))
"""

CLASS_TYPES = frozenset({"class_declaration", "abstract_class_declaration", "class"})
FUNCTION_VALUE_TYPES = frozenset({"arrow_function", "function_expression"})
BRANCH_TYPES = frozenset({"if_statement", "switch_case"})
RETURN_TYPES = frozenset({"return_statement"})
AWAIT_TYPES = frozenset({"await_expression"})
CALL_TYPES = frozenset({"call_expression", "new_expression"})
IGNORED_CALLEES = frozenset({"require", "super", "import"})
GLOBAL_TARGET_PATTERN = re.compile(r"^(window|globalThis|global|document)\.")

# Flujo intra-función.
FLOW_LOOP_TYPES = frozenset({"for_statement", "for_in_statement", "while_statement", "do_statement"})
FLOW_DECISION_TYPES = frozenset({"if_statement", "switch_statement"})
FLOW_ASSIGNMENT_TYPES = frozenset(
    {"assignment_expression", "augmented_assignment_expression", "update_expression"}
)
FLOW_JUMP_TYPES = frozenset(
    {"return_statement", "throw_statement", "break_statement", "continue_statement"}
)
FLOW_DECLARATION_TYPES = frozenset({"lexical_declaration", "variable_declaration"})
FLOW_MAX_STEPS = 40


@dataclass
class FunctionNode:
    """Función candidata antes de convertirse en FunctionInfo."""

    node: Node         # nodo con parámetros y cuerpo
    name: str          # nombre propio o derivado del contexto
    anchor: Node       # inicio de la firma
    is_callback: bool  # callback de nivel de módulo (manejador)


# ---------------------------------------------------------------------------
# Punto de entrada del módulo
# ---------------------------------------------------------------------------

def parse_js_file(path: str, source: bytes, language: str) -> FileAnalysis:
    root = get_parser(language).parse(source).root_node
    analysis = FileAnalysis(path=path, language=language)

    function_nodes = collect_function_nodes(root, source, language)
    default_name, default_node = find_default_export(root, source)
    if default_node is not None and node_key(default_node) not in function_nodes:
        function_nodes[node_key(default_node)] = FunctionNode(
            default_node, "default", default_node, is_callback=False
        )
    collect_module_callbacks(root, source, language, function_nodes)
    function_nodes = dict(sorted(function_nodes.items()))

    calls_by_function = collect_calls(root, source, language, function_nodes)

    used_names: set[str] = set()
    for key, candidate in function_nodes.items():
        info = build_function(candidate, source, function_nodes, calls_by_function.get(key, []))
        info.qualname = unique_qualname(info.qualname, info.line, used_names)
        analysis.functions.append(info)

    analysis.class_names = collect_class_names(root, source, language, function_nodes)
    analysis.imports = collect_imports(root, source, language)
    analysis.default_export = default_name
    return analysis


# ---------------------------------------------------------------------------
# Descubrimiento de funciones
# ---------------------------------------------------------------------------

def collect_function_nodes(root: Node, source: bytes, language: str) -> dict[NodeKey, FunctionNode]:
    functions: dict[NodeKey, FunctionNode] = {}
    for captures in run_matches(language, FUNCTION_QUERIES[language], root):
        node = first_capture(captures, "function")
        name_node = first_capture(captures, "name")
        if node is None or name_node is None:
            continue
        anchor = first_capture(captures, "anchor") or node
        functions[node_key(node)] = FunctionNode(
            node, node_text(name_node, source), anchor, is_callback=False
        )
    return functions


def collect_module_callbacks(
    root: Node, source: bytes, language: str, functions: dict[NodeKey, FunctionNode]
) -> None:
    """Registra callbacks anónimos de nivel de módulo, nombrados por contexto y línea:
    app.get('/users', (req, res) => ...)  ->  "app.get[/users]@L12".
    Se procesan en orden de aparición, así un callback dentro de otro ya
    registrado queda como parte del exterior."""
    matches = run_matches(language, CALLBACK_QUERY, root)
    matches.sort(key=lambda c: c["callback"][0].start_byte)
    for captures in matches:
        callback = first_capture(captures, "callback")
        call = first_capture(captures, "call")
        callee = first_capture(captures, "callee")
        if callback is None or call is None or callee is None:
            continue
        if node_key(callback) in functions or find_enclosing_key(callback, functions) is not None:
            continue
        name = callback_name(call, callee, callback, source)
        functions[node_key(callback)] = FunctionNode(callback, name, callback, is_callback=True)


def callback_name(call: Node, callee: Node, callback: Node, source: bytes) -> str:
    context = normalize_callee(node_text(callee, source))
    arguments = call.child_by_field_name("arguments")
    first_arg = arguments.named_children[0] if arguments and arguments.named_child_count else None
    if first_arg is not None and first_arg.type == "string":
        route = node_text(first_arg, source).strip("'\"`")
        context += f"[{route}]"
    return f"{context}@L{line_of(callback)}"


def find_default_export(root: Node, source: bytes) -> tuple[str | None, Node | None]:
    """`export default ...` de nivel superior.
    Devuelve (nombre exportado, nodo de función anónima si la hay)."""
    for statement in root.named_children:
        if statement.type != "export_statement":
            continue
        if not any(child.type == "default" for child in statement.children):
            continue
        for child in statement.named_children:
            if child.type in FUNCTION_VALUE_TYPES:
                return "default", child
            if child.type in ("function_declaration", "generator_function_declaration", "class_declaration"):
                return node_text(child.child_by_field_name("name"), source), None
            if child.type == "identifier":
                return node_text(child, source), None
    return None, None


def collect_class_names(
    root: Node, source: bytes, language: str, functions: dict[NodeKey, FunctionNode]
) -> set[str]:
    query = CLASS_QUERY_JS if language == "javascript" else CLASS_QUERY_TS
    names: set[str] = set()
    for captures in run_matches(language, query, root):
        node = first_capture(captures, "class")
        name_node = first_capture(captures, "name")
        if node is None or name_node is None:
            continue
        scope_names, _, _ = scope_chain(node, source, functions)
        names.add(".".join(scope_names + [node_text(name_node, source)]))
    return names


# ---------------------------------------------------------------------------
# Ámbitos y construcción de FunctionInfo
# ---------------------------------------------------------------------------

def scope_chain(
    node: Node, source: bytes, functions: dict[NodeKey, FunctionNode]
) -> tuple[list[str], str | None, str | None]:
    """Nombres de clases/funciones que contienen a `node` (de fuera hacia dentro),
    más class_name inmediata y container (función contenedora más cercana)."""
    ancestors: list[tuple[str, str]] = []  # (kind, name)
    parent = node.parent
    while parent is not None:
        key = node_key(parent)
        if key in functions:
            ancestors.append(("function", functions[key].name))
        elif parent.type in CLASS_TYPES and parent.child_by_field_name("name") is not None:
            ancestors.append(("class", node_text(parent.child_by_field_name("name"), source)))
        parent = parent.parent
    ancestors.reverse()

    names = [name for _, name in ancestors]
    class_name = ".".join(names) if ancestors and ancestors[-1][0] == "class" else None
    container = None
    for index in range(len(ancestors) - 1, -1, -1):
        if ancestors[index][0] == "function":
            container = ".".join(names[: index + 1])
            break
    return names, class_name, container


def build_function(
    candidate: FunctionNode,
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
    calls: list[CallSite],
) -> FunctionInfo:
    node = candidate.node
    scope_names, class_name, container = scope_chain(node, source, functions)
    body = node.child_by_field_name("body")
    params_node = node.child_by_field_name("parameters") or node.child_by_field_name("parameter")
    params = parameter_names(params_node, source)

    metrics = collect_metrics(
        body, functions, BRANCH_TYPES, RETURN_TYPES, AWAIT_TYPES, frozenset()
    )
    has_io = (
        metrics.has_await
        or mutates_global(body, source, functions)
        or any(is_io_call(call.callee) for call in calls)
    )

    return FunctionInfo(
        qualname=".".join(scope_names + [candidate.name]),
        short_name=candidate.name,
        class_name=class_name,
        container=container,
        line=line_of(node),
        signature=signature_text(source, candidate.anchor, body),
        docstring=extract_jsdoc(candidate.anchor, source),
        param_count=len(params),
        calls=calls,
        internal_flow=build_flow(params, body, source, functions),
        branch_count=metrics.branch_count,
        return_count=metrics.return_count,
        has_io=has_io,
        is_entry_hint=candidate.is_callback or looks_like_entry_name(candidate.name),
        fingerprint=compute_fingerprint(
            len(params), metrics.node_types, [c.callee for c in calls], candidate.name
        ),
    )


def mutates_global(body: Node | None, source: bytes, functions: dict[NodeKey, FunctionNode]) -> bool:
    """Asignaciones del tipo window.x = ..., globalThis.y = ..."""
    for item in iter_body_nodes(body, functions):
        if item.type == "assignment_expression":
            left = node_text(item.child_by_field_name("left"), source)
            if GLOBAL_TARGET_PATTERN.match(left):
                return True
    return False


def extract_jsdoc(anchor: Node, source: bytes) -> str:
    """Comentario /** ... */ inmediatamente anterior a la declaración."""
    target = anchor
    while target.parent is not None and target.parent.type in (
        "lexical_declaration", "variable_declaration", "export_statement"
    ):
        target = target.parent
    previous = target.prev_named_sibling
    if previous is None or previous.type != "comment":
        return ""
    raw = node_text(previous, source)
    if not raw.startswith("/**"):
        return ""
    lines = [line.strip().lstrip("*").strip() for line in raw[3:-2].splitlines()]
    return "\n".join(line for line in lines if line).strip()[:DOCSTRING_MAX_CHARS]


# ---------------------------------------------------------------------------
# Llamadas e imports
# ---------------------------------------------------------------------------

def collect_calls(
    root: Node, source: bytes, language: str, functions: dict[NodeKey, FunctionNode]
) -> dict[NodeKey, list[CallSite]]:
    calls: dict[NodeKey, list[CallSite]] = {}
    for captures in run_matches(language, CALL_QUERY, root):
        call_node = first_capture(captures, "call")
        callee_node = first_capture(captures, "callee")
        if call_node is None or callee_node is None:
            continue
        callee = normalize_callee(node_text(callee_node, source))
        if callee in IGNORED_CALLEES:
            continue
        owner = find_enclosing_key(call_node, functions)
        if owner is None:
            continue
        calls.setdefault(owner, []).append(CallSite(callee=callee, line=line_of(call_node)))
    return calls


def collect_imports(root: Node, source: bytes, language: str) -> list[ImportBinding]:
    bindings: list[ImportBinding] = []
    for captures in run_matches(language, IMPORT_QUERY, root):
        source_node = first_capture(captures, "source")
        if source_node is None:
            continue
        module = node_text(source_node, source)
        line = line_of(source_node)

        default_node = first_capture(captures, "default_name")
        namespace_node = first_capture(captures, "namespace_name")
        name_node = first_capture(captures, "name")

        if default_node is not None:
            bindings.append(ImportBinding(node_text(default_node, source), module, "default", line))
        elif namespace_node is not None:
            bindings.append(ImportBinding(node_text(namespace_node, source), module, None, line))
        elif name_node is not None:
            name = node_text(name_node, source)
            alias = node_text(first_capture(captures, "alias"), source) or name
            bindings.append(ImportBinding(alias, module, name, line))
    return bindings


# ---------------------------------------------------------------------------
# Flujo intra-función (Nivel 3+)
# ---------------------------------------------------------------------------

def build_flow(
    params: list[str],
    body: Node | None,
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
) -> list[FlowStep]:
    builder = FlowGraphBuilder(FLOW_MAX_STEPS)
    param_summary = ", ".join(params) or "∅"
    _, pending = builder.emit_sequential(
        [], ROLE_ENTRY, f"in: {param_summary}", code=f"({param_summary})"
    )
    if body is None:
        return builder.steps
    if body.type == "statement_block":
        pending = walk_flow_block(body, source, functions, builder, pending, parent_id=None)
    else:  # arrow function de expresión: x => x + 1
        pending = walk_flow_expr_body(body, source, functions, builder, pending, parent_id=None)
    builder.close_dangling_branches(pending, parent_id=None)
    return builder.steps


def walk_flow_expr_body(
    body: Node,
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None = None,
) -> list[PendingExit]:
    callbacks = collect_inline_callbacks(body, functions)
    if callbacks:
        return emit_callback_steps(body, callbacks, source, functions, builder, pending, parent_id)
    body_text = flow_label(node_text(body, source))
    role = step_role(body, source, functions)
    label = f"return {body_text}" if parent_id is None else body_text
    _, next_pending = builder.emit_sequential(
        pending,
        role,
        label,
        code=dedent_code(node_text(body, source)),
        parent_id=parent_id,
    )
    return next_pending


def walk_flow_block(
    block: Node,
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None = None,
) -> list[PendingExit]:
    current = pending
    for statement in block.named_children:
        current = walk_flow_statement(statement, source, functions, builder, current, parent_id)
    return current


def walk_flow_clause_or_block(
    node: Node | None,
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None = None,
) -> list[PendingExit]:
    if node is None:
        return pending
    if node.type == "statement_block":
        return walk_flow_block(node, source, functions, builder, pending, parent_id)
    return walk_flow_statement(node, source, functions, builder, pending, parent_id)


def walk_flow_statement(
    node: Node,
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None = None,
) -> list[PendingExit]:
    if node_key(node) in functions or node.type in ("comment", "empty_statement"):
        return pending
    # const f = () => {} dentro de una función: es una función propia, no un paso.
    if node.type in FLOW_DECLARATION_TYPES and declares_only_functions(node, functions):
        return pending

    if node.type == "statement_block":
        return walk_flow_block(node, source, functions, builder, pending, parent_id)

    if node.type in FLOW_LOOP_TYPES:
        return walk_loop_statement(node, source, functions, builder, pending, parent_id)

    if node.type == "if_statement":
        return walk_if_statement(node, source, functions, builder, pending, parent_id)

    if node.type == "switch_statement":
        return walk_switch_statement(node, source, functions, builder, pending, parent_id)

    if node.type == "try_statement":
        return walk_try_statement(node, source, functions, builder, pending, parent_id)

    callbacks = collect_inline_callbacks(node, functions)
    if callbacks:
        return emit_callback_steps(node, callbacks, source, functions, builder, pending, parent_id)

    is_standard = (
        node.type in FLOW_JUMP_TYPES
        or node.type in FLOW_DECLARATION_TYPES
        or contains_type(node, CALL_TYPES | AWAIT_TYPES | FLOW_ASSIGNMENT_TYPES, functions)
    )
    if not is_standard:
        return pending

    _, next_pending = builder.emit_sequential(
        pending,
        step_role(node, source, functions),
        flow_label(node_text(node, source)),
        code=dedent_code(node_text(node, source)),
        parent_id=parent_id,
    )
    return next_pending


def walk_loop_statement(
    node: Node,
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None,
) -> list[PendingExit]:
    loop_step, next_pending = builder.emit_sequential(
        pending,
        step_role(node, source, functions),
        f"🔁 {header_text(node, source)}",
        code=dedent_code(node_text(node, source)),
        parent_id=parent_id,
        is_container=True,
        kind="loop",
    )
    if loop_step is None:
        return next_pending
    body = node.child_by_field_name("body")
    if body is not None:
        inner_pending = walk_flow_clause_or_block(
            body, source, functions, builder, [], parent_id=loop_step.id
        )
        builder.close_dangling_branches(inner_pending, parent_id=loop_step.id)
    builder.finalize_container(loop_step)
    return next_pending


def walk_if_statement(
    node: Node,
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
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
    yes_start: list[PendingExit] = [(if_step.id, "Sí", "branch_yes")]
    then_exits = walk_flow_clause_or_block(
        consequence, source, functions, builder, yes_start, parent_id=parent_id
    )

    alt = node.child_by_field_name("alternative")
    no_start: list[PendingExit] = [(if_step.id, "No", "branch_no")]
    if alt is not None:
        alt_targets = [c for c in alt.named_children if c.type != "comment"]
        else_exits = no_start
        if alt_targets:
            else_exits = walk_flow_clause_or_block(
                alt_targets[0], source, functions, builder, no_start, parent_id=parent_id
            )
    else:
        else_exits = no_start

    return then_exits + else_exits


def walk_switch_statement(
    node: Node,
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None,
) -> list[PendingExit]:
    sw_step, _ = builder.emit_sequential(
        pending,
        ROLE_DECISION,
        header_text(node, source),
        code=dedent_code(node_text(node, source)),
        parent_id=parent_id,
    )
    if sw_step is None:
        return pending

    exits: list[PendingExit] = []
    has_default = False
    body = node.child_by_field_name("body")
    if body is not None:
        for clause in body.named_children:
            if clause.type not in ("switch_case", "switch_default"):
                continue
            if clause.type == "switch_default":
                has_default = True
            clause_pending: list[PendingExit] = [(sw_step.id, header_text(clause, source), "branch_yes")]
            for child in clause.named_children:
                if child.type == "comment":
                    continue
                if clause.type == "switch_case" and child == clause.child_by_field_name("value"):
                    continue
                clause_pending = walk_flow_clause_or_block(
                    child, source, functions, builder, clause_pending, parent_id=parent_id
                )
            exits.extend(clause_pending)
    if not has_default:
        exits.append((sw_step.id, "default", "branch_no"))
    return exits or [(sw_step.id, "", "flow")]


def walk_try_statement(
    node: Node,
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None,
) -> list[PendingExit]:
    try_body = node.child_by_field_name("body")
    before_try = len(builder.steps)
    try_exits = walk_flow_clause_or_block(
        try_body, source, functions, builder, pending, parent_id=parent_id
    )
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
    handler = node.child_by_field_name("handler")
    if handler is not None and try_anchor_id is not None:
        catch_label = header_text(handler, source)
        edge_label = f"⚠️ {catch_label}"
        catch_start: list[PendingExit] = [(try_anchor_id, edge_label, "exception")]
        before_catch = len(builder.steps)
        catch_exits = walk_flow_clause_or_block(
            handler.child_by_field_name("body"),
            source,
            functions,
            builder,
            catch_start,
            parent_id=parent_id,
        )
        if len(builder.steps) == before_catch:
            exc_step, catch_exits = builder.emit_sequential(
                catch_start,
                ROLE_TRANSFORM,
                catch_label,
                code=dedent_code(node_text(handler, source)),
                parent_id=parent_id,
                kind="except",
            )
            if exc_step is None:
                catch_exits = catch_start
        else:
            for step in builder.steps[before_catch:]:
                if step.kind == "step":
                    step.kind = "except"
        combined_exits.extend(catch_exits)

    finalizer = node.child_by_field_name("finalizer")
    if finalizer is not None:
        combined_exits = walk_flow_clause_or_block(
            finalizer.child_by_field_name("body"),
            source,
            functions,
            builder,
            combined_exits,
            parent_id=parent_id,
        )
    return combined_exits


def collect_inline_callbacks(
    root: Node, functions: dict[NodeKey, FunctionNode]
) -> list[tuple[Node, Node]]:
    """Localiza en orden de ejecución pares (call_expression, callback) cuyos
    cuerpos son callbacks anónimos inline (no funciones nombradas propias)."""
    found: list[tuple[Node, Node]] = []

    def visit(node: Node) -> None:
        if node_key(node) in functions or node.type in FUNCTION_VALUE_TYPES:
            return
        if node.type == "call_expression":
            callee = node.child_by_field_name("function")
            if callee is not None:
                visit(callee)
            args = node.child_by_field_name("arguments")
            inline_cbs: list[Node] = []
            if args is not None:
                for arg in args.named_children:
                    if arg.type in FUNCTION_VALUE_TYPES and node_key(arg) not in functions:
                        inline_cbs.append(arg)
                    else:
                        visit(arg)
            for cb in inline_cbs:
                found.append((node, cb))
            return
        for child in node.named_children:
            visit(child)

    visit(root)
    return found


def callback_call_title(call_node: Node, source: bytes) -> str:
    callee = call_node.child_by_field_name("function")
    if callee is None:
        return "callback"
    if callee.type == "member_expression":
        obj = callee.child_by_field_name("object")
        prop = callee.child_by_field_name("property")
        if obj is not None and obj.type == "call_expression" and prop is not None:
            return "." + node_text(prop, source)
    return normalize_callee(node_text(callee, source))


def shallow_call_role(call_node: Node, source: bytes) -> str:
    callee = call_node.child_by_field_name("function")
    if callee is not None and is_io_call(normalize_callee(node_text(callee, source))):
        return ROLE_IO
    return ROLE_TRANSFORM


def emit_callback_steps(
    stmt: Node,
    callbacks: list[tuple[Node, Node]],
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None = None,
) -> list[PendingExit]:
    """Emite un sub-contenedor 🔁 para cada callback y coloca dentro sus pasos limpios."""
    current = pending
    for idx, (call_node, cb_node) in enumerate(callbacks):
        call_title = callback_call_title(call_node, source)
        cb_params_node = cb_node.child_by_field_name("parameters") or cb_node.child_by_field_name("parameter")
        cb_params = parameter_names(cb_params_node, source)
        params_label = ", ".join(cb_params) or "∅"

        lead = ""
        if idx == 0 and stmt.type in ("return_statement", "throw_statement", *FLOW_DECLARATION_TYPES):
            raw_lead = collapse_whitespace(text_between(source, stmt, call_node))
            if raw_lead and len(raw_lead) <= 40:
                lead = f"{raw_lead} "

        header_label = f"🔁 {lead}{call_title}({params_label})"
        code_node = stmt if (idx == 0 and len(callbacks) == 1) else call_node
        cb_step, current = builder.emit_sequential(
            current,
            shallow_call_role(call_node, source),
            header_label,
            code=dedent_code(node_text(code_node, source)),
            parent_id=parent_id,
            is_container=True,
            kind="loop",
        )
        if cb_step is None:
            return current

        cb_body = cb_node.child_by_field_name("body")
        if cb_body is not None:
            if cb_body.type == "statement_block":
                inner_pending = walk_flow_block(
                    cb_body, source, functions, builder, [], parent_id=cb_step.id
                )
            else:
                inner_pending = walk_flow_expr_body(
                    cb_body, source, functions, builder, [], parent_id=cb_step.id
                )
            builder.close_dangling_branches(inner_pending, parent_id=cb_step.id)
        builder.finalize_container(cb_step)
    return current


def declares_only_functions(node: Node, functions: dict[NodeKey, FunctionNode]) -> bool:
    declarators = [c for c in node.named_children if c.type == "variable_declarator"]
    if not declarators:
        return False
    for declarator in declarators:
        value = declarator.child_by_field_name("value")
        if value is None or node_key(value) not in functions:
            return False
    return True


def header_text(node: Node, source: bytes) -> str:
    """Cabecera legible: 'if (x > 0)', 'for (const a of b)', 'case 1', 'catch (e)'."""
    if node.type == "switch_case":
        return "case " + flow_label(node_text(node.child_by_field_name("value"), source))
    if node.type == "switch_default":
        return "default"
    if node.type == "do_statement":
        return "do … while " + flow_label(node_text(node.child_by_field_name("condition"), source))
    body = node.child_by_field_name("body") or node.child_by_field_name("consequence")
    raw = text_between(source, node, body) if body is not None else node_text(node, source)
    cleaned = flow_label(raw).rstrip("{").rstrip(":").strip()
    return re.sub(r"\s+\)", ")", cleaned)


def step_role(node: Node, source: bytes, functions: dict[NodeKey, FunctionNode]) -> str:
    for item in iter_body_nodes(node, functions):
        if item.type in AWAIT_TYPES:
            return ROLE_IO
        if item.type in CALL_TYPES:
            callee_node = item.child_by_field_name("function") or item.child_by_field_name("constructor")
            if is_io_call(normalize_callee(node_text(callee_node, source))):
                return ROLE_IO
    return ROLE_TRANSFORM
