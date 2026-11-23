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
    end_line_of,
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
    is_boot_event_name,
    is_event_registrar,
    is_io_call,
    is_non_callback_container,
    is_reactive_registrar,
    is_route_registrar,
    is_server_call,
    is_startup_hook_call,
    is_static_mount_call,
    looks_like_event_handler_name,
    looks_like_main_entry_name,
)

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
IGNORED_CALLBACK_REFS = frozenset(
    {"true", "false", "null", "undefined", "this", "super", "arguments", "NaN", "Infinity"}
)
JSX_EVENT_PROP_PATTERN = re.compile(r"^on[A-Z]")
JS_TRIVIAL_DOM_LOOKUP_METHODS = frozenset(
    {
        "getElementById",
        "querySelector",
        "querySelectorAll",
        "getElementsByClassName",
        "getElementsByTagName",
        "createElement",
        "createTextNode",
        "setAttribute",
        "removeAttribute",
    }
)
JS_CLASSLIST_METHODS = frozenset({"add", "remove", "toggle", "replace"})
_JS_FILE_DOC_TAG_RE = re.compile(r"@(?:file|fileoverview|overview|module)\b", re.IGNORECASE)
_JS_FILE_TAG_STRIP_RE = re.compile(r"^@(?:fileoverview|file|overview)\b[:\s-]*", re.IGNORECASE)
_JS_PRAGMA_BLOCK_RE = re.compile(
    r"^/\*+\s*(?:eslint|jshint|jslint|global|exported|istanbul|c8|v8|@ts-|@jsx|prettier-ignore|biome-ignore)\b",
    re.IGNORECASE,
)
_JS_PRAGMA_LINE_RE = re.compile(
    r"^//\s*(?:@ts-|eslint-|jshint|prettier-ignore|biome-ignore)",
    re.IGNORECASE,
)


@dataclass
class FunctionNode:
    """Función candidata antes de convertirse en FunctionInfo."""

    node: Node                    # nodo con parámetros y cuerpo
    name: str                     # nombre propio o derivado del contexto
    anchor: Node                  # inicio de la firma
    is_callback: bool             # callback de nivel de módulo (manejador)
    callback_kind: str | None = None  # "main" | "route_handler" | "event_handler" | None
    callback_event: str = ""
    callback_via: str = ""
    callback_hook_label: str = ""
    callback_hook_code: str = ""
    callback_hook_line: int = 0
    callback_hook_end_line: int = 0


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
    file_docstring, file_doc_key = extract_file_docstring(root, source, function_nodes)
    analysis.docstring = file_docstring

    calls_by_function, module_calls = collect_calls(root, source, language, function_nodes)

    used_names: set[str] = set()
    qualname_by_key: dict[NodeKey, str] = {}
    for key, candidate in function_nodes.items():
        info = build_function(
            candidate,
            source,
            function_nodes,
            calls_by_function.get(key, []),
            file_doc_key=file_doc_key,
        )
        info.qualname = unique_qualname(info.qualname, info.line, used_names)
        qualname_by_key[key] = info.qualname
        analysis.functions.append(info)

    analysis.class_names = collect_class_names(root, source, language, function_nodes)
    analysis.imports = collect_imports(root, source, language)
    analysis.default_export = default_name
    analysis.module_calls = module_calls
    analysis.html_refs = collect_html_refs(root, source, function_nodes, qualname_by_key)
    analysis.serves_static_dirs = collect_static_dirs(root, source, language)
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


def _extract_first_string_arg(call: Node, source: bytes) -> str:
    arguments = call.child_by_field_name("arguments")
    if arguments is None or arguments.named_child_count == 0:
        return ""
    first_arg = arguments.named_children[0]
    if first_arg.type == "string":
        return node_text(first_arg, source).strip("'\"`")
    if first_arg.type == "template_string" and not any(
        c.type == "template_substitution" for c in first_arg.named_children
    ):
        return node_text(first_arg, source).strip("`")
    return ""


def _extract_short_non_fn_args(
    call: Node,
    source: bytes,
    *,
    max_args: int = 2,
    max_arg_chars: int = 20,
    include_strings: bool = False,
) -> list[str]:
    """Extrae argumentos cortos no-función que aportan contexto (ej. PORT, 3000, config.port)."""
    arguments = call.child_by_field_name("arguments")
    if arguments is None:
        return []
    extracted: list[str] = []
    for arg in arguments.named_children:
        if arg.type in FUNCTION_VALUE_TYPES:
            continue
        raw = ""
        if arg.type in ("identifier", "number"):
            raw = node_text(arg, source).strip()
        elif arg.type == "member_expression":
            raw = normalize_callee(node_text(arg, source))
        elif include_strings and arg.type == "string":
            raw = collapse_whitespace(node_text(arg, source))
        elif include_strings and arg.type == "template_string" and not any(
            c.type == "template_substitution" for c in arg.named_children
        ):
            raw = collapse_whitespace(node_text(arg, source))
        if not raw or raw in IGNORED_CALLBACK_REFS or len(raw) > max_arg_chars:
            continue
        extracted.append(raw)
        if len(extracted) >= max_args:
            break
    return extracted


