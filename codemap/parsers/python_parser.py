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
    EDGE_CALLBACK_REF,
    EDGE_DIRECT_CALL,
    EDGE_EVENT_LISTENER,
    EDGE_REACTIVE_SUBSCRIBE,
    ENTRY_KIND_EVENT,
    ENTRY_KIND_MAIN,
    ENTRY_KIND_ROUTE,
    ROLE_DECISION,
    ROLE_ENTRY,
    ROLE_IO,
    ROLE_TRANSFORM,
    CallSite,
    FileAnalysis,
    FlowStep,
    FunctionInfo,
    HtmlRef,
    ImportBinding,
)
from codemap.parsers.common import (
    DOCSTRING_MAX_CHARS,
    FLOW_COMPACT_MIN_RUN,
    FLOW_MAX_STEPS,
    FlowGraphBuilder,
    NodeKey,
    PendingExit,
    collect_metrics,
    collapse_whitespace,
    contains_type,
    dedent_code,
    extract_html_path_from_string,
    find_enclosing_key,
    first_capture,
    flow_label,
    format_compacted_step_label,
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
from codemap.roles import (
    classify_callback_container,
    is_io_call,
    is_non_callback_container,
    is_reactive_registrar,
    is_server_call,
    is_static_mount_call,
    looks_like_event_handler_name,
    looks_like_main_entry_name,
)

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
IGNORED_CALLBACK_REFS = frozenset({"True", "False", "None", "self", "cls", "super"})
EVENT_KEYWORD_ARGS = frozenset({"command", "view_func", "handler", "on_click", "on_change", "on_event"})

# Decoradores clasificados por semántica de entrada.
CLI_DECORATOR_PATTERN = re.compile(r"\.(command)\b")
ROUTE_DECORATOR_PATTERN = re.compile(r"\.(route|get|post|put|delete|patch|websocket)\b")
EVENT_DECORATOR_PATTERN = re.compile(
    r"\.(on_event|event|on|callback|listener|handler|task|receiver|subscribe)\b"
)


# ---------------------------------------------------------------------------
# Punto de entrada del módulo
# ---------------------------------------------------------------------------

def parse_python_file(path: str, source: bytes) -> FileAnalysis:
    root = get_parser(LANGUAGE).parse(source).root_node
    analysis = FileAnalysis(path=path, language=LANGUAGE)

    function_nodes = collect_function_nodes(root)
    calls_by_function, module_calls = collect_calls(root, source, function_nodes)

    used_names: set[str] = set()
    qualname_by_key: dict[NodeKey, str] = {}
    for key, node in function_nodes.items():
        info = build_function(node, source, function_nodes, calls_by_function.get(key, []))
        info.qualname = unique_qualname(info.qualname, info.line, used_names)
        qualname_by_key[key] = info.qualname
        analysis.functions.append(info)

    analysis.class_names = collect_class_names(root, source)
    analysis.imports = collect_imports(root, source)
    analysis.module_calls = module_calls
    analysis.html_refs = collect_html_refs(root, source, function_nodes, qualname_by_key)
    analysis.serves_static_dirs = collect_static_dirs(root, source)
    analysis.is_server_file = any(
        is_server_call(c.callee) for c in module_calls if c.is_invocation
    ) or any(
        is_server_call(c.callee)
        for fn in analysis.functions
        for c in fn.calls
        if c.is_invocation
    )
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
        or any(is_io_call(call.callee) for call in calls if call.is_invocation)
    )

    dec_kind, dec_trigger = inspect_entry_decorator(node, source)
    if dec_kind is not None:
        entry_kind_hint = dec_kind
        is_entry_hint = dec_kind == ENTRY_KIND_MAIN
    elif looks_like_main_entry_name(short_name) and class_name is None and container is None:
        entry_kind_hint = ENTRY_KIND_MAIN
        is_entry_hint = True
    elif looks_like_event_handler_name(short_name):
        entry_kind_hint = ENTRY_KIND_EVENT
        is_entry_hint = False
    else:
        entry_kind_hint = None
        is_entry_hint = False

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
        is_entry_hint=is_entry_hint,
        entry_kind_hint=entry_kind_hint,
        event_trigger=dec_trigger,
        fingerprint=compute_fingerprint(
            len(params),
            metrics.node_types,
            [c.callee for c in calls if c.is_invocation],
            short_name,
        ),
    )


