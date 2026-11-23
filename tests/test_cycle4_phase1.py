"""Pruebas unitarias de la Fase 1 (Ciclo 4): rangos line/end_line, GET /source y confinamiento tsconfig extends."""

from __future__ import annotations

import asyncio
import json
import tempfile
import textwrap
import unittest
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from codemap.discovery import discover_files
from codemap.graph_builder import build_graph
from codemap.parsers import parse_file
from codemap.paths import normalize_path
from codemap.server import create_app

REPO_ROOT = Path(__file__).resolve().parent.parent


def _write_tree(root: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(content).lstrip("\n"), encoding="utf-8")


def _build_project_graph(root: Path, *, include_private: bool = False) -> dict:
    discovered = discover_files(root)
    analyses = [a for p in discovered if (a := parse_file(p)) is not None]
    target = normalize_path(root)
    return build_graph(
        analyses,
        target_path=target,
        root_dir=target,
        is_single_file=False,
        include_private=include_private,
    )


def _node_map(graph: dict) -> dict[str, dict]:
    return {n["id"]: n for n in graph["nodes"]}


class TestCycle4Phase1LineRangesAndSourceEndpoint(unittest.TestCase):
    def test_python_function_and_flow_step_line_ranges(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_tree(
                root,
                {
                    "calc.py": """
                    def classify_batch(items):
                        a = 1
                        b = 2
                        c = 3
                        if (
                            len(items) == 0
                            or a > b
                        ):
                            return "empty"
                        for item in items:
                            total = a + b + c + item
                        return total
                    """,
                },
            )
            graph = _build_project_graph(root)
            fn = _node_map(graph)["calc.py::classify_batch"]

            self.assertEqual(fn["line"], 1)
            self.assertEqual(fn["end_line"], 12)

            steps = fn["internal_flow"]
            # Paso de entrada (firma en línea 1).
            self.assertEqual(steps[0]["line"], 1)
            self.assertEqual(steps[0]["end_line"], 1)

            # Paso compactado (3 asignaciones en líneas 2..4).
            compacted = next(s for s in steps if "3 asignaciones" in s["label"])
            self.assertEqual(compacted["line"], 2)
            self.assertEqual(compacted["end_line"], 4)

            # Rombo `if`: solo la cabecera multilínea de la condición (líneas 5..8), NO todo el cuerpo.
            if_step = next(s for s in steps if s["role"] == "decision")
            self.assertEqual(if_step["line"], 5)
            self.assertLessEqual(if_step["end_line"], 8)

            # Contenedor de bucle `for`: cubre todo el bloque del bucle (líneas 10..11).
            loop_step = next(s for s in steps if s["kind"] == "loop")
            self.assertEqual(loop_step["line"], 10)
            self.assertEqual(loop_step["end_line"], 11)

            # Return final en línea 12.
            ret_step = next(s for s in steps if s["label"] == "return total")
            self.assertEqual(ret_step["line"], 12)
            self.assertEqual(ret_step["end_line"], 12)

    def test_js_function_callback_and_flow_step_line_ranges(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_tree(
                root,
                {
                    "flow.js": """
                    export function processList(items, btn) {
                      const a = 1;
                      const b = 2;
                      const c = 3;
                      if (items.length === 0) {
                        return [];
                      }
                      btn.addEventListener('click', (ev) => {
                        console.log(ev);
                      });
                      return items.map((x) => x + a + b + c);
                    }
                    """,
                },
            )
            graph = _build_project_graph(root)
            fn = _node_map(graph)["flow.js::processList"]

            self.assertEqual(fn["line"], 1)
            self.assertEqual(fn["end_line"], 12)

            steps = fn["internal_flow"]
            compacted = next(s for s in steps if "3 declaraciones" in s["label"])
            self.assertEqual(compacted["line"], 2)
            self.assertEqual(compacted["end_line"], 4)

            if_step = next(s for s in steps if s["role"] == "decision")
            self.assertEqual(if_step["line"], 5)
            self.assertEqual(if_step["end_line"], 5)

            ev_step = next(s for s in steps if s["kind"] == "event")
            self.assertEqual(ev_step["line"], 8)
            self.assertEqual(ev_step["end_line"], 10)

            map_step = next(s for s in steps if s["kind"] == "loop")
            self.assertEqual(map_step["line"], 11)
            self.assertEqual(map_step["end_line"], 11)

    def test_get_source_endpoint_returns_exact_lines_and_enforces_security(self) -> None:
        multi_dir = REPO_ROOT / "examples" / "multi"
        graph = _build_project_graph(multi_dir)

        async def _verify() -> None:
            app = create_app(normalize_path(multi_dir), graph)
            async with TestClient(TestServer(app)) as client:
                # 1. Función válida -> 200 con rango exacto de líneas.
                resp = await client.get("/source", params={"node_id": "backend/services/users.py::build_report"})
                self.assertEqual(resp.status, 200)
                data = await resp.json()
                self.assertEqual(data["node_id"], "backend/services/users.py::build_report")
                self.assertEqual(data["file_id"], "backend/services/users.py")
                self.assertEqual(data["language"], "python")
                self.assertEqual(data["start_line"], 22)
                self.assertEqual(data["end_line"], 30)
                self.assertEqual(data["lines"][0]["number"], 22)
                self.assertIn("def build_report", data["lines"][0]["text"])
                self.assertEqual(data["lines"][-1]["number"], 30)
                self.assertIn('return "grande"', data["lines"][-1]["text"])
                self.assertNotIn("\r", data["code"])

                # 2. Falta `node_id` -> 400.
                resp_missing = await client.get("/source")
                self.assertEqual(resp_missing.status, 400)

                # 3. Nodo inexistente -> 404.
                resp_404 = await client.get("/source", params={"node_id": "does/not/exist.py::fn"})
                self.assertEqual(resp_404.status, 404)

                # 4. Nodo módulo (sin archivo único) -> 400.
                resp_mod = await client.get("/source", params={"node_id": "backend"})
                self.assertEqual(resp_mod.status, 400)

                # 5. Origen externo -> 403 por `local_origin_middleware`.
                resp_origin = await client.get(
                    "/source",
                    params={"node_id": "backend/services/users.py::build_report"},
                    headers={"Origin": "https://evil.example"},
                )
                self.assertEqual(resp_origin.status, 403)

            # 6. Confinamiento estricto: un nodo alterado en memoria apuntando fuera del proyecto -> 403.
            with tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp)
                outside = base / "secret.txt"
                outside.write_text("TOP SECRET\n", encoding="utf-8")
                proj = base / "proj"
                proj.mkdir()
                (proj / "ok.py").write_text("def ok():\n    return 1\n", encoding="utf-8")
                tampered_graph = _build_project_graph(proj)
                for node in tampered_graph["nodes"]:
                    if node["id"] == "ok.py":
                        node["file_path"] = str(outside)
                tampered_app = create_app(normalize_path(proj), tampered_graph)
                async with TestClient(TestServer(tampered_app)) as client:
                    resp_escape = await client.get("/source", params={"node_id": "ok.py::ok"})
                    self.assertEqual(resp_escape.status, 403)

        asyncio.run(_verify())

    def test_tsconfig_extends_confined_to_project_root_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            # Archivo tsconfig malicioso FUERA de `root_dir` que define `@secret/*`.
            (base / "outside.base.json").write_text(
                json.dumps(
                    {
                        "compilerOptions": {
                            "baseUrl": "./proj",
                            "paths": {"@secret/*": ["src/*"]},
                        }
                    }
                ),
                encoding="utf-8",
            )
            proj = base / "proj"
            _write_tree(
                proj,
                {
                    "tsconfig.base.json": """
                    {
                      "compilerOptions": {
                        "baseUrl": ".",
                        "paths": { "@local/*": ["src/*"] }
                      }
                    }
                    """,
                    "sub/tsconfig.json": """
                    {
                      "extends": "../../outside.base.json",
                      "compilerOptions": {
                        "baseUrl": ".."
                      }
                    }
                    """,
                    "tsconfig.json": """
                    {
                      "extends": "./tsconfig.base.json"
                    }
                    """,
                    "src/util.ts": """
                    export function ping() { return 1; }
                    """,
                    "src/main.ts": """
                    import { ping } from '@local/util';
                    export function run() { return ping(); }
                    """,
                    "sub/app.ts": """
                    import { ping } from '@secret/util';
                    export function runSub() { return ping(); }
                    """,
                },
            )

            graph = _build_project_graph(proj)
            edges = {(e["source"], e["target"]) for e in graph["edges"]}

            # El extends interno (`./tsconfig.base.json`) sigue funcionando normalmente.
            self.assertIn(("src/main.ts::run", "src/util.ts::ping"), edges)
            # El extends que escapa fuera de `proj` (`../../outside.base.json`) es ignorado.
            self.assertNotIn(("sub/app.ts::runSub", "src/util.ts::ping"), edges)


if __name__ == "__main__":
    unittest.main()