def _format_callback_hook(call: Node, callee: Node, callback: Node, source: bytes) -> tuple[str, str]:
    """Construye la etiqueta y código del paso disparador `⚡ Hook: ...` para callbacks de módulo."""
    ctx = normalize_callee(node_text(callee, source))
    arguments = call.child_by_field_name("arguments")
    arg_parts: list[str] = []
    cb_key = node_key(callback)
    if arguments is not None:
        for arg in arguments.named_children:
            if node_key(arg) == cb_key:
                arg_parts.append("<callback>")
            elif arg.type in FUNCTION_VALUE_TYPES:
                arg_parts.append("<fn>")
            else:
                text = collapse_whitespace(node_text(arg, source))
                if len(text) > 24:
                    text = text[:23].rstrip() + "…"
                arg_parts.append(text)
    call_sig = f"{ctx}({', '.join(arg_parts)})"
    label = flow_label(f"⚡ Hook: {call_sig}")
    return label, call_sig


def collect_module_callbacks(
    root: Node, source: bytes, language: str, functions: dict[NodeKey, FunctionNode]
) -> None:
    """Registra callbacks anónimos de nivel de módulo, nombrados por contexto y línea:
    app.get('/users', (req, res) => ...)  ->  "app.get[/users]@L12"
    server.listen(PORT, () => ...)        ->  "server.listen(PORT)@L94".
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
        outer_callee = normalize_callee(node_text(callee, source))
        first_str = _extract_first_string_arg(call, source)
        cb_kind: str | None = None
        cb_event = first_str
        if is_boot_event_name(first_str) or is_startup_hook_call(outer_callee):
            cb_kind = ENTRY_KIND_MAIN
        elif is_route_registrar(outer_callee, first_str):
            cb_kind = ENTRY_KIND_ROUTE
            if not cb_event and outer_callee.rsplit(".", 1)[-1] == "createServer":
                cb_event = "http:request"
        elif is_event_registrar(outer_callee, first_str) or is_reactive_registrar(outer_callee):
            cb_kind = ENTRY_KIND_EVENT
        name = callback_name(call, callee, callback, source)
        hook_label, hook_code = _format_callback_hook(call, callee, callback, source)
        functions[node_key(callback)] = FunctionNode(
            callback,
            name,
            callback,
            is_callback=True,
            callback_kind=cb_kind,
            callback_event=cb_event,
            callback_via=outer_callee,
            callback_hook_label=hook_label,
            callback_hook_code=hook_code,
            callback_hook_line=line_of(call),
            callback_hook_end_line=max(line_of(call), line_of(callback)),
        )


def callback_name(call: Node, callee: Node, callback: Node, source: bytes) -> str:
    context = normalize_callee(node_text(callee, source))
    route = _extract_first_string_arg(call, source)
    if route:
        context += f"[{route}]"
    else:
        short_args = _extract_short_non_fn_args(call, source, max_args=2, max_arg_chars=18)
        if short_args:
            joined = ", ".join(short_args)
            if len(joined) > 24:
                joined = short_args[0]
            context += f"({joined})"
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
    *,
    file_doc_key: NodeKey | None = None,
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
        or any(is_io_call(call.callee) for call in calls if call.is_invocation)
    )

    if candidate.callback_kind is not None:
        entry_kind_hint = candidate.callback_kind
        is_entry_hint = candidate.callback_kind == ENTRY_KIND_MAIN
    elif looks_like_main_entry_name(candidate.name) and class_name is None and container is None:
        entry_kind_hint = ENTRY_KIND_MAIN
        is_entry_hint = True
    elif looks_like_event_handler_name(candidate.name):
        entry_kind_hint = ENTRY_KIND_EVENT
        is_entry_hint = False
    else:
        entry_kind_hint = None
        is_entry_hint = False

    fn_line = line_of(node)
    fn_end_line = end_line_of(node)
    header_end = end_line_of(params_node) if params_node is not None else fn_line

    return FunctionInfo(
        qualname=".".join(scope_names + [candidate.name]),
        short_name=candidate.name,
        class_name=class_name,
        container=container,
        line=fn_line,
        end_line=fn_end_line,
        signature=signature_text(source, candidate.anchor, body),
        docstring=extract_jsdoc(candidate.anchor, source, file_doc_key=file_doc_key),
        param_count=len(params),
        calls=calls,
        internal_flow=build_flow(
            params,
            body,
            source,
            functions,
            hook_label=candidate.callback_hook_label if candidate.is_callback else "",
            hook_code=candidate.callback_hook_code if candidate.is_callback else "",
            hook_line=candidate.callback_hook_line if candidate.is_callback else 0,
            hook_end_line=candidate.callback_hook_end_line if candidate.is_callback else 0,
            entry_line=fn_line,
            entry_end_line=header_end,
        ),
        branch_count=metrics.branch_count,
        return_count=metrics.return_count,
        has_io=has_io,
        is_entry_hint=is_entry_hint,
        entry_kind_hint=entry_kind_hint,
        event_trigger=candidate.callback_event,
        callback_via=candidate.callback_via,
        fingerprint=compute_fingerprint(
            len(params),
            metrics.node_types,
            [c.callee for c in calls if c.is_invocation],
            candidate.name,
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


def _node_declares_function_or_class(node: Node, function_nodes: dict[NodeKey, FunctionNode]) -> bool:
    """True si la sentencia declara una función/clase a la que pertenecería un JSDoc contiguo."""
    if node.type in ("function_declaration", "generator_function_declaration") or node.type in CLASS_TYPES:
        return True
    if node.type in ("export_statement", "lexical_declaration", "variable_declaration"):
        start_b, end_b = node.start_byte, node.end_byte
        for fn_start, fn_end in function_nodes:
            if start_b <= fn_start and fn_end <= end_b:
                return True
        for child in node.named_children:
            if child.type in CLASS_TYPES or child.type in ("function_declaration", "generator_function_declaration"):
                return True
    return False


def extract_file_docstring(
    root: Node | None,
    source: bytes,
    function_nodes: dict[NodeKey, FunctionNode],
) -> tuple[str, NodeKey | None]:
    """Extrae el docstring/comentario JSDoc o de cabecera de un archivo JS/TS sin robar JSDoc de funciones."""
    if root is None or root.named_child_count == 0:
        return "", None

    candidate: Node | None = None
    for child in root.named_children:
        if child.type == "hash_bang_line":
            continue
        if child.type == "comment":
            raw = node_text(child, source).strip()
            if raw.startswith("//"):
                if _JS_PRAGMA_LINE_RE.match(raw):
                    continue
                return "", None
            if raw.startswith("/*") and raw.endswith("*/"):
                if _JS_PRAGMA_BLOCK_RE.match(raw):
                    continue
                candidate = child
                break
            return "", None
        break

    if candidate is None:
        return "", None

    raw = node_text(candidate, source).strip()
    has_file_tag = bool(_JS_FILE_DOC_TAG_RE.search(raw))
    next_sib = candidate.next_named_sibling

    if not has_file_tag and next_sib is not None:
        line_gap = next_sib.start_point[0] - candidate.end_point[0]
        if line_gap < 2 and _node_declares_function_or_class(next_sib, function_nodes):
            return "", None

    inner = raw[3:-2] if raw.startswith("/**") else raw[2:-2]
    cleaned_lines: list[str] = []
    for line in inner.splitlines():
        text = line.strip().lstrip("*").strip()
        text = _JS_FILE_TAG_STRIP_RE.sub("", text).strip()
        if text:
            cleaned_lines.append(text)
    docstring = "\n".join(cleaned_lines).strip()[:DOCSTRING_MAX_CHARS]
    if not docstring:
        return "", None
    return docstring, node_key(candidate)


def extract_jsdoc(anchor: Node, source: bytes, *, file_doc_key: NodeKey | None = None) -> str:
    """Comentario /** ... */ inmediatamente anterior a la declaración."""
    target = anchor
    while target.parent is not None and target.parent.type in (
        "lexical_declaration", "variable_declaration", "export_statement"
    ):
        target = target.parent
    previous = target.prev_named_sibling
    if previous is None or previous.type != "comment":
        return ""
    if file_doc_key is not None and node_key(previous) == file_doc_key:
        return ""
    raw = node_text(previous, source)
    if not raw.startswith("/**"):
        return ""
    lines = [line.strip().lstrip("*").strip() for line in raw[3:-2].splitlines()]
    return "\n".join(line for line in lines if line).strip()[:DOCSTRING_MAX_CHARS]


# ---------------------------------------------------------------------------
# Llamadas e imports
# ---------------------------------------------------------------------------

def _extract_callback_target(arg: Node, source: bytes) -> tuple[Node, str] | None:
    """Extrae el nodo y callee normalizado si `arg` referencia una función/método
    (identificador, acceso a miembro o `fn.bind(...)`)."""
    target: Node | None = None
    if arg.type in ("identifier", "member_expression"):
        target = arg
    elif arg.type == "call_expression":
        fn_node = arg.child_by_field_name("function")
        if fn_node is not None and fn_node.type == "member_expression":
            prop = fn_node.child_by_field_name("property")
            obj = fn_node.child_by_field_name("object")
            if (
                prop is not None
                and node_text(prop, source) == "bind"
                and obj is not None
                and obj.type in ("identifier", "member_expression")
            ):
                target = obj
    if target is None:
        return None
    ref = normalize_callee(node_text(target, source))
    if not ref or ref in IGNORED_CALLEES or ref in IGNORED_CALLBACK_REFS:
        return None
    return target, ref


def _has_callback_argument(call_node: Node) -> bool:
    arguments = call_node.child_by_field_name("arguments")
    if arguments is None:
        return False
    for arg in arguments.named_children:
        if arg.type in FUNCTION_VALUE_TYPES or arg.type in ("identifier", "member_expression"):
            return True
        if arg.type == "call_expression":
            fn_node = arg.child_by_field_name("function")
            if fn_node is not None and fn_node.type == "member_expression":
                return True
    return False


def _is_top_level_statement_call(call_node: Node) -> bool:
    """True si la llamada top-level se ejecuta como sentencia de arranque (no inicializador const/let)."""
    parent = call_node.parent
    while parent is not None:
        if parent.type in (
            "variable_declarator",
            "assignment_expression",
            "pair",
            "array",
            "object",
            "return_statement",
        ):
            return False
        if parent.type == "program":
            return True
        parent = parent.parent
    return False


def _enclosing_inline_callback_context(
    call_node: Node,
    owner_key: NodeKey,
    functions: dict[NodeKey, FunctionNode],
    source: bytes,
) -> tuple[str, str, str] | None:
    """Detecta si `call_node` vive dentro de un callback anónimo inline pasado a
    un registrador de eventos, suscripción reactiva o prop JSX `onX={...}`."""
    parent = call_node.parent
    while parent is not None and node_key(parent) != owner_key:
        if parent.type in FUNCTION_VALUE_TYPES and node_key(parent) not in functions:
            cb_parent = parent.parent
            if cb_parent is not None and cb_parent.type == "arguments":
                outer_call = cb_parent.parent
                if outer_call is not None and outer_call.type == "call_expression":
                    outer_callee_node = outer_call.child_by_field_name("function")
                    if outer_callee_node is not None:
                        outer_callee = normalize_callee(node_text(outer_callee_node, source))
                        first_str = _extract_first_string_arg(outer_call, source)
                        cb_kind, event_label = classify_callback_container(outer_callee, first_str)
                        if cb_kind in (EDGE_EVENT_LISTENER, EDGE_REACTIVE_SUBSCRIBE):
                            return cb_kind, outer_callee, event_label
            elif cb_parent is not None and cb_parent.type == "jsx_expression":
                attr_node = cb_parent.parent
                if attr_node is not None and attr_node.type == "jsx_attribute":
                    prop = attr_node.named_children[0] if attr_node.named_child_count else None
                    prop_name = node_text(prop, source) if prop is not None else ""
                    if JSX_EVENT_PROP_PATTERN.match(prop_name):
                        return EDGE_EVENT_LISTENER, f"jsx.{prop_name}", prop_name[2:].lower()
        parent = parent.parent
    return None


def _collect_jsx_event_refs(
    root: Node,
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
    params_by_function: dict[NodeKey, set[str]],
    calls: dict[NodeKey, list[CallSite]],
    module_calls: list[CallSite],
) -> None:
    """Extrae handlers pasados por referencia en props JSX (`onClick={handleClick}`)."""
    stack = [root]
    while stack:
        node = stack.pop()
        if node.type == "jsx_attribute" and node.named_child_count >= 2:
            prop_node = node.named_children[0]
            val_node = node.named_children[1]
            prop_name = node_text(prop_node, source)
            if JSX_EVENT_PROP_PATTERN.match(prop_name) and val_node.type == "jsx_expression":
                expr = val_node.named_children[0] if val_node.named_child_count else None
                if expr is not None:
                    extracted = _extract_callback_target(expr, source)
                    if extracted is not None:
                        target_node, ref = extracted
                        owner = find_enclosing_key(node, functions)
                        owner_params = params_by_function.get(owner, set()) if owner is not None else set()
                        if "." in ref or ref not in owner_params:
                            site = CallSite(
                                callee=ref,
                                line=line_of(target_node),
                                kind=EDGE_EVENT_LISTENER,
                                is_invocation=False,
                                via=f"jsx.{prop_name}",
                                event=prop_name[2:].lower(),
                            )
                            if owner is None:
                                module_calls.append(site)
                            else:
                                calls.setdefault(owner, []).append(site)
        stack.extend(reversed(node.named_children))


def collect_calls(
    root: Node, source: bytes, language: str, functions: dict[NodeKey, FunctionNode]
) -> tuple[dict[NodeKey, list[CallSite]], list[CallSite]]:
    """Recopila invocaciones directas, callbacks pasados por referencia y llamadas top-level."""
    calls: dict[NodeKey, list[CallSite]] = {}
    module_calls: list[CallSite] = []

    params_by_function: dict[NodeKey, set[str]] = {}
    for key, candidate in functions.items():
        p_node = candidate.node.child_by_field_name("parameters") or candidate.node.child_by_field_name("parameter")
        params_by_function[key] = set(parameter_names(p_node, source))

    for captures in run_matches(language, CALL_QUERY, root):
        call_node = first_capture(captures, "call")
        callee_node = first_capture(captures, "callee")
        if call_node is None or callee_node is None:
            continue
        callee = normalize_callee(node_text(callee_node, source))
        if callee in IGNORED_CALLEES:
            continue
        owner = find_enclosing_key(call_node, functions)
        is_top_stmt = owner is None and _is_top_level_statement_call(call_node)
        first_str = _extract_first_string_arg(call_node, source)

        inline_ctx = (
            _enclosing_inline_callback_context(call_node, owner, functions, source)
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
        )
        if owner is None:
            module_calls.append(direct_site)
        else:
            calls.setdefault(owner, []).append(direct_site)

        # Inspeccionar argumentos en busca de funciones pasadas por referencia (sin paréntesis).
        if is_non_callback_container(callee) or callee.endswith(".bind"):
            continue
        arguments = call_node.child_by_field_name("arguments")
        if arguments is None:
            continue
        ref_kind, ref_event = classify_callback_container(callee, first_str)
        owner_params = params_by_function.get(owner, set()) if owner is not None else set()

        for arg in arguments.named_children:
            extracted = _extract_callback_target(arg, source)
            if extracted is None:
                continue
            target_node, ref = extracted
            if "." not in ref and ref in owner_params:
                continue
            ref_site = CallSite(
                callee=ref,
                line=line_of(target_node),
                kind=ref_kind,
                is_invocation=False,
                via=callee,
                event=ref_event,
                is_top_level_stmt=is_top_stmt,
            )
            if owner is None:
                module_calls.append(ref_site)
            else:
                calls.setdefault(owner, []).append(ref_site)

    if language in ("javascript", "tsx"):
        _collect_jsx_event_refs(root, source, functions, params_by_function, calls, module_calls)

    return calls, module_calls


def collect_html_refs(
    root: Node,
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
    qualname_by_key: dict[NodeKey, str],
) -> list[HtmlRef]:
    """Detecta referencias literales a archivos `.html`/`.htm` (p. ej. `sendFile('index.html')`)."""
    refs: list[HtmlRef] = []
    seen: set[tuple[str | None, str]] = set()
    stack = [root]
    while stack:
        node = stack.pop()
        if node.type in ("string", "template_string"):
            if node.type == "template_string" and any(
                c.type == "template_substitution" for c in node.named_children
            ):
                continue
            html_path = extract_html_path_from_string(node_text(node, source))
            if html_path is not None:
                owner = find_enclosing_key(node, functions)
                owner_qn = qualname_by_key.get(owner) if owner is not None else None
                key = (owner_qn, html_path)
                if key not in seen:
                    seen.add(key)
                    refs.append(HtmlRef(target=html_path, line=line_of(node), owner_qualname=owner_qn))
            continue
        stack.extend(reversed(node.named_children))
    return refs


def collect_static_dirs(root: Node, source: bytes, language: str) -> list[str]:
    """Extrae directorios estáticos montados por servidores (`express.static('public')`)."""
    dirs: list[str] = []
    for captures in run_matches(language, CALL_QUERY, root):
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
                val = node_text(item, source).strip("'\"`").strip()
                if val and val not in dirs:
                    dirs.append(val)
                    found_str = True
            else:
                stack.extend(reversed(item.named_children))
        if not found_str and "." not in dirs:
            dirs.append(".")
    return dirs


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
    *,
    hook_label: str = "",
    hook_code: str = "",
    hook_line: int = 0,
    hook_end_line: int = 0,
    entry_line: int = 0,
    entry_end_line: int = 0,
) -> list[FlowStep]:
    builder = FlowGraphBuilder(FLOW_MAX_STEPS)
    pending: list[PendingExit] = []
    if hook_label:
        _, pending = builder.emit_sequential(
            pending,
            ROLE_ENTRY,
            flow_label(hook_label),
            code=hook_code or hook_label,
            kind="event",
            line=hook_line,
            end_line=hook_end_line,
        )
    param_summary = ", ".join(params) or "∅"
    _, pending = builder.emit_sequential(
        pending,
        ROLE_ENTRY,
        f"in: {param_summary}",
        code=f"({param_summary})",
        line=entry_line,
        end_line=entry_end_line,
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
        line=line_of(body),
        end_line=end_line_of(body),
    )
    return next_pending


def _is_trivial_dom_call(call_node: Node, source: bytes) -> bool:
    """True si la llamada es una consulta/operación DOM simple (sin lógica interna)."""
    callee_node = call_node.child_by_field_name("function") or call_node.child_by_field_name("constructor")
    if callee_node is None:
        return False
    callee = normalize_callee(node_text(callee_node, source))
    if "." not in callee:
        return False
    obj, _, member = callee.rpartition(".")
    if member in JS_TRIVIAL_DOM_LOOKUP_METHODS:
        return True
    if (obj == "classList" or obj.endswith(".classList")) and member in JS_CLASSLIST_METHODS:
        return True
    return False


def _extract_js_stmt_target_name(stmt: Node, source: bytes) -> str:
    if stmt.type in FLOW_DECLARATION_TYPES:
        for child in stmt.named_children:
            if child.type == "variable_declarator":
                name_node = child.child_by_field_name("name")
                if name_node is not None:
                    return collapse_whitespace(node_text(name_node, source))
    if stmt.type == "expression_statement" and stmt.named_child_count > 0:
        expr = stmt.named_children[0]
        if expr.type in ("assignment_expression", "augmented_assignment_expression"):
            left = expr.child_by_field_name("left")
            if left is not None:
                return collapse_whitespace(node_text(left, source))
        if expr.type == "update_expression":
            arg = expr.child_by_field_name("argument")
            if arg is not None:
                return collapse_whitespace(node_text(arg, source))
        if expr.type == "call_expression":
            fn = expr.child_by_field_name("function")
            if fn is not None and fn.type == "member_expression":
                obj = fn.child_by_field_name("object")
                if obj is not None:
                    return collapse_whitespace(node_text(obj, source)).split(".")[0]
    return ""


def _classify_compactable_js_stmt(
    stmt: Node,
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
) -> tuple[str, str] | None:
    """Si `stmt` es una declaración/asignación simple sin ramas ni llamadas internas,
    devuelve `(categoría, nombre_objetivo)`; en caso contrario `None`."""
    if node_key(stmt) in functions or stmt.type in ("comment", "empty_statement", "statement_block"):
        return None
    if stmt.type in FLOW_LOOP_TYPES or stmt.type in FLOW_DECISION_TYPES or stmt.type in FLOW_JUMP_TYPES:
        return None
    if stmt.type == "try_statement":
        return None
    if stmt.type in FLOW_DECLARATION_TYPES and declares_only_functions(stmt, functions):
        return None
    if collect_inline_callbacks(stmt, functions):
        return None
    if step_role(stmt, source, functions) == ROLE_IO:
        return None

    is_decl = stmt.type in FLOW_DECLARATION_TYPES
    is_expr_stmt = stmt.type == "expression_statement"
    if not is_decl and not is_expr_stmt:
        return None

    call_nodes = [item for item in iter_body_nodes(stmt, functions) if item.type in CALL_TYPES]
    if not call_nodes:
        if is_decl:
            return ("declaraciones", _extract_js_stmt_target_name(stmt, source))
        if contains_type(stmt, FLOW_ASSIGNMENT_TYPES, functions):
            return ("asignaciones", _extract_js_stmt_target_name(stmt, source))
        return None

    if all(_is_trivial_dom_call(call_node, source) for call_node in call_nodes):
        cat = "declaraciones DOM" if is_decl else "operaciones DOM"
        return (cat, _extract_js_stmt_target_name(stmt, source))
    return None


def _flush_js_compact_buffer(
    buffer: list[tuple[Node, str, str]],
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None,
) -> list[PendingExit]:
    if not buffer:
        return pending
    if len(buffer) < FLOW_COMPACT_MIN_RUN:
        current = pending
        for stmt, _, _ in buffer:
            current = walk_flow_statement(stmt, source, functions, builder, current, parent_id)
        buffer.clear()
        return current

    categories = [cat for _, cat, _ in buffer]
    names = [name for _, _, name in buffer]
    dom_decl_count = sum(1 for c in categories if c == "declaraciones DOM")
    dom_op_count = sum(1 for c in categories if c == "operaciones DOM")
    if dom_decl_count + dom_op_count > 0:
        category = "declaraciones DOM" if dom_decl_count >= dom_op_count else "operaciones DOM"
    elif all(c == "declaraciones" for c in categories):
        category = "declaraciones"
    else:
        category = "asignaciones"

    label = format_compacted_step_label(category, names, len(buffer))
    code = "\n".join(dedent_code(node_text(stmt, source)) for stmt, _, _ in buffer)
    _, next_pending = builder.emit_sequential(
        pending,
        ROLE_TRANSFORM,
        label,
        code=code,
        parent_id=parent_id,
        line=line_of(buffer[0][0]),
        end_line=end_line_of(buffer[-1][0]),
    )
    buffer.clear()
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
    compact_buffer: list[tuple[Node, str, str]] = []

    for statement in block.named_children:
        if statement.type in ("comment", "empty_statement"):
            continue
        compactable = _classify_compactable_js_stmt(statement, source, functions)
        if compactable is not None:
            if compact_buffer:
                prev_is_dom = "DOM" in compact_buffer[-1][1]
                cur_is_dom = "DOM" in compactable[0]
                if prev_is_dom != cur_is_dom:
                    current = _flush_js_compact_buffer(
                        compact_buffer, source, functions, builder, current, parent_id
                    )
            compact_buffer.append((statement, compactable[0], compactable[1]))
            continue
        current = _flush_js_compact_buffer(
            compact_buffer, source, functions, builder, current, parent_id
        )
        current = walk_flow_statement(statement, source, functions, builder, current, parent_id)

    current = _flush_js_compact_buffer(
        compact_buffer, source, functions, builder, current, parent_id
    )
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
        line=line_of(node),
        end_line=end_line_of(node),
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
        line=line_of(node),
        end_line=end_line_of(node),
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
    if_cond = node.child_by_field_name("condition")
    if_line = line_of(node)
    if_step, _ = builder.emit_sequential(
        pending,
        ROLE_DECISION,
        header_text(node, source),
        code=dedent_code(node_text(node, source)),
        parent_id=parent_id,
        line=if_line,
        end_line=end_line_of(if_cond) if if_cond is not None else if_line,
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
    sw_val = node.child_by_field_name("value")
    sw_line = line_of(node)
    sw_step, _ = builder.emit_sequential(
        pending,
        ROLE_DECISION,
        header_text(node, source),
        code=dedent_code(node_text(node, source)),
        parent_id=parent_id,
        line=sw_line,
        end_line=end_line_of(sw_val) if sw_val is not None else sw_line,
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
            line=line_of(node),
            end_line=end_line_of(try_body) if try_body is not None else line_of(node),
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
                line=line_of(handler),
                end_line=end_line_of(handler),
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


def _extract_dom_or_receiver_target(call_node: Node, source: bytes) -> str:
    """Extrae un objetivo legible del receptor de un listener/evento.

    Ejemplos:
      - `document.getElementById('viewGalleryBtn')?.addEventListener(...)` -> `#viewGalleryBtn`
      - `document.querySelector('.filter-btn')?.addEventListener(...)`     -> `.filter-btn`
      - `dropZone.addEventListener(...)`                                   -> `dropZone`
    """
    callee = call_node.child_by_field_name("function")
    if callee is None or callee.type != "member_expression":
        return ""
    obj = callee.child_by_field_name("object")
    if obj is None:
        return ""
    if obj.type == "call_expression":
        inner_fn = obj.child_by_field_name("function")
        inner_name = normalize_callee(node_text(inner_fn, source)) if inner_fn is not None else ""
        tail = inner_name.rsplit(".", 1)[-1]
        selector = _extract_first_string_arg(obj, source)
        if selector:
            if tail == "getElementById":
                return selector if selector.startswith("#") else f"#{selector}"
            if tail in ("querySelector", "querySelectorAll", "closest"):
                return selector
            if tail == "getElementsByClassName":
                return selector if selector.startswith(".") else f".{selector}"
            if tail == "getElementsByTagName":
                return f"<{selector}>"
        if inner_name:
            return f"{inner_name}()"
        return ""
    return normalize_callee(node_text(obj, source))


def emit_callback_steps(
    stmt: Node,
    callbacks: list[tuple[Node, Node]],
    source: bytes,
    functions: dict[NodeKey, FunctionNode],
    builder: FlowGraphBuilder,
    pending: list[PendingExit],
    parent_id: str | None = None,
) -> list[PendingExit]:
    """Emite un sub-contenedor `⚡` (eventos/suscripciones) o `🔁` (iteradores/callbacks)
    y coloca dentro sus pasos limpios."""
    current = pending
    for idx, (call_node, cb_node) in enumerate(callbacks):
        callee_node = call_node.child_by_field_name("function")
        full_callee = normalize_callee(node_text(callee_node, source)) if callee_node is not None else "callback"
        first_str = _extract_first_string_arg(call_node, source)
        cb_kind, event_label = classify_callback_container(full_callee, first_str)
        is_event_cb = (
            cb_kind in (EDGE_EVENT_LISTENER, EDGE_REACTIVE_SUBSCRIBE)
            or is_startup_hook_call(full_callee)
        )

        cb_params_node = cb_node.child_by_field_name("parameters") or cb_node.child_by_field_name("parameter")
        cb_params = parameter_names(cb_params_node, source)
        params_suffix = f"({', '.join(cb_params)})" if cb_params else ""

        if is_event_cb:
            target_label = _extract_dom_or_receiver_target(call_node, source)
            if event_label and target_label:
                header_label = flow_label(f"⚡ {event_label} · {target_label}{params_suffix}")
            elif event_label:
                call_title = callback_call_title(call_node, source)
                header_label = flow_label(f"⚡ {event_label} · {call_title}{params_suffix}")
            elif is_startup_hook_call(full_callee):
                short_args = _extract_short_non_fn_args(call_node, source, max_args=2, max_arg_chars=18)
                args_part = ", ".join(short_args) if short_args else ", ".join(cb_params)
                header_label = flow_label(
                    f"⚡ {full_callee}({args_part})" if args_part else f"⚡ {full_callee}"
                )
            else:
                header_label = flow_label(f"⚡ {full_callee}{params_suffix}")
            step_kind = "event"
        else:
            call_title = callback_call_title(call_node, source)
            params_label = ", ".join(cb_params) or "∅"
            lead = ""
            if idx == 0 and stmt.type in ("return_statement", "throw_statement", *FLOW_DECLARATION_TYPES):
                raw_lead = collapse_whitespace(text_between(source, stmt, call_node))
                if raw_lead and len(raw_lead) <= 40:
                    lead = f"{raw_lead} "
            header_label = flow_label(f"🔁 {lead}{call_title}({params_label})")
            step_kind = "loop"

        code_node = stmt if (idx == 0 and len(callbacks) == 1) else call_node
        cb_step, current = builder.emit_sequential(
            current,
            shallow_call_role(call_node, source),
            header_label,
            code=dedent_code(node_text(code_node, source)),
            parent_id=parent_id,
            is_container=True,
            kind=step_kind,
            line=line_of(code_node),
            end_line=end_line_of(code_node),
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
        return flow_label("case " + collapse_whitespace(node_text(node.child_by_field_name("value"), source)))
    if node.type == "switch_default":
        return "default"
    if node.type == "do_statement":
        return flow_label(
            "do … while " + collapse_whitespace(node_text(node.child_by_field_name("condition"), source))
        )
    body = node.child_by_field_name("body") or node.child_by_field_name("consequence")
    raw = text_between(source, node, body) if body is not None else node_text(node, source)
    cleaned = collapse_whitespace(raw).rstrip("{").rstrip(":").strip()
    cleaned = re.sub(r"\s+\)", ")", cleaned)
    return flow_label(cleaned)


def step_role(node: Node, source: bytes, functions: dict[NodeKey, FunctionNode]) -> str:
    for item in iter_body_nodes(node, functions):
        if item.type in AWAIT_TYPES:
            return ROLE_IO
        if item.type in CALL_TYPES:
            callee_node = item.child_by_field_name("function") or item.child_by_field_name("constructor")
            if is_io_call(normalize_callee(node_text(callee_node, source))):
                return ROLE_IO
    return ROLE_TRANSFORM