def _first_string_literal_in_node(node: Node, source: bytes) -> str:
    stack = [node]
    while stack:
        current = stack.pop()
        if current.type == "string":
            parts = [node_text(c, source) for c in current.named_children if c.type == "string_content"]
            return "".join(parts) if parts else node_text(current, source).strip("\"'")
        stack.extend(reversed(current.named_children))
    return ""


def inspect_entry_decorator(node: Node, source: bytes) -> tuple[str | None, str]:
    """Clasifica decoradores de entrada: CLI (`main`), ruta (`route_handler`) o evento (`event_handler`)."""
    parent = node.parent
    if parent is None or parent.type != "decorated_definition":
        return None, ""
    for child in parent.named_children:
        if child.type != "decorator":
            continue
        text = node_text(child, source)
        trigger = _first_string_literal_in_node(child, source)
        if CLI_DECORATOR_PATTERN.search(text):
            return ENTRY_KIND_MAIN, trigger
        if ROUTE_DECORATOR_PATTERN.search(text):
            return ENTRY_KIND_ROUTE, trigger
        if EVENT_DECORATOR_PATTERN.search(text):
            return ENTRY_KIND_EVENT, trigger
    return None, ""


def has_entry_decorator(node: Node, source: bytes) -> bool:
    """Compatibilidad: True si la función posee un decorador de entrada/ruta/evento."""
    return inspect_entry_decorator(node, source)[0] is not None


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

def _extract_py_string(node: Node, source: bytes) -> str:
    parts = [node_text(c, source) for c in node.named_children if c.type == "string_content"]
    return "".join(parts) if parts else node_text(node, source).strip("\"'")


def _extract_first_string_arg(call_node: Node, source: bytes) -> str:
    args = call_node.child_by_field_name("arguments")
    if args is None or args.named_child_count == 0:
        return ""
    first_arg = args.named_children[0]
    if first_arg.type == "string":
        return _extract_py_string(first_arg, source)
    return ""


def _is_main_guard_if(node: Node, source: bytes) -> bool:
    if node.type != "if_statement":
        return False
    cond = node.child_by_field_name("condition")
    if cond is None or cond.type != "comparison_operator":
        return False
    text = collapse_whitespace(node_text(cond, source))
    return "__name__" in text and "==" in text and ("'__main__'" in text or '"__main__"' in text)


def _top_level_call_flags(call_node: Node, source: bytes) -> tuple[bool, bool]:
    """Devuelve `(is_top_level_stmt, is_main_guard)` para llamadas sin función contenedora."""
    in_main_guard = False
    is_stmt = True
    parent = call_node.parent
    while parent is not None:
        if _is_main_guard_if(parent, source):
            in_main_guard = True
        if parent.type in (
            "decorator",
            "class_definition",
            "default_parameter",
            "typed_default_parameter",
            "assignment",
            "augmented_assignment",
            "pair",
            "list",
            "tuple",
            "dictionary",
            "set",
            "return_statement",
        ):
            is_stmt = False
        if parent.type == "module":
            break
        parent = parent.parent
    return (is_stmt or in_main_guard), in_main_guard


def _has_callback_argument(call_node: Node) -> bool:
    args = call_node.child_by_field_name("arguments")
    if args is None:
        return False
    for arg in args.named_children:
        val = arg.child_by_field_name("value") if arg.type == "keyword_argument" else arg
        if val is not None and val.type in ("lambda", "identifier", "attribute"):
            return True
    return False


