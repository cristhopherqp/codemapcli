"""Interfaz de línea de comandos (Etapas 1 y 2).

    python -m codemap <archivo-o-carpeta> [--include-private] [--no-serve] [--no-browser]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from codemap.discovery import discover_files, is_supported_file
from codemap.graph_builder import build_graph
from codemap.models import FileAnalysis
from codemap.parsers import parse_file
from codemap.paths import normalize_path
from codemap.server import serve_viewer
from codemap.storage import write_graph

LEVEL_NAMES = {1: "1 (Arquitectura)", 2: "2 (Interconexión)", 3: "3 (Flujo de Archivo)", 4: "3+ (Intra-función)"}


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="codemap",
        description="Mapa interactivo de la arquitectura de un archivo o proyecto (solo lectura).",
    )
    parser.add_argument("target", help="archivo .py/.js/.jsx/.ts/.tsx o carpeta del proyecto")
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


def main(argv: list[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)
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
    graph_path = write_graph(target.as_posix(), graph)
    print_summary(graph, len(analyses), graph_path)

    if not args.no_serve:
        serve_viewer(graph_path, open_browser=not args.no_browser)
    return 0
