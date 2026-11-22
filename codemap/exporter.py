"""Exportación compacta y minificada del grafo para compartir con modelos de IA.

Genera dos representaciones optimizadas en consumo de tokens sin perder la
topología arquitectónica del proyecto:
  - JSON minificado (`build_ai_graph` / `serialize_ai_graph`): elimina `internal_flow`
    por defecto (habilitable con `include_flow=True`), omite `file_path`, `fingerprint`,
    `docs_url` y claves con valores neutros (`None`, `""`, `False`, `[]`).
  - Markdown estructurado (`build_ai_markdown`): resumen con diagrama Mermaid de
    dependencias, puntos de entrada, `execution_flows` y firmas/docstrings por archivo.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

from codemap.models import (
    EDGE_CALLBACK_REF,
    EDGE_DIRECT_CALL,
    EDGE_EVENT_LISTENER,
    EDGE_LOADS_SCRIPT,
    EDGE_REACTIVE_SUBSCRIBE,
    EDGE_REACTIVE_TRIGGER,
    EDGE_SERVES_HTML,
)

MERMAID_FILE_LIMIT = 25

_EDGE_SHORT_TAG: dict[str, str] = {
    EDGE_DIRECT_CALL: "",
    EDGE_EVENT_LISTENER: "event",
    EDGE_CALLBACK_REF: "cb",
    EDGE_REACTIVE_SUBSCRIBE: "sub",
    EDGE_REACTIVE_TRIGGER: "trigger",
    EDGE_LOADS_SCRIPT: "script",
    EDGE_SERVES_HTML: "html",
}

_ENTRY_BADGE: dict[str, str] = {
    "main": "main",
    "route_handler": "ruta",
    "event_handler": "evento",
    "unreferenced": "sin ref",
}


def _collapse_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _prune_neutral(mapping: dict) -> dict:
    """Elimina claves con valores neutros (`None`, `""`, `False`, `[]`, `{}`)."""
    cleaned: dict = {}
    for key, value in mapping.items():
        if value is None or value is False or value == "" or value == [] or value == {}:
            continue
        cleaned[key] = value
    return cleaned


def _compact_external_call(entry: dict) -> dict:
    symbol = entry.get("symbol", "")
    call_expr = entry.get("call_expr", "")
    compact = {
        "symbol": symbol,
        "module": entry.get("module", ""),
        "kind": entry.get("kind", ""),
        "line": entry.get("line"),
    }
    if call_expr and call_expr != symbol:
        compact["call_expr"] = call_expr
    return _prune_neutral(compact)


def _compact_flow_step(step: dict) -> dict:
    label = step.get("label", "")
    raw_code = step.get("code", "")
    compact: dict = {
        "id": step.get("id", ""),
        "role": step.get("role", ""),
        "label": label,
    }
    if raw_code and raw_code != label and _collapse_ws(raw_code) != label:
        compact["code"] = raw_code
    if step.get("parent_id"):
        compact["parent_id"] = step["parent_id"]
    if step.get("is_container"):
        compact["is_container"] = True
    step_kind = step.get("kind", "step")
    if step_kind and step_kind != "step":
        compact["kind"] = step_kind

    compact_edges: list[dict] = []
    for edge in step.get("edges", []):
        c_edge: dict = {"target": edge.get("target", "")}
        if edge.get("label"):
            c_edge["label"] = edge["label"]
        if edge.get("kind") and edge["kind"] != "flow":
            c_edge["kind"] = edge["kind"]
        compact_edges.append(c_edge)
    if compact_edges:
        compact["edges"] = compact_edges
    return _prune_neutral(compact)


def _compact_node(node: dict, *, include_flow: bool) -> dict:
    node_type = node.get("type", "")
    if node_type == "module":
        return _prune_neutral(
            {
                "id": node.get("id"),
                "type": node_type,
                "parent": node.get("parent"),
                "label": node.get("label"),
            }
        )

    if node_type == "file":
        return _prune_neutral(
            {
                "id": node.get("id"),
                "type": node_type,
                "parent": node.get("parent"),
                "label": node.get("label"),
                "language": node.get("language"),
                "docstring": node.get("docstring"),
                "arch_layer": node.get("arch_layer"),
                "is_main_entry": node.get("is_main_entry"),
                "script_targets": node.get("script_targets"),
                "loaded_by_html": node.get("loaded_by_html"),
                "module_entry_functions": node.get("module_entry_functions"),
            }
        )

    # Función / método / callback
    ext_calls = [_compact_external_call(c) for c in node.get("external_calls", [])]
    compact = {
        "id": node.get("id"),
        "type": node_type,
        "parent": node.get("parent"),
        "label": node.get("label"),
        "role": node.get("role"),
        "arch_layer": node.get("arch_layer"),
        "entry_kind": node.get("entry_kind"),
        "is_main_entry": node.get("is_main_entry"),
        "is_event_handler": node.get("is_event_handler"),
        "is_unreferenced": node.get("is_unreferenced"),
        "is_module_entry": node.get("is_module_entry"),
        "is_terminal": node.get("is_terminal"),
        "signature": node.get("signature"),
        "docstring": node.get("docstring"),
        "line": node.get("line"),
        "external_calls": ext_calls,
    }
    if include_flow and node.get("internal_flow"):
        compact["internal_flow"] = [_compact_flow_step(s) for s in node["internal_flow"]]
    return _prune_neutral(compact)


def _compact_edge(edge: dict) -> dict:
    compact: dict = {
        "source": edge.get("source"),
        "target": edge.get("target"),
        "edge_type": edge.get("edge_type", EDGE_DIRECT_CALL),
        "line": edge.get("line"),
    }
    if edge.get("confidence") and edge["confidence"] != "confirmed":
        compact["confidence"] = edge["confidence"]
    if (edge.get("call_count") or 1) > 1:
        compact["call_count"] = edge["call_count"]
    if edge.get("event"):
        compact["event"] = edge["event"]
    if edge.get("edge_types"):
        compact["edge_types"] = edge["edge_types"]
    return _prune_neutral(compact)


def _compact_execution_flow(flow: dict) -> dict:
    compact_steps: list[dict] = []
    for step in flow.get("steps", []):
        c_step: dict = {"node_id": step.get("node_id")}
        depth = step.get("depth", 0)
        if depth:
            c_step["depth"] = depth
        if step.get("edge_type"):
            c_step["edge_type"] = step["edge_type"]
        compact_steps.append(c_step)

    return _prune_neutral(
        {
            "id": flow.get("id"),
            "kind": flow.get("kind"),
            "label": flow.get("label"),
            "root_id": flow.get("root_id"),
            "trigger": flow.get("trigger"),
            "registered_by": flow.get("registered_by"),
            "steps": compact_steps,
        }
    )


def build_ai_graph(graph: dict, *, include_flow: bool = False) -> dict:
    """Construye un diccionario de grafo podado y compacto orientado a LLMs."""
    raw_meta = graph.get("meta", {})
    meta = _prune_neutral(
        {
            "project_name": raw_meta.get("project_name", ""),
            "total_functions": raw_meta.get("total_functions", 0),
            "recommended_level": raw_meta.get("recommended_level"),
            "main_entry_files": raw_meta.get("main_entry_files", []),
            "main_entry_functions": raw_meta.get("main_entry_functions", []),
        }
    )
    # Preservar total_functions incluso si es 0.
    meta["total_functions"] = raw_meta.get("total_functions", 0)

    nodes = [_compact_node(n, include_flow=include_flow) for n in graph.get("nodes", [])]
    edges = [_compact_edge(e) for e in graph.get("edges", [])]
    flows = [_compact_execution_flow(f) for f in graph.get("execution_flows", [])]

    result: dict = {
        "meta": meta,
        "nodes": nodes,
        "edges": edges,
    }
    if flows:
        result["execution_flows"] = flows
    return result


def serialize_ai_graph(graph: dict, *, include_flow: bool = False) -> str:
    """Serializa el grafo IA en JSON minificado sin indentación ni espacios sobrantes."""
    compact = build_ai_graph(graph, include_flow=include_flow)
    return json.dumps(compact, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------------------
# Resumen estructurado en Markdown (`--format md`)
# ---------------------------------------------------------------------------

def _owner_file_id(node_id: str) -> str:
    return node_id.split("::", 1)[0]


def _top_group_id(file_id: str) -> str:
    if "/" in file_id:
        return file_id.split("/", 1)[0] + "/"
    return file_id


def _mermaid_safe_label(text: str) -> str:
    return text.replace('"', "'").replace("\n", " ").strip()


def _build_mermaid_section(file_nodes: list[dict], edges: list[dict]) -> list[str]:
    use_modules = len(file_nodes) > MERMAID_FILE_LIMIT
    group_labels: dict[str, str] = {}
    for fnode in file_nodes:
        fid = fnode["id"]
        gid = _top_group_id(fid) if use_modules else fid
        group_labels.setdefault(gid, gid)

    agg: dict[tuple[str, str], dict] = {}
    for edge in edges:
        src_file = _owner_file_id(edge["source"])
        tgt_file = _owner_file_id(edge["target"])
        src_gid = _top_group_id(src_file) if use_modules else src_file
        tgt_gid = _top_group_id(tgt_file) if use_modules else tgt_file
        if src_gid == tgt_gid:
            continue
        group_labels.setdefault(src_gid, src_gid)
        group_labels.setdefault(tgt_gid, tgt_gid)
        key = (src_gid, tgt_gid)
        bucket = agg.setdefault(key, {"count": 0, "types": set()})
        bucket["count"] += int(edge.get("call_count") or 1)
        bucket["types"].add(edge.get("edge_type", EDGE_DIRECT_CALL))

    scope_note = "módulos" if use_modules else "archivos"
    lines = [f"## Arquitectura ({scope_note})", "", "```mermaid", "flowchart LR"]

    sorted_groups = sorted(group_labels)
    id_map = {gid: f"n{idx}" for idx, gid in enumerate(sorted_groups, start=1)}
    for gid in sorted_groups:
        lines.append(f'  {id_map[gid]}["{_mermaid_safe_label(group_labels[gid])}"]')

    for (src_gid, tgt_gid), info in sorted(agg.items()):
        tags = sorted({_EDGE_SHORT_TAG.get(t, "") for t in info["types"] if _EDGE_SHORT_TAG.get(t, "")})
        parts: list[str] = []
        if tags:
            parts.append("/".join(tags))
        if info["count"] > 1:
            parts.append(f"×{info['count']}")
        if parts:
            edge_label = _mermaid_safe_label(" ".join(parts))
            lines.append(f'  {id_map[src_gid]} -->|"{edge_label}"| {id_map[tgt_gid]}')
        else:
            lines.append(f"  {id_map[src_gid]} --> {id_map[tgt_gid]}")

    lines.append("```")
    return lines


def _short_id(node_id: str) -> str:
    if "::" in node_id:
        file_part, fn_part = node_id.split("::", 1)
        return f"{Path(file_part).name}::{fn_part}"
    return node_id


def build_ai_markdown(graph: dict, *, include_flow: bool = False) -> str:
    """Genera un resumen Markdown compacto y estructurado para modelos de IA."""
    meta = graph.get("meta", {})
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    flows = graph.get("execution_flows", [])

    file_nodes = sorted((n for n in nodes if n.get("type") == "file"), key=lambda n: n["id"])
    fn_nodes = [n for n in nodes if n.get("type") == "function"]

    fns_by_file: dict[str, list[dict]] = defaultdict(list)
    for fn in fn_nodes:
        fns_by_file[fn.get("parent", "")].append(fn)
    for fn_list in fns_by_file.values():
        fn_list.sort(key=lambda n: (n.get("line", 0), n["id"]))

    out_edges_by_src: dict[str, list[dict]] = defaultdict(list)
    for edge in edges:
        out_edges_by_src[edge["source"]].append(edge)
    for e_list in out_edges_by_src.values():
        e_list.sort(key=lambda e: (e.get("line", 0), e["target"]))

    project_name = meta.get("project_name", "Proyecto")
    lines: list[str] = [
        f"# CodeMap — {project_name}",
        "",
        (
            f"- **Archivos:** {len(file_nodes)} · "
            f"**Funciones:** {meta.get('total_functions', len(fn_nodes))} · "
            f"**Aristas:** {len(edges)} · "
            f"**Hilos de ejecución:** {len(flows)}"
        ),
    ]

    entry_files = meta.get("main_entry_files") or []
    entry_fns = meta.get("main_entry_functions") or []
    if entry_files or entry_fns:
        lines.append("")
        lines.append("## Puntos de Entrada")
        if entry_files:
            lines.append("- **Archivos:** " + ", ".join(f"`{f}`" for f in entry_files))
        if entry_fns:
            lines.append("- **Funciones:** " + ", ".join(f"`{f}`" for f in entry_fns))

    if file_nodes:
        lines.append("")
        lines.extend(_build_mermaid_section(file_nodes, edges))

    if flows:
        lines.append("")
        lines.append("## Hilos de Ejecución")
        for flow in flows:
            kind_tag = "PRINCIPAL" if flow.get("kind") == "main" else "FEATURE"
            trigger = flow.get("trigger", "")
            trig_suffix = f" ({trigger})" if trigger else ""
            lines.append(f"- **[{kind_tag}] {flow.get('label', flow.get('id', ''))}**{trig_suffix}")
            steps = flow.get("steps", [])
            if len(steps) <= 6 and all(s.get("depth", 0) == idx for idx, s in enumerate(steps)):
                chain = " -> ".join(f"`{_short_id(s['node_id'])}`" for s in steps)
                lines.append(f"  - {chain}")
            else:
                for step in steps:
                    depth = min(int(step.get("depth", 0)), 6)
                    indent = "  " * (depth + 1)
                    e_type = step.get("edge_type") or ""
                    e_tag = _EDGE_SHORT_TAG.get(e_type, "")
                    prefix = f"[{e_tag}] " if e_tag else ""
                    lines.append(f"{indent}- {prefix}`{_short_id(step['node_id'])}`")

    if file_nodes:
        lines.append("")
        lines.append("## Mapa por Archivo")
        for fnode in file_nodes:
            fid = fnode["id"]
            tags: list[str] = []
            if fnode.get("language"):
                tags.append(fnode["language"])
            if fnode.get("is_main_entry"):
                tags.append("entrada")
            header_tags = f" ({', '.join(tags)})" if tags else ""
            lines.append("")
            lines.append(f"### `{fid}`{header_tags}")

            file_doc = _collapse_ws(fnode.get("docstring", ""))
            if file_doc:
                if len(file_doc) > 200:
                    file_doc = file_doc[:199].rstrip() + "…"
                lines.append(f"> {file_doc}")

            if fnode.get("script_targets"):
                targets = ", ".join(f"`{t}`" for t in fnode["script_targets"])
                lines.append(f"- Carga scripts: {targets}")

            file_fns = fns_by_file.get(fid, [])
            if not file_fns:
                file_out = out_edges_by_src.get(fid, [])
                if file_out and not fnode.get("script_targets"):
                    callees = ", ".join(f"`{e['target']}`" for e in file_out)
                    lines.append(f"- Conecta con: {callees}")
                continue

            for fn in file_fns:
                line_num = fn.get("line", 0)
                sig = _collapse_ws(fn.get("signature") or fn.get("label") or fn["id"])
                role = fn.get("role", "transform")
                e_kind = fn.get("entry_kind")
                badges = [role]
                if e_kind and e_kind in _ENTRY_BADGE:
                    badges.append(_ENTRY_BADGE[e_kind])
                lines.append(f"- `L{line_num}` **`{sig}`** [{', '.join(badges)}]")

                doc = _collapse_ws(fn.get("docstring", ""))
                if doc:
                    if len(doc) > 160:
                        doc = doc[:159].rstrip() + "…"
                    lines.append(f"  - {doc}")

                fn_edges = out_edges_by_src.get(fn["id"], [])
                if fn_edges:
                    targets_fmt: list[str] = []
                    for e in fn_edges:
                        tag = _EDGE_SHORT_TAG.get(e.get("edge_type", EDGE_DIRECT_CALL), "")
                        ev = e.get("event", "")
                        suffix = f" ({tag}:{ev})" if (tag and ev) else (f" ({tag})" if tag else "")
                        targets_fmt.append(f"`{_short_id(e['target'])}`{suffix}")
                    lines.append("  - Llama: " + ", ".join(targets_fmt))

                ext_calls = fn.get("external_calls") or []
                if ext_calls:
                    ext_names = ", ".join(f"`{c['symbol']}`" for c in ext_calls[:10])
                    if len(ext_calls) > 10:
                        ext_names += f" (+{len(ext_calls) - 10})"
                    lines.append("  - Externas: " + ext_names)

                if include_flow and fn.get("internal_flow"):
                    step_by_id = {s["id"]: s for s in fn["internal_flow"]}
                    lines.append("  - Flujo interno:")
                    for step in fn["internal_flow"]:
                        if step.get("kind") == "merge":
                            continue
                        depth = 0
                        cursor = step.get("parent_id")
                        seen: set[str] = {step["id"]}
                        while cursor and cursor in step_by_id and cursor not in seen:
                            seen.add(cursor)
                            depth += 1
                            cursor = step_by_id[cursor].get("parent_id")
                        indent = "    " + ("  " * min(depth, 5))
                        lines.append(f"{indent}- {step.get('label', '')}")

    return "\n".join(lines).rstrip() + "\n"
