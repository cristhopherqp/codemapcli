"""Pruebas unitarias de la Etapa 2: escala N1–N3+, recommended_level y claves semánticas pinned_positions."""

from __future__ import annotations

import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from codemap.cli import LEVEL_NAMES
from codemap.discovery import discover_files
from codemap.graph_builder import (
    LEVEL_FILES,
    LEVEL_FUNCTIONS,
    LEVEL_INTRA_FUNCTION,
    LEVEL_MODULES,
    build_graph,
    recommended_level,
)
from codemap.notes_storage import load_notes, reconcile_notes, update_notes
from codemap.parsers import parse_file
from codemap.paths import normalize_path

REPO_ROOT = Path(__file__).resolve().parent.parent


class TestStage2LevelScaleAndPinnedSemantics(unittest.TestCase):
    def test_recommended_level_rules_for_new_scale(self) -> None:
        # <= 2 funciones -> Nivel 3+ (Intra-función)
        self.assertEqual(recommended_level(0, False, has_modules=True), LEVEL_INTRA_FUNCTION)
        self.assertEqual(recommended_level(2, True, has_modules=False), LEVEL_INTRA_FUNCTION)
        self.assertEqual(recommended_level(2, False, has_modules=True), LEVEL_INTRA_FUNCTION)

        # Archivo suelto (> 2 funciones) -> Nivel 3 (Funciones)
        self.assertEqual(recommended_level(5, True, has_modules=False), LEVEL_FUNCTIONS)
        self.assertEqual(recommended_level(40, True, has_modules=False), LEVEL_FUNCTIONS)

        # Proyecto mediano multi-archivo (3..25 funciones) -> Nivel 2 (Archivos)
        self.assertEqual(recommended_level(3, False, has_modules=True), LEVEL_FILES)
        self.assertEqual(recommended_level(18, False, has_modules=True), LEVEL_FILES)
        self.assertEqual(recommended_level(25, False, has_modules=False), LEVEL_FILES)

        # Proyecto grande (> 25 funciones) -> Nivel 1 (Módulos) si hay carpetas, o Nivel 2 si es plano
        self.assertEqual(recommended_level(26, False, has_modules=True), LEVEL_MODULES)
        self.assertEqual(recommended_level(26, False, has_modules=False), LEVEL_FILES)

        # CLI LEVEL_NAMES sincronizados
        self.assertIn("Módulos", LEVEL_NAMES[1])
        self.assertIn("Archivos", LEVEL_NAMES[2])
        self.assertIn("Funciones", LEVEL_NAMES[3])
        self.assertIn("Intra-función", LEVEL_NAMES[4])

    def test_build_graph_sets_recommended_level_for_multi_single_and_large(self) -> None:
        multi_dir = REPO_ROOT / "examples" / "multi"
        files = discover_files(multi_dir)
        analyses = [a for p in files if (a := parse_file(p)) is not None]
        target = normalize_path(multi_dir)
        graph_multi = build_graph(
            analyses,
            target_path=target,
            root_dir=target,
            is_single_file=False,
            include_private=False,
        )
        # examples/multi tiene 18 funciones -> abre en Nivel 2 (Archivos)
        self.assertEqual(graph_multi["meta"]["recommended_level"], LEVEL_FILES)

        # Archivo suelto con 4 funciones -> Nivel 3 (Funciones)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "solo.py"
            script.write_text(
                textwrap.dedent(
                    """
                    def a(): return 1
                    def b(): return a()
                    def c(): return b()
                    def d(): return c()
                    """
                ).lstrip("\n"),
                encoding="utf-8",
            )
            single_analysis = parse_file(script)
            assert single_analysis is not None
            graph_single = build_graph(
                [single_analysis],
                target_path=normalize_path(script),
                root_dir=normalize_path(root),
                is_single_file=True,
                include_private=False,
            )
            self.assertEqual(graph_single["meta"]["recommended_level"], LEVEL_FUNCTIONS)

            # Proyecto grande plano (> 25 funciones sin subcarpetas) -> Nivel 2 (Archivos)
            big_a = root / "a.py"
            big_b = root / "b.py"
            big_a.write_text("\n".join(f"def fa_{i}(): return {i}" for i in range(15)), encoding="utf-8")
            big_b.write_text("\n".join(f"def fb_{i}(): return {i}" for i in range(15)), encoding="utf-8")
            flat_analyses = [a for p in (big_a, big_b) if (a := parse_file(p)) is not None]
            graph_big_flat = build_graph(
                flat_analyses,
                target_path=normalize_path(root),
                root_dir=normalize_path(root),
                is_single_file=False,
                include_private=False,
            )
            self.assertEqual(graph_big_flat["meta"]["recommended_level"], LEVEL_FILES)

    def test_semantic_pinned_positions_persist_and_coexist_with_legacy_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake_storage = Path(tmp) / ".codemap"
            target = (Path(tmp) / "proj").as_posix()
            graph = {
                "nodes": [
                    {"id": "src/app.py", "type": "file", "parent": "src", "label": "app.py"},
                    {
                        "id": "src/app.py::main",
                        "type": "function",
                        "parent": "src/app.py",
                        "fingerprint": "fp_main_01",
                    },
                ]
            }

            with mock.patch("codemap.paths.storage_root", return_value=fake_storage):
                updated = update_notes(
                    target,
                    {
                        "nodes": {
                            "src/app.py": {
                                "pinned": True,
                                "pinned_positions": {
                                    "files": {"x": 80, "y": 120},
                                    "layers_files": {"x": 40, "y": 60},
                                    "bogus_key": {"x": 1, "y": 1},
                                },
                            },
                            "src/app.py::main": {
                                "note": "Arranque",
                                "pinned": True,
                                "pinned_positions": {
                                    "level_2": {"x": 200, "y": 300},
                                    "functions": {"x": 210, "y": 310},
                                    "intra": {"x": 500, "y": 600},
                                },
                            },
                        }
                    },
                    graph,
                )

                file_entry = updated["nodes"]["src/app.py"]
                self.assertEqual(
                    file_entry["pinned_positions"],
                    {
                        "files": {"x": 80.0, "y": 120.0},
                        "layers_files": {"x": 40.0, "y": 60.0},
                    },
                )
                self.assertNotIn("bogus_key", file_entry["pinned_positions"])

                fn_entry = updated["nodes"]["src/app.py::main"]
                self.assertEqual(fn_entry["pinned_positions"]["level_2"], {"x": 200.0, "y": 300.0})
                self.assertEqual(fn_entry["pinned_positions"]["functions"], {"x": 210.0, "y": 310.0})
                self.assertEqual(fn_entry["pinned_positions"]["intra"], {"x": 500.0, "y": 600.0})

                # Reconciliación tras renombrado preserva todas las claves semánticas.
                reloaded = load_notes(target)
                self.assertEqual(reloaded["nodes"]["src/app.py"]["pinned_positions"]["files"], {"x": 80.0, "y": 120.0})
                renamed_graph = {
                    "nodes": [
                        {"id": "src/app.py", "type": "file", "parent": "src", "label": "app.py"},
                        {
                            "id": "src/app.py::bootstrap",
                            "type": "function",
                            "parent": "src/app.py",
                            "fingerprint": "fp_main_01",
                        },
                    ]
                }
                reconciled = reconcile_notes(target, renamed_graph)
                self.assertIn("src/app.py::bootstrap", reconciled["nodes"])
                self.assertEqual(
                    reconciled["nodes"]["src/app.py::bootstrap"]["pinned_positions"]["functions"],
                    {"x": 210.0, "y": 310.0},
                )


if __name__ == "__main__":
    unittest.main()