def _enclosing_inline_lambda_context(
    call_node: Node,
    owner_key: NodeKey,
    source: bytes,
) -> tuple[str, str, str] | None:
    """Detecta si `call_node` vive dentro de un `lambda` pasado a un registrador de eventos/reactivo."""
    parent = call_node.parent
    while parent is not None and node_key(parent) != owner_key:
        if parent.type == "lambda":
            lam_parent = parent.parent
            if lam_parent is not None and lam_parent.type == "keyword_argument":
                lam_parent = lam_parent.parent
            if lam_parent is not None and lam_parent.type == "argument_list":
                outer_call = lam_parent.parent
                if outer_call is not None and outer_call.type == "call":
                    outer_callee_node = outer_call.child_by_field_name("function")
                    if outer_callee_node is not None:
                        outer_callee = normalize_callee(node_text(outer_callee_node, source))
                        first_str = _extract_first_string_arg(outer_call, source)
                        cb_kind, event_label = classify_callback_container(outer_callee, first_str)
                        if cb_kind in (EDGE_EVENT_LISTENER, EDGE_REACTIVE_SUBSCRIBE):
                            return cb_kind, outer_callee, event_label
        parent = parent.parent
    return None


def collect_calls(
    root: Node,
    source: bytes,
    function_nodes: dict[NodeKey, Node],
) -> tuple[dict[NodeKey, list[CallSite]], list[CallSite]]:
    """Asigna llamadas directas y callbacks por referencia a su función o al nivel de módulo."""
    calls: dict[NodeKey, list[CallSite]] = {}
    module_calls: list[CallSite] = []

    params_by_function: dict[NodeKey, set[str]] = {
        key: set(parameter_names(node.child_by_field_name("parameters"), source))
        for key, node in function_nodes.items()
    }

    for captures in run_matches(LANGUAGE, CALL_QUERY, root):
        call_node = first_capture(captures, "call")
        callee_node = first_capture(captures, "callee")
        if call_node is None or callee_node is None:
            continue
        owner = find_enclosing_key(call_node, function_nodes)
        callee = normalize_callee(node_text(callee_node, source))
        first_str = _extract_first_string_arg(call_node, source)

        is_top_stmt = False
        is_main_guard = False
        if owner is None:
            is_top_stmt, is_main_guard = _top_level_call_flags(call_node, source)

        inline_ctx = (
            _enclosing_inline_lambda_context(call_node, owner, source)
            if owner is not None
            else None
        )
        if inline_ctx is not None:
            call_kind, call_via, call_event = inline_ctx
        elif is_reactive_registrar(callee) and _has_callback_argument(call_node):
            call_kind, call_via, call_event = EDGE_REACTIVE_SUBSCRIBE, "", first_str
        else:
            call_kind, call_via, call_event = EDGE_DIRECT_CALL, "", ""

        direct_site = CallSite(
            callee=callee,
            line=line_of(call_node),
            kind=call_kind,
            is_invocation=True,
            via=call_via,
            event=call_event,
            is_top_level_stmt=is_top_stmt,
            is_main_guard=is_main_guard,
        )
        if owner is None:
            module_calls.append(direct_site)
        else:
            calls.setdefault(owner, []).append(direct_site)

        # Inspeccionar argumentos posicionales y nombrados en busca de callbacks por referencia.
        if is_non_callback_container(callee):
            continue
        args = call_node.child_by_field_name("arguments")
        if args is None:
            continue
        base_ref_kind, ref_event = classify_callback_container(callee, first_str)
        owner_params = params_by_function.get(owner, set()) if owner is not None else set()

        for arg in args.named_children:
            kw_name = ""
            val = arg
            if arg.type == "keyword_argument":
                name_node = arg.child_by_field_name("name")
                val = arg.child_by_field_name("value")
                kw_name = node_text(name_node, source) if name_node is not None else ""
            if val is None or val.type not in ("identifier", "attribute"):
                continue
            ref = normalize_callee(node_text(val, source))
            if not ref or ref in IGNORED_CALLBACK_REFS:
                continue
            if "." not in ref and ref in owner_params:
                continue
            ref_kind = base_ref_kind
            if ref_kind == EDGE_CALLBACK_REF and kw_name in EVENT_KEYWORD_ARGS:
                ref_kind = EDGE_EVENT_LISTENER
            ref_site = CallSite(
                callee=ref,
                line=line_of(val),
                kind=ref_kind,
                is_invocation=False,
                via=callee,
                event=ref_event,
                is_top_level_stmt=is_top_stmt,
                is_main_guard=is_main_guard,
            )
            if owner is None:
                module_calls.append(ref_site)
            else:
                calls.setdefault(owner, []).append(ref_site)

    return calls, module_calls


