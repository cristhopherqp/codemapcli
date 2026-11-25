"""Micro-diccionario estático y extractor AST de vocabulario técnico (Ciclo 9 — Lote 4).

Detecta modismos de sintaxis Python/JS/TS, códigos POSIX y literales de control
directamente sobre el árbol `tree-sitter` ya parseado (sin falsos positivos por
texto dentro de comentarios o cadenas arbitrarias).
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING

from codemap.parsers.common import NodeKey, line_of, node_key, node_text

if TYPE_CHECKING:
    from tree_sitter import Node

VOCAB_DICTIONARY_PATH = Path(__file__).with_name("vocab_dictionary.json")

POSIX_CODES = frozenset(
    {
        "ENOENT",
        "EACCES",
        "EPERM",
        "EEXIST",
        "EISDIR",
        "ENOTDIR",
        "ECONNREFUSED",
        "EADDRINUSE",
        "ETIMEDOUT",
        "EPIPE",
        "ECONNRESET",
        "ENOSPC",
        "EINVAL",
        "EBUSY",
    }
)


@lru_cache(maxsize=1)
def load_vocab_dictionary() -> dict:
    """Carga y cachea `codemap/vocab_dictionary.json` en memoria."""
    try:
        raw = json.loads(VOCAB_DICTIONARY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "entries": {}}
    if not isinstance(raw, dict) or not isinstance(raw.get("entries"), dict):
        return {"version": 1, "entries": {}}
    return raw


def _add_hit(bucket: dict[int, list[str]], line: int, vocab_id: str) -> None:
    if line <= 0 or not vocab_id:
        return
    items = bucket.setdefault(line, [])
    if vocab_id not in items:
        items.append(vocab_id)


def _detect_control_escapes_in_literal(raw_text: str) -> list[str]:
    """Detecta secuencias de control reales dentro de un nodo literal/escape (nunca comentarios)."""
    hits: list[str] = []
    if "\\r\\n" in raw_text:
        hits.append("ctrl:crlf")
    else:
        if "\\n" in raw_text:
            hits.append("ctrl:lf")
    if "\\0" in raw_text or "\\x00" in raw_text or "\\u0000" in raw_text:
        hits.append("ctrl:nul")
    if "\\t" in raw_text:
        hits.append("ctrl:tab")
    return hits


def _detect_posix_in_string_literal(raw_text: str) -> str | None:
    """Detecta un código POSIX solo si el literal de cadena es exactamente ese código."""
    stripped = raw_text.strip()
    if len(stripped) >= 2 and stripped[0] == stripped[-1] and stripped[0] in ("'", '"', "`"):
        inner = stripped[1:-1].strip()
        if inner in POSIX_CODES:
            return f"posix:{inner}"
    elif stripped in POSIX_CODES:
        return f"posix:{stripped}"
    return None


def extract_python_vocab_by_line(
    fn_node: Node,
    source: bytes,
    function_nodes: dict[NodeKey, Node],
) -> dict[int, list[str]]:
    """Extrae vocabulario técnico por línea sobre una función Python sin entrar en anidadas."""
    hits: dict[int, list[str]] = {}
    root_key = node_key(fn_node)

    # Decoradores en `decorated_definition` inmediatamente encima de la función.
    parent = fn_node.parent
    if parent is not None and parent.type == "decorated_definition":
        for ch in parent.named_children:
            if ch.type == "decorator":
                _add_hit(hits, line_of(ch), "syntax:py:decorator")

    # `async def ...`
    for ch in fn_node.children:
        if not ch.is_named and node_text(ch, source) == "async":
            _add_hit(hits, line_of(ch), "syntax:py:async_await")
            break

    stack: list[Node] = [fn_node]
    while stack:
        cur = stack.pop()
        ctype = cur.type

        if ctype == "comment":
            continue
        if cur is not fn_node and node_key(cur) != root_key and node_key(cur) in function_nodes:
            continue

        ln = line_of(cur)
        if ctype == "list_comprehension":
            _add_hit(hits, ln, "syntax:py:list_comp")
        elif ctype == "dictionary_comprehension":
            _add_hit(hits, ln, "syntax:py:dict_comp")
        elif ctype == "set_comprehension":
            _add_hit(hits, ln, "syntax:py:set_comp")
        elif ctype == "generator_expression":
            _add_hit(hits, ln, "syntax:py:gen_expr")
        elif ctype == "decorator":
            _add_hit(hits, ln, "syntax:py:decorator")
        elif ctype == "with_statement":
            _add_hit(hits, ln, "syntax:py:with_context")
            for ch in cur.children:
                if not ch.is_named and node_text(ch, source) == "async":
                    _add_hit(hits, line_of(ch), "syntax:py:async_await")
        elif ctype == "for_statement":
            for ch in cur.children:
                if not ch.is_named and node_text(ch, source) == "async":
                    _add_hit(hits, line_of(ch), "syntax:py:async_await")
        elif ctype == "named_expression":
            _add_hit(hits, ln, "syntax:py:walrus")
        elif ctype == "slice":
            _add_hit(hits, ln, "syntax:py:slicing")
        elif ctype in ("list_splat", "list_splat_pattern"):
            _add_hit(hits, ln, "syntax:py:unpack_args")
        elif ctype in ("dictionary_splat", "dictionary_splat_pattern"):
            _add_hit(hits, ln, "syntax:py:unpack_kwargs")
        elif ctype == "lambda":
            _add_hit(hits, ln, "syntax:py:lambda")
        elif ctype == "conditional_expression":
            _add_hit(hits, ln, "syntax:py:ternary")
        elif ctype == "await":
            _add_hit(hits, ln, "syntax:py:async_await")
        elif ctype == "yield":
            _add_hit(hits, ln, "syntax:py:yield")
        elif ctype == "match_statement":
            _add_hit(hits, ln, "syntax:py:match_case")
        elif ctype == "try_statement":
            _add_hit(hits, ln, "syntax:py:try_except")
        elif ctype == "string":
            has_interp = any(ch.type == "interpolation" for ch in cur.named_children)
            if has_interp:
                _add_hit(hits, ln, "syntax:py:fstring")
            raw_str = node_text(cur, source)
            posix_id = _detect_posix_in_string_literal(raw_str)
            if posix_id:
                _add_hit(hits, ln, posix_id)
            if not raw_str.lstrip().startswith(("r'", 'r"', "R'", 'R"')):
                for ctrl_id in _detect_control_escapes_in_literal(raw_str):
                    _add_hit(hits, ln, ctrl_id)
        elif ctype == "attribute":
            attr = cur.child_by_field_name("attribute")
            if attr is not None:
                attr_name = node_text(attr, source)
                if attr_name in POSIX_CODES:
                    _add_hit(hits, line_of(attr), f"posix:{attr_name}")
        elif ctype == "identifier":
            ident = node_text(cur, source)
            if ident in POSIX_CODES:
                _add_hit(hits, ln, f"posix:{ident}")

        # Recorrer hijos (incluyendo interpolaciones de f-string, pero sin entrar en funciones anidadas).
        for ch in reversed(cur.named_children):
            stack.append(ch)

    return hits


def extract_js_vocab_by_line(
    fn_node: Node,
    source: bytes,
    function_nodes: dict[NodeKey, object],
) -> dict[int, list[str]]:
    """Extrae vocabulario técnico por línea sobre una función JS/TS sin entrar en anidadas."""
    hits: dict[int, list[str]] = {}
    root_key = node_key(fn_node)

    # `async function ...` / `async (...) => ...`
    for ch in fn_node.children:
        if not ch.is_named and node_text(ch, source) == "async":
            _add_hit(hits, line_of(ch), "syntax:js:async_await")
            break

    stack: list[Node] = [fn_node]
    while stack:
        cur = stack.pop()
        ctype = cur.type

        if ctype == "comment":
            continue
        if cur is not fn_node and node_key(cur) != root_key and node_key(cur) in function_nodes:
            if ctype == "arrow_function":
                _add_hit(hits, line_of(cur), "syntax:js:arrow_function")
            continue

        ln = line_of(cur)
        if ctype == "optional_chain":
            _add_hit(hits, ln, "syntax:js:optional_chaining")
        elif ctype in ("member_expression", "subscript_expression", "call_expression"):
            for ch in cur.children:
                if not ch.is_named and node_text(ch, source) == "?.":
                    _add_hit(hits, line_of(ch), "syntax:js:optional_chaining")
                    break
        elif ctype == "binary_expression":
            op_node = cur.child_by_field_name("operator")
            op_text = node_text(op_node, source) if op_node is not None else ""
            if op_text == "??":
                _add_hit(hits, line_of(op_node), "syntax:js:nullish_coalescing")
            elif op_text == "||":
                _add_hit(hits, line_of(op_node), "syntax:js:logical_or_default")
            elif op_text == "&&":
                _add_hit(hits, line_of(op_node), "syntax:js:logical_and_guard")
        elif ctype == "augmented_assignment_expression":
            op_node = cur.child_by_field_name("operator")
            if op_node is not None and node_text(op_node, source) == "??=":
                _add_hit(hits, line_of(op_node), "syntax:js:nullish_assign")
        elif ctype == "spread_element":
            _add_hit(hits, ln, "syntax:js:spread")
        elif ctype == "rest_pattern":
            _add_hit(hits, ln, "syntax:js:rest_params")
        elif ctype == "object_pattern":
            _add_hit(hits, ln, "syntax:js:object_destructuring")
        elif ctype == "array_pattern":
            _add_hit(hits, ln, "syntax:js:array_destructuring")
        elif ctype == "await_expression":
            _add_hit(hits, ln, "syntax:js:async_await")
        elif ctype == "template_string":
            if any(ch.type == "template_substitution" for ch in cur.named_children):
                _add_hit(hits, ln, "syntax:js:template_literal")
        elif ctype == "ternary_expression":
            _add_hit(hits, ln, "syntax:js:ternary")
        elif ctype == "arrow_function":
            _add_hit(hits, ln, "syntax:js:arrow_function")
        elif ctype == "yield_expression":
            _add_hit(hits, ln, "syntax:js:generator_yield")
        elif ctype == "for_in_statement":
            for ch in cur.children:
                if not ch.is_named:
                    tok = node_text(ch, source)
                    if tok == "of":
                        _add_hit(hits, line_of(ch), "syntax:js:for_of")
                        break
                    if tok == "in":
                        _add_hit(hits, line_of(ch), "syntax:js:for_in")
                        break
        elif ctype == "as_expression":
            _add_hit(hits, ln, "syntax:js:type_assertion")
        elif ctype == "string":
            raw_str = node_text(cur, source)
            posix_id = _detect_posix_in_string_literal(raw_str)
            if posix_id:
                _add_hit(hits, ln, posix_id)
            for ctrl_id in _detect_control_escapes_in_literal(raw_str):
                _add_hit(hits, ln, ctrl_id)
        elif ctype in ("identifier", "property_identifier"):
            ident = node_text(cur, source)
            if ident in POSIX_CODES:
                _add_hit(hits, ln, f"posix:{ident}")

        for ch in reversed(cur.named_children):
            stack.append(ch)

    return hits
