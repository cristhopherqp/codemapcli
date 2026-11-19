"""Interfaz de línea de comandos (CodeMap v1.0).

    codemap <archivo-o-carpeta> [--once] [--include-private] [--no-serve] [--no-browser]
    codemap export <archivo-o-carpeta> [--format json|md] [--include-flow] [--include-private] [--out <ruta>] [--stdout]
    codemap list
    codemap clean
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from codemap.discovery import discover_files, is_supported_file
from codemap.exporter import build_ai_markdown, serialize_ai_graph
from codemap.graph_builder import build_graph
from codemap.models import FileAnalysis
from codemap.notes_storage import reconcile_notes
from codemap.parsers import parse_file
from codemap.paths import normalize_path
from codemap.server import serve_viewer
from codemap.storage import (
    clean_orphan_projects,
    list_registered_projects,
    register_project,
    write_ai_export,
    write_graph,
)

LEVEL_NAMES = {1: "1 (Arquitectura)", 2: "2 (Interconexión)", 3: "3 (Flujo de Archivo)", 4: "3+ (Intra-función)"}


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="codemap",
        description="Mapa interactivo de la arquitectura de un archivo o proyecto (solo lectura).",
        epilog=(
            "Subcomandos:\n"
            "  codemap export <ruta>   Exporta el grafo compacto para IA (JSON minificado o Markdown)\n"
            "  codemap list            Lista proyectos mapeados en ~/.codemap/\n"
            "  codemap clean           Elimina cachés huérfanos en ~/.codemap/"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("target", help="archivo .py/.js/.jsx/.ts/.tsx o carpeta del proyecto")
    parser.add_argument(
        "--once",
        action="store_true",
        help="abrir el visor sin observar cambios en tiempo real (sin watchdog)",
    )
    parser.add_argument(
        "--include-private",
        action="store_true",
        help="incluir funciones privadas/dunder (_helper, __init__, #metodo)",
    )
    parser.add_argument(
        "--no-serve",
        action="store_true",
        help="solo generar graph.json, sin levantar el visor",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="levantar el visor sin abrir el navegador automáticamente",
    )
    return parser


def collect_source_files(target: Path) -> tuple[list[Path], Path, bool]:
    """(archivos a analizar, carpeta base de IDs, es_archivo_suelto)."""
    if target.is_file():
        if not is_supported_file(target):
            raise SystemExit(f"Extensión no soportada: {target.suffix}")
        return [target], target.parent, True
    if target.is_dir():
        return discover_files(target), target, False
    raise SystemExit(f"No existe: {target}")


def analyze_files(files: list[Path]) -> list[FileAnalysis]:
    analyses: list[FileAnalysis] = []
    for path in files:
        try:
            analysis = parse_file(path)
        except OSError as error:
            print(f"  [omitido] {path}: {error}", file=sys.stderr)
            continue
        if analysis is not None:
            analyses.append(analysis)
    return analyses


def build_and_save_project(target: Path, include_private: bool) -> tuple[dict, dict, Path, int]:
    """Analiza el objetivo, escribe graph.json y reconcilia notes.json."""
    files, root_dir, is_single_file = collect_source_files(target)
    analyses = analyze_files(files)
    graph = build_graph(
        analyses,
        target_path=target.as_posix(),
        root_dir=root_dir.as_posix(),
        is_single_file=is_single_file,
        include_private=include_private,
    )
    graph_path = write_graph(target.as_posix(), graph)
    notes = reconcile_notes(target.as_posix(), graph)
    return graph, notes, graph_path, len(analyses)


def print_summary(graph: dict, file_count: int, graph_path: Path) -> None:
    edges = graph["edges"]
    confirmed = sum(1 for e in edges if e["confidence"] == "confirmed")
    meta = graph["meta"]
    print(f"Proyecto:   {meta['project_name']}  ({meta['root_path']})")
    print(f"Archivos:   {file_count}")
    print(f"Funciones:  {meta['total_functions']}")
    print(f"Aristas:    {len(edges)}  ({confirmed} confirmadas, {len(edges) - confirmed} inferidas)")
    print(f"Nivel inicial recomendado: {LEVEL_NAMES[meta['recommended_level']]}")
    print(f"graph.json: {graph_path}")


def build_export_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="codemap export",
        description="Exporta una versión compacta y optimizada del grafo para compartir con modelos de IA.",
    )
    parser.add_argument("target", help="archivo .py/.js/.jsx/.ts/.tsx o carpeta del proyecto")
    parser.add_argument(
        "--format",
        choices=("json", "md"),
        default="json",
        help="formato de salida: json (minificado, por defecto) o md (Markdown con Mermaid)",
    )
    parser.add_argument(
        "--include-flow",
        action="store_true",
        help="incluir pasos de flujo intra-función (Nivel 3+)",
    )
    parser.add_argument(
        "--include-private",
        action="store_true",
        help="incluir funciones privadas/dunder (_helper, __init__, #metodo)",
    )
    parser.add_argument(
        "--out",
        default="",
        help="ruta explícita de archivo donde guardar la exportación",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="imprimir el resultado directamente en salida estándar",
    )
    return parser


def run_export(argv: list[str]) -> int:
    args = build_export_argument_parser().parse_args(argv)
    target = Path(normalize_path(args.target))

    files, root_dir, is_single_file = collect_source_files(target)
    analyses = analyze_files(files)
    graph = build_graph(
        analyses,
        target_path=target.as_posix(),
        root_dir=root_dir.as_posix(),
        is_single_file=is_single_file,
        include_private=args.include_private,
    )

    if args.format == "md":
        content = build_ai_markdown(graph, include_flow=args.include_flow)
        ext = "md"
    else:
        content = serialize_ai_graph(graph, include_flow=args.include_flow)
        ext = "json"

    if args.stdout:
        if hasattr(sys.stdout, "reconfigure"):
            try:
                sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            except OSError:
                pass
        sys.stdout.write(content)
        if not content.endswith("\n"):
            sys.stdout.write("\n")
        return 0

    if args.out:
        out_path = Path(args.out).expanduser()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(content, encoding="utf-8")
    else:
        out_path = write_ai_export(target.as_posix(), content, ext)
        register_project(target.as_posix(), graph["meta"])

    raw_size = len(json.dumps(graph, indent=2, ensure_ascii=False).encode("utf-8"))
    export_size = len(content.encode("utf-8"))
    reduction = (1.0 - (export_size / raw_size)) * 100.0 if raw_size > 0 else 0.0
    print(f"Proyecto:   {graph['meta']['project_name']}  ({graph['meta']['root_path']})")
    print(f"Formato:    {args.format}  (include_flow={'sí' if args.include_flow else 'no'})")
    print(f"Tamaño:     {export_size:,} B  (vs {raw_size:,} B en graph.json, -{reduction:.1f}%)")
    print(f"Archivo:    {out_path}")
    return 0


def run_list() -> int:
    projects = list_registered_projects()
    if not projects:
        print("No hay proyectos registrados en ~/.codemap/.")
        return 0
    for item in projects:
        status = "OK" if item["exists"] else "NO EXISTE"
        print(f"[{status}] {item['project_name']} -> {item['root_path']} ({item['hash'][:12]})")
    return 0


def run_clean() -> int:
    removed = clean_orphan_projects()
    if not removed:
        print("No se encontraron cachés huérfanos para limpiar.")
        return 0
    for item in removed:
        print(f"Eliminado caché huérfano: {item}")
    return 0


def main(argv: list[str] | None = None) -> int:
    raw_argv = sys.argv[1:] if argv is None else list(argv)
    if raw_argv and raw_argv[0] == "export":
        return run_export(raw_argv[1:])
    if raw_argv == ["list"]:
        return run_list()
    if raw_argv == ["clean"]:
        return run_clean()

    args = build_argument_parser().parse_args(raw_argv)
    target = Path(normalize_path(args.target))

    graph, _notes, graph_path, file_count = build_and_save_project(target, args.include_private)
    print_summary(graph, file_count, graph_path)

    if not args.no_serve:
        def rebuild() -> tuple[dict, dict]:
            new_graph, new_notes, _, _ = build_and_save_project(target, args.include_private)
            return new_graph, new_notes

        serve_viewer(
            target_path=target.as_posix(),
            graph=graph,
            rebuild_fn=rebuild,
            watch=not args.once,
            open_browser=not args.no_browser,
        )
    return 0
