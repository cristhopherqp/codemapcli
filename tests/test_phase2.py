"""Pruebas unitarias de soporte backend para la Fase 2 (notes.json por nivel)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from codemap.notes_storage import (
    load_notes,
    normalize_node_entry,
    reconcile_notes,
    save_notes,
    update_notes,
)


class TestPinnedPositionsPerLevel(unittest.TestCase):
    """Aislamiento de coordenadas pinned por nivel en notes.json con retrocompatibilidad."""

    def test_legacy_notes_entry_loads_cleanly_with_empty_pinned_positions(self) -> None:
        legacy = {
            "note": "legacy note",
            "pinned": True,
            "x": 120.5,
            "y": 340.0,
            "custom_role": None,
            "last_fingerprint": "abc1234567",
        }
        normalized = normalize_node_entry(legacy)
        self.assertEqual(normalized["x"], 120.5)
        self.assertEqual(normalized["y"], 340.0)
        self.assertTrue(normalized["pinned"])
        self.assertEqual(normalized["pinned_positions"], {})

    def test_pinned_positions_persist_and_filter_invalid_levels(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            storage_dir = Path(tmp) / "cache"
            storage_dir.mkdir()
            target_path = (Path(tmp) / "proj").as_posix()
            graph = {
                "nodes": [
                    {
                        "id": "app.py::main",
                        "type": "function",
                        "parent": "app.py",
                        "fingerprint": "fp11111111",
                    }
                ]
            }

            with mock.patch("codemap.notes_storage.project_storage_dir", return_value=storage_dir):
                updated = update_notes(
                    target_path,
                    {
                        "nodes": {
                            "app.py::main": {
                                "pinned": True,
                                "x": 150.0,
                                "y": 210.5,
                                "pinned_positions": {
                                    "level_2": {"x": 150.0, "y": 210.5},
                                    "level_4": {"x": 420.0, "y": 510.0},
                                    "invalid_level": {"x": 1, "y": 2},
                                },
                            }
                        }
                    },
                    graph,
                )

                entry = updated["nodes"]["app.py::main"]
                self.assertEqual(
                    entry["pinned_positions"],
                    {
                        "level_2": {"x": 150.0, "y": 210.5},
                        "level_4": {"x": 420.0, "y": 510.0},
                    },
                )
                self.assertNotIn("invalid_level", entry["pinned_positions"])

                # Recarga desde disco y migración por fingerprint AST preserva pinned_positions.
                reloaded = load_notes(target_path)
                self.assertEqual(
                    reloaded["nodes"]["app.py::main"]["pinned_positions"]["level_2"],
                    {"x": 150.0, "y": 210.5},
                )

                renamed_graph = {
                    "nodes": [
                        {
                            "id": "app.py::start_main",
                            "type": "function",
                            "parent": "app.py",
                            "fingerprint": "fp11111111",
                        }
                    ]
                }
                reconciled = reconcile_notes(target_path, renamed_graph)
                self.assertIn("app.py::start_main", reconciled["nodes"])
                self.assertEqual(
                    reconciled["nodes"]["app.py::start_main"]["pinned_positions"],
                    {
                        "level_2": {"x": 150.0, "y": 210.5},
                        "level_4": {"x": 420.0, "y": 510.0},
                    },
                )

                raw_json = json.loads((storage_dir / "notes.json").read_text(encoding="utf-8"))
                self.assertIn("app.py::start_main", raw_json["nodes"])


if __name__ == "__main__":
    unittest.main()
