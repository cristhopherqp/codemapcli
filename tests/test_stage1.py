"""Pruebas unitarias de la Etapa 1: fixes del parser/grafo, callbacks/listeners y `codemap export`."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from aiohttp.test_utils import TestClient, TestServer

from codemap.cli import main as cli_main
from codemap.discovery import discover_files
from codemap.exporter import build_ai_graph, build_ai_markdown, serialize_ai_graph
from codemap.graph_builder import build_graph
from codemap.models import (
    ENTRY_KIND_EVENT,
    ENTRY_KIND_MAIN,
    ENTRY_KIND_ROUTE,
    ROLE_ENTRY,
)
from codemap.notes_storage import reconcile_notes, save_notes
from codemap.parsers import parse_file
from codemap.parsers.common import FLOW_LABEL_MAX_CHARS, flow_label
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


class TestStage1ParserAndGraphFixes(unittest.TestCase):
    def test_flow_label_truncates_giant_template_literals_but_preserves_full_code(self) -> None:
        long_text = "body.innerHTML = `" + ("<div class='card'>item</div>" * 30) + "`;"
        truncated = flow_label(long_text)
        self.assertLessEqual(len(truncated), FLOW_LABEL_MAX_CHARS)
        self.assertTrue(truncated.endswith("…"))

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            huge_html = "".join(f"<article data-idx='{i}'>Tarjeta {i}</article>\\n" for i in range(25))
            _write_tree(
                root,
                {
                    "js/gallery.js": f"""
                    export function renderGalleryCards(body) {{
                      body.innerHTML = `{huge_html}`;
                      return body;
                    }}
                    """,
                },
            )
            graph = _build_project_graph(root)
            fn = _node_map(graph)["js/gallery.js::renderGalleryCards"]
            html_step = next(s for s in fn["internal_flow"] if "body.innerHTML" in s["label"])
            self.assertLessEqual(len(html_step["label"]), FLOW_LABEL_MAX_CHARS)
            self.assertTrue(html_step["label"].endswith("…"))
            self.assertGreater(len(html_step["code"]), 400)
            self.assertIn("Tarjeta 24", html_step["code"])

    def test_internal_helpers_are_not_marked_as_event_handlers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_tree(
                root,
                {
                    "js/ui.js": """
                    export function renderCards() {
                      return 1;
                    }

                    export function triggerExport() {
                      return 2;
                    }

                    export function handleUpload() {
                      return 3;
                    }

                    export function bindCompositeFilterControl(input, btnExport) {
                      function syncDOM() {
                        return input.value;
                      }
                      syncDOM();
                      input.addEventListener('change', () => {
                        syncDOM();
                        renderCards();
                      });
                      btnExport.addEventListener('click', () => triggerExport());
                    }

                    export function setupDropZone(zone) {
                      function setDropHighlight(active) {
                        zone.classList.toggle('active', active);
                      }
                      zone.addEventListener('dragover', (e) => {
                        e.preventDefault();
                        setDropHighlight(true);
                      });
                      zone.addEventListener('dragleave', () => setDropHighlight(false));
                      zone.addEventListener('drop', handleUpload);
                    }

                    export function initApp(input, btnExport, zone) {
                      renderCards();
                      bindCompositeFilterControl(input, btnExport);
                      setupDropZone(zone);
                    }
                    initApp(null, null, null);
                    """,
                },
            )
            graph = _build_project_graph(root)
            nodes = _node_map(graph)

            # Helpers locales anidados NO deben marcarse como event_handler.
            sync_dom = nodes["js/ui.js::bindCompositeFilterControl.syncDOM"]
            self.assertFalse(sync_dom["is_event_handler"])
            self.assertIsNone(sync_dom["entry_kind"])

            set_drop = nodes["js/ui.js::setupDropZone.setDropHighlight"]
            self.assertFalse(set_drop["is_event_handler"])
            self.assertIsNone(set_drop["entry_kind"])

            # Helper compartido invocado directamente en initApp tampoco debe ser event_handler.
            render_cards = nodes["js/ui.js::renderCards"]
            self.assertFalse(render_cards["is_event_handler"])
            self.assertIsNone(render_cards["entry_kind"])

            # Handlers reales SÍ se marcan como event_handler.
            self.assertTrue(nodes["js/ui.js::handleUpload"]["is_event_handler"])
            self.assertEqual(nodes["js/ui.js::handleUpload"]["entry_kind"], ENTRY_KIND_EVENT)
            self.assertTrue(nodes["js/ui.js::triggerExport"]["is_event_handler"])
            self.assertEqual(nodes["js/ui.js::triggerExport"]["entry_kind"], ENTRY_KIND_EVENT)

            # Los helpers internos no deben contaminar execution_flows como raíces feature.
            feature_roots = {f["root_id"] for f in graph["execution_flows"] if f["kind"] == "feature"}
            self.assertNotIn("js/ui.js::bindCompositeFilterControl.syncDOM", feature_roots)
            self.assertNotIn("js/ui.js::setupDropZone.setDropHighlight", feature_roots)
            self.assertNotIn("js/ui.js::renderCards", feature_roots)
            self.assertIn("js/ui.js::handleUpload", feature_roots)
            self.assertIn("js/ui.js::triggerExport", feature_roots)

    def test_canvas_2d_methods_not_classified_as_array_prototype(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_tree(
                root,
                {
                    "js/draw.js": """
                    export function drawBadge(canvas, items) {
                      const ctx = canvas.getContext('2d');
                      ctx.beginPath();
                      ctx.arc(10, 10, 5, 0, Math.PI * 2);
                      ctx.fill();
                      const previewUrl = canvas.toDataURL('image/png');
                      const filled = items.fill(0);
                      return [previewUrl, filled];
                    }
                    """,
                },
            )
            graph = _build_project_graph(root)
            fn = _node_map(graph)["js/draw.js::drawBadge"]
            by_expr = {c["call_expr"]: c for c in fn["external_calls"]}

            self.assertEqual(by_expr["ctx.fill"]["api_id"], "js:CanvasRenderingContext2D.fill")
            self.assertEqual(by_expr["ctx.fill"]["module"], "Canvas 2D")
            self.assertEqual(by_expr["ctx.beginPath"]["api_id"], "js:CanvasRenderingContext2D.beginPath")
            self.assertEqual(by_expr["canvas.getContext"]["api_id"], "js:HTMLCanvasElement.getContext")
            self.assertEqual(by_expr["canvas.toDataURL"]["api_id"], "js:HTMLCanvasElement.toDataURL")
            # Un arreglo genuino sigue clasificándose como Array.prototype.fill.
            self.assertEqual(by_expr["items.fill"]["api_id"], "js:Array.prototype.fill")

    def test_module_callbacks_are_not_unreferenced_and_expose_context_hook(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_tree(
                root,
                {
                    "server.js": """
                    const http = require('http');
                    const PORT = 3000;
                    const server = http.createServer((req, res) => {
                      res.end('ok');
                    });

                    server.on('error', (err) => {
                      console.error(err);
                    });

                    setTimeout(() => {
                      console.log('warmup');
                    }, 500);

                    server.listen(PORT, () => {
                      console.log('ready on ' + PORT);
                    });
                    """,
                },
            )
            graph = _build_project_graph(root)
            nodes = _node_map(graph)

            listen_node = next(n for nid, n in nodes.items() if "server.listen(PORT)@L" in nid)
            self.assertEqual(listen_node["entry_kind"], ENTRY_KIND_MAIN)
            self.assertTrue(listen_node["is_main_entry"])
            self.assertFalse(listen_node["is_unreferenced"])
            self.assertEqual(listen_node["role"], ROLE_ENTRY)

            # Paso inicial `⚡ Hook:` antes de `in: ∅` en Nivel 3+.
            flow = listen_node["internal_flow"]
            self.assertGreaterEqual(len(flow), 3)
            self.assertEqual(flow[0]["kind"], "event")
            self.assertEqual(flow[0]["role"], ROLE_ENTRY)
            self.assertIn("⚡ Hook: server.listen(PORT, <callback>)", flow[0]["label"])
            self.assertEqual(flow[1]["label"], "in: ∅")
            self.assertEqual(flow[0]["edges"][0]["target"], flow[1]["id"])

            # `server.on('error', ...)` es event_handler, nunca unreferenced.
            err_node = next(n for nid, n in nodes.items() if "server.on[error]@L" in nid)
            self.assertEqual(err_node["entry_kind"], ENTRY_KIND_EVENT)
            self.assertFalse(err_node["is_unreferenced"])

            # `createServer` sigue siendo route_handler.
            req_node = next(n for nid, n in nodes.items() if "http.createServer@L" in nid)
            self.assertEqual(req_node["entry_kind"], ENTRY_KIND_ROUTE)
            self.assertFalse(req_node["is_unreferenced"])

            # `setTimeout` a nivel de módulo nunca queda como unreferenced.
            timer_node = next(n for nid, n in nodes.items() if "setTimeout(500)@L" in nid)
            self.assertFalse(timer_node["is_unreferenced"])

            # Estabilidad de fingerprint: una nota guardada bajo el ID antiguo sin `(PORT)` migra automáticamente.
            with mock.patch("codemap.paths.storage_root", return_value=root / "_fake_cache"):
                old_id = listen_node["id"].replace("(PORT)", "")
                target = normalize_path(root)
                save_notes(
                    target,
                    {
                        "nodes": {
                            old_id: {
                                "note": "Arranca el servidor HTTP local",
                                "pinned": False,
                                "x": None,
                                "y": None,
                                "pinned_positions": {},
                                "custom_role": None,
                                "last_fingerprint": listen_node["fingerprint"],
                            }
                        },
                        "orphans": [],
                    },
                )
                reconciled = reconcile_notes(target, graph)
                self.assertIn(listen_node["id"], reconciled["nodes"])
                self.assertEqual(
                    reconciled["nodes"][listen_node["id"]]["note"],
                    "Arranca el servidor HTTP local",
                )
                self.assertEqual(reconciled["orphans"], [])

    def test_distinguish_event_listeners_from_loops_in_level_3_plus_js_and_python(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_tree(
                root,
                {
                    "js/events.js": """
                    export function wireUI(items, subscribeState, openGallery) {
                      document.getElementById('viewGalleryBtn')?.addEventListener('click', () => {
                        openGallery();
                      });
                      document.querySelector('.filter-input')?.addEventListener('change', (ev) => {
                        console.log(ev.target);
                      });
                      subscribeState((state) => {
                        console.log(state);
                      });
                      const names = items.map((item) => item.name);
                      return names;
                    }
                    """,
                    "py/events.py": """
                    def wire_py(btn, subscribe_state, items):
                        btn.connect(lambda: save_now())
                        subscribe_state(lambda st: refresh(st))
                        ordered = sorted(items, key=lambda x: x.id)
                        return ordered
                    """,
                },
            )
            graph = _build_project_graph(root)
            nodes = _node_map(graph)

            js_flow = nodes["js/events.js::wireUI"]["internal_flow"]
            gallery_step = next(s for s in js_flow if "#viewGalleryBtn" in s["label"])
            self.assertEqual(gallery_step["kind"], "event")
            self.assertTrue(gallery_step["label"].startswith("⚡ click · #viewGalleryBtn"))
            self.assertNotIn("🔁", gallery_step["label"])
            self.assertNotIn("∅", gallery_step["label"])

            filter_step = next(s for s in js_flow if ".filter-input" in s["label"])
            self.assertEqual(filter_step["kind"], "event")
            self.assertEqual(filter_step["label"], "⚡ change · .filter-input(ev)")

            sub_step = next(s for s in js_flow if s["is_container"] and "subscribeState" in s["label"])
            self.assertEqual(sub_step["kind"], "event")
            self.assertTrue(sub_step["label"].startswith("⚡ subscribeState(state)"))

            map_step = next(s for s in js_flow if s["is_container"] and ".map(" in s["label"])
            self.assertEqual(map_step["kind"], "loop")
            self.assertTrue(map_step["label"].startswith("🔁 "))

            py_flow = nodes["py/events.py::wire_py"]["internal_flow"]
            py_connect = next(s for s in py_flow if s["is_container"] and "btn.connect" in s["label"])
            self.assertEqual(py_connect["kind"], "event")
            self.assertTrue(py_connect["label"].startswith("⚡ "))

            py_sub = next(s for s in py_flow if s["is_container"] and "subscribe_state" in s["label"])
            self.assertEqual(py_sub["kind"], "event")
            self.assertTrue(py_sub["label"].startswith("⚡ "))

            py_sort = next(s for s in py_flow if s["is_container"] and "sorted(" in s["label"])
            self.assertEqual(py_sort["kind"], "loop")
            self.assertTrue(py_sort["label"].startswith("🔁 "))


class TestStage1AiExportAndCli(unittest.TestCase):
    def test_build_ai_graph_and_markdown_compactness_and_validity(self) -> None:
        multi_dir = REPO_ROOT / "examples" / "multi"
        graph = _build_project_graph(multi_dir)

        raw_json = json.dumps(graph, indent=2, ensure_ascii=False)
        compact_json = serialize_ai_graph(graph, include_flow=False)
        parsed = json.loads(compact_json)

        # Minificado sin saltos de línea ni sangría y reducción fuerte de peso.
        self.assertNotIn("\n", compact_json)
        self.assertLess(len(compact_json), len(raw_json) * 0.45)

        # Verifica poda de claves prohibidas/neutras en nodos y APIs externas.
        self.assertNotIn("root_path", parsed["meta"])
        for node in parsed["nodes"]:
            self.assertNotIn("file_path", node)
            self.assertNotIn("fingerprint", node)
            self.assertNotIn("internal_flow", node)
            for value in node.values():
                self.assertIsNot(value, None)
                self.assertIsNot(value, False)
                self.assertNotEqual(value, "")
                self.assertNotEqual(value, [])
            for ext in node.get("external_calls", []):
                self.assertNotIn("docs_url", ext)
                self.assertNotIn("api_id", ext)

        # Con include_flow=True se incluye internal_flow podado (sin `code` cuando code == label).
        with_flow = build_ai_graph(graph, include_flow=True)
        fn_with_flow = next(n for n in with_flow["nodes"] if n.get("internal_flow"))
        self.assertTrue(fn_with_flow["internal_flow"])
        for step in fn_with_flow["internal_flow"]:
            if "code" in step:
                self.assertNotEqual(step["code"], step["label"])

        # Markdown estructurado con Mermaid, puntos de entrada, hilos y mapa por archivo.
        md = build_ai_markdown(graph, include_flow=False)
        self.assertIn("# CodeMap — multi", md)
        self.assertIn("```mermaid\nflowchart LR", md)
        self.assertIn("## Puntos de Entrada", md)
        self.assertIn("## Hilos de Ejecución", md)
        self.assertIn("## Mapa por Archivo", md)
        self.assertIn("### `backend/app.py`", md)

        md_flow = build_ai_markdown(graph, include_flow=True)
        self.assertIn("Flujo interno:", md_flow)
        self.assertGreater(len(md_flow), len(md))

    def test_cli_export_subprocess_stdout_out_and_zero_intrusion(self) -> None:
        multi_dir = REPO_ROOT / "examples" / "multi"
        before_files = sorted(p.relative_to(multi_dir).as_posix() for p in multi_dir.rglob("*"))

        with tempfile.TemporaryDirectory() as tmp:
            fake_cache = Path(tmp) / "codemap_cache"
            env = {
                **os.environ,
                "PYTHONIOENCODING": "utf-8",
            }

            # 1. --format json --stdout
            proc_json = subprocess.run(
                [sys.executable, "-m", "codemap", "export", str(multi_dir), "--format", "json", "--stdout"],
                cwd=str(REPO_ROOT),
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=True,
            )
            exported_obj = json.loads(proc_json.stdout)
            self.assertEqual(exported_obj["meta"]["project_name"], "multi")
            self.assertTrue(exported_obj["nodes"])

            # 2. --format md --out <ruta>
            out_md = Path(tmp) / "exports" / "summary.md"
            proc_md = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "codemap",
                    "export",
                    str(multi_dir),
                    "--format",
                    "md",
                    "--out",
                    str(out_md),
                ],
                cwd=str(REPO_ROOT),
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=True,
            )
            self.assertEqual(proc_md.returncode, 0)
            self.assertTrue(out_md.is_file())
            md_content = out_md.read_text(encoding="utf-8")
            self.assertIn("```mermaid", md_content)

            # 3. Sin --out ni --stdout: escribe en ~/.codemap/<hash>/graph.ai.json (cero intrusión).
            with mock.patch("codemap.paths.storage_root", return_value=fake_cache):
                exit_code = cli_main(["export", str(multi_dir), "--format", "json"])
                self.assertEqual(exit_code, 0)
            ai_files = list(fake_cache.rglob("graph.ai.json"))
            self.assertEqual(len(ai_files), 1)
            self.assertTrue(json.loads(ai_files[0].read_text(encoding="utf-8"))["nodes"])

        after_files = sorted(p.relative_to(multi_dir).as_posix() for p in multi_dir.rglob("*"))
        self.assertEqual(before_files, after_files)

    def test_server_ai_export_endpoints(self) -> None:
        multi_dir = REPO_ROOT / "examples" / "multi"
        graph = _build_project_graph(multi_dir)

        async def _verify() -> None:
            app = create_app(normalize_path(multi_dir), graph)
            async with TestClient(TestServer(app)) as client:
                resp_json = await client.get("/export.ai.json")
                self.assertEqual(resp_json.status, 200)
                self.assertIn("application/json", resp_json.headers["Content-Type"])
                self.assertIn("X-CodeMap-Raw-Bytes", resp_json.headers)
                data = json.loads(await resp_json.text())
                self.assertTrue(all("internal_flow" not in n for n in data["nodes"]))

                resp_flow = await client.get("/export.ai.json?include_flow=1")
                self.assertEqual(resp_flow.status, 200)
                data_flow = json.loads(await resp_flow.text())
                self.assertTrue(any(n.get("internal_flow") for n in data_flow["nodes"]))

                resp_md = await client.get("/export.ai.md")
                self.assertEqual(resp_md.status, 200)
                self.assertIn("text/markdown", resp_md.headers["Content-Type"])
                md_text = await resp_md.text()
                self.assertIn("```mermaid", md_text)

        asyncio.run(_verify())


if __name__ == "__main__":
    unittest.main()
