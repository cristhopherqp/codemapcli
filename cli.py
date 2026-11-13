"""Interfaz de línea de comandos (CodeMap v1.0).

    codemap <archivo-o-carpeta> [--once] [--include-private] [--no-serve] [--no-browser]
    codemap list
    codemap clean
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from codemap.discovery import discover_files, is_supported_file
from codemap.graph_builder import build_graph
from codemap.models import FileAnalysis
from codemap.notes_storage import reconcile_notes
from codemap.parsers import parse_file
from codemap.paths import normalize_path
from codemap.server import serve_viewer
from codemap.storage import clean_orphan_projects, list_registered_projects, write_graph

LEVEL_NAMES = {1: "1 (Arquitectura)", 2: "2 (Interconexión)", 3: "3 (Flujo de Archivo)", 4: "3+ (Intra-función)"}


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="codemap",
        description="Mapa interactivo de la arquitectura de un archivo o proyecto (solo lectura).",
        epilog="Subcomandos:\n  codemap list    Lista proyectos mapeados en ~/.codemap/\n  codemap clean   Elimina cachés huérfanos en ~/.codemap/",
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