def collect_html_refs(
    root: Node,
    source: bytes,
    function_nodes: dict[NodeKey, Node],
    qualname_by_key: dict[NodeKey, str],
) -> list[HtmlRef]:
    """Detecta literales de ruta `.html`/`.htm` (p. ej. `FileResponse(... / 'index.html')`)."""
    refs: list[HtmlRef] = []
    seen: set[tuple[str | None, str]] = set()
    stack = [root]
    while stack:
        node = stack.pop()
        if node.type == "string":
            html_path = extract_html_path_from_string(_extract_py_string(node, source))
            if html_path is not None:
                owner = find_enclosing_key(node, function_nodes)
                owner_qn = qualname_by_key.get(owner) if owner is not None else None
                key = (owner_qn, html_path)
                if key not in seen:
                    seen.add(key)
                    refs.append(HtmlRef(target=html_path, line=line_of(node), owner_qualname=owner_qn))
            continue
        stack.extend(reversed(node.named_children))
    return refs


def collect_static_dirs(root: Node, source: bytes) -> list[str]:
    """Detecta directorios estáticos montados (`add_static`, `StaticFiles`, `send_from_directory`)."""
    dirs: list[str] = []
    for captures in run_matches(LANGUAGE, CALL_QUERY, root):
        call_node = first_capture(captures, "call")
        callee_node = first_capture(captures, "callee")
        if call_node is None or callee_node is None:
            continue
        callee = normalize_callee(node_text(callee_node, source))
        if not is_static_mount_call(callee):
            continue
        args = call_node.child_by_field_name("arguments")
        if args is None:
            continue
        found_str = False
        stack = list(reversed(args.named_children))
        while stack:
            item = stack.pop()
            if item.type == "string":
                val = _extract_py_string(item, source).strip()
                if val and val != "/" and val not in dirs:
                    dirs.append(val)
                    found_str = True
            else:
                stack.extend(reversed(item.named_children))
        if not found_str and "." not in dirs:
            dirs.append(".")
    return dirs


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
    *,
    hook_label: str = "",
    hook_code: str = "",
) -> list[FlowStep]:
    """Construye el grafo intra-función con sub-contenedores, ramas Sí/No y try/except."""
    builder = FlowGraphBuilder(FLOW_MAX_STEPS)
    pending: list[PendingExit] = []
    if hook_label:
        _, pending = builder.emit_sequential(
            pending,
            ROLE_ENTRY,
            flow_label(hook_label),
            code=hook_code or hook_label,
            kind="event",
        )
    param_summary = ", ".join(params) or "∅"
    _, pending = builder.emit_sequential(
        pending, ROLE_ENTRY, f"in: {param_summary}", code=f"({param_summary})"
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


def _extract_py_assignment_target(stmt: Node, source: bytes) -> str:
    expr = stmt.named_children[0] if stmt.type == "expression_statement" and stmt.named_child_count else stmt
    if expr.type in FLOW_ASSIGNMENT_TYPES:
        left = expr.child_by_field_name("left")
        if left is not None:
            return collapse_whitespace(node_text(left, source))
    return ""


def _classify_compactable_py_stmt(
    stmt: Node,
    source: bytes,
    function_nodes: dict[NodeKey, Node],
) -> str | None:
    """Devuelve el nombre asignado si `stmt` es una asignación simple sin ramas, I/O ni llamadas."""
    if node_key(stmt) in function_nodes or stmt.type in FLOW_SKIP_TYPES:
        return None
    if stmt.type in ("block", "try_statement", "with_statement") or stmt.type in FLOW_LOOP_TYPES:
        return None
    if stmt.type in FLOW_DECISION_TYPES or stmt.type in FLOW_JUMP_TYPES:
        return None
    if collect_inline_lambdas(stmt, function_nodes):
        return None
    if contains_type(stmt, CALL_TYPES | AWAIT_TYPES, function_nodes):
        return None
    if not contains_type(stmt, FLOW_ASSIGNMENT_TYPES, function_nodes):
        return None
    if step_role(stmt, source, function_nodes) == ROLE_IO:
        return None
    return _extract_py_assignment_target(stmt, source)


def _flush_py_compact_buffer(
    buffer: list[tuple[Node, str]],
    source: bytes,
    function_nodes: dict[NodeKey, Node],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None,
) -> list[PendingExit]:
    if not buffer:
        return pending
    if len(buffer) < FLOW_COMPACT_MIN_RUN:
        current = pending
        for stmt, _ in buffer:
            current = walk_flow_statement(stmt, source, function_nodes, builder, current, parent_id)
        buffer.clear()
        return current

    names = [name for _, name in buffer]
    label = format_compacted_step_label("asignaciones", names, len(buffer))
    code = "\n".join(dedent_code(node_text(stmt, source)) for stmt, _ in buffer)
    _, next_pending = builder.emit_sequential(
        pending,
        ROLE_TRANSFORM,
        label,
        code=code,
        parent_id=parent_id,
    )
    buffer.clear()
    return next_pending


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
    compact_buffer: list[tuple[Node, str]] = []

    for statement in block.named_children:
        if _is_docstring_statement(statement) or statement.type == "comment":
            continue
        compact_target = _classify_compactable_py_stmt(statement, source, function_nodes)
        if compact_target is not None:
            compact_buffer.append((statement, compact_target))
            continue
        current = _flush_py_compact_buffer(
            compact_buffer, source, function_nodes, builder, current, parent_id
        )
        current = walk_flow_statement(statement, source, function_nodes, builder, current, parent_id)

    current = _flush_py_compact_buffer(
        compact_buffer, source, function_nodes, builder, current, parent_id
    )
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
        first_str = _extract_first_string_arg(call_node, source)
        cb_kind, event_label = classify_callback_container(callee_name, first_str)
        is_event_cb = cb_kind in (EDGE_EVENT_LISTENER, EDGE_REACTIVE_SUBSCRIBE)

        lam_params = parameter_names(lambda_node.child_by_field_name("parameters"), source)

        if is_event_cb:
            params_suffix = f"({', '.join(lam_params)})" if lam_params else ""
            target_part = callee_name.rsplit(".", 1)[0] if "." in callee_name else callee_name
            if event_label and target_part:
                header_label = flow_label(f"⚡ {event_label} · {target_part}{params_suffix}")
            else:
                header_label = flow_label(f"⚡ {callee_name}{params_suffix}")
            step_kind = "event"
        else:
            params_label = ", ".join(lam_params) or "∅"
            lead = ""
            if idx == 0 and stmt is not call_node:
                raw_lead = collapse_whitespace(text_between(source, stmt, call_node))
                if raw_lead and len(raw_lead) <= 40:
                    lead = f"{raw_lead} "
            header_label = flow_label(f"🔁 {lead}{callee_name}({params_label})")
            step_kind = "loop"

        code_node = stmt if (idx == 0 and len(lambdas) == 1) else call_node
        lam_step, current = builder.emit_sequential(
            current,
            step_role(callee_node or call_node, source, function_nodes),
            header_label,
            code=dedent_code(node_text(code_node, source)),
            parent_id=parent_id,
            is_container=True,
            kind=step_kind,
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
    return flow_label(collapse_whitespace(raw).rstrip(":").rstrip())


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
