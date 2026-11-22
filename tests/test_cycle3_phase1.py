"""Pruebas unitarias de la Fase 1 (Ciclo 3): seguridad/fiabilidad del backend y docstrings de archivo."""

from __future__ import annotations

import asyncio
import io
import json
import math
import tempfile
import textwrap
import threading
import unittest
from pathlib import Path
from unittest import mock

import aiohttp
from aiohttp.test_utils import TestClient, TestServer

from codemap.discovery import discover_files
from codemap.exporter import build_ai_graph, build_ai_markdown
from codemap.graph_builder import build_graph
from codemap.known_apis_storage import load_known_apis, sanitize_docs_url, update_known_apis
from codemap.notes_storage import load_notes, normalize_node_entry, update_notes
from codemap.parsers import parse_file
from codemap.paths import atomic_write_text, normalize_path, project_hash
from codemap.server import create_app, rebuild_and_broadcast
from codemap.storage import clean_orphan_projects, register_project
from codemap.watcher import DebouncedRebuildHandler

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


class TestCycle3Phase1SecurityAndReliability(unittest.TestCase):
    def test_server_host_and_origin_validation_http_and_ws(self) -> None:
        multi_dir = REPO_ROOT / "examples" / "multi"
        graph = _build_project_graph(multi_dir)

        async def _verify() -> None:
            with tempfile.TemporaryDirectory() as tmp:
                fake_cache = Path(tmp) / "cache"
                with mock.patch("codemap.paths.storage_root", return_value=fake_cache):
                    app = create_app(normalize_path(multi_dir), graph)
                    async with TestClient(TestServer(app)) as client:
                        port = client.server.port

                        # Hosts loopback válidos en el puerto asignado.
                        for host in (f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"):
                            resp = await client.get("/graph.json", headers={"Host": host})
                            self.assertEqual(resp.status, 200, f"Host válido rechazado: {host}")

                        # Origins loopback válidos en el puerto asignado.
                        for origin in (
                            f"http://127.0.0.1:{port}",
                            f"http://localhost:{port}",
                            f"http://[::1]:{port}",
                        ):
                            resp = await client.get("/graph.json", headers={"Origin": origin})
                            self.assertEqual(resp.status, 200, f"Origin válido rechazado: {origin}")

                        # Hosts externos, malformados o con puerto incorrecto -> 403.
                        for bad_host in (
                            f"evil.com:{port}",
                            f"127.0.0.1.evil.com:{port}",
                            f"127.0.0.1@evil.com:{port}",
                            "127.0.0.1:9999",
                            "localhost",
                            "127.0.0.1:notaport",
                        ):
                            resp = await client.get("/graph.json", headers={"Host": bad_host})
                            self.assertEqual(resp.status, 403, f"Host inválido aceptado: {bad_host}")

                        # Origins externos, null o con puerto distinto -> 403 en GET y POST.
                        for bad_origin in (
                            "https://evil.com",
                            f"http://evil.com:{port}",
                            "null",
                            "http://127.0.0.1:9999",
                            f"javascript://127.0.0.1:{port}",
                        ):
                            resp_get = await client.get("/graph.json", headers={"Origin": bad_origin})
                            self.assertEqual(resp_get.status, 403, f"Origin inválido aceptado en GET: {bad_origin}")

                            resp_post = await client.post(
                                "/notes.json",
                                json={"nodes": {}},
                                headers={"Origin": bad_origin},
                            )
                            self.assertEqual(resp_post.status, 403, f"Origin inválido aceptado en POST: {bad_origin}")

                        # WebSocket: origen legítimo permitido, origen externo bloqueado con 403.
                        async with client.ws_connect("/ws", headers={"Origin": f"http://localhost:{port}"}) as ws:
                            init_msg = await ws.receive_json()
                            self.assertEqual(init_msg["type"], "init")

                        with self.assertRaises(aiohttp.WSServerHandshakeError) as ctx:
                            await client.ws_connect("/ws", headers={"Origin": "https://evil.example"})
                        self.assertEqual(ctx.exception.status, 403)

        asyncio.run(_verify())

    def test_post_notes_and_ws_notes_broadcast_to_all_clients(self) -> None:
        multi_dir = REPO_ROOT / "examples" / "multi"
        graph = _build_project_graph(multi_dir)

        async def _verify() -> None:
            with tempfile.TemporaryDirectory() as tmp:
                fake_cache = Path(tmp) / "cache"
                with mock.patch("codemap.paths.storage_root", return_value=fake_cache):
                    app = create_app(normalize_path(multi_dir), graph)
                    async with TestClient(TestServer(app)) as client:
                        async with client.ws_connect("/ws") as ws1, client.ws_connect("/ws") as ws2:
                            self.assertEqual((await ws1.receive_json())["type"], "init")
                            self.assertEqual((await ws2.receive_json())["type"], "init")

                            resp = await client.post(
                                "/notes.json",
                                json={"nodes": {"backend/app.py::main": {"note": "Nota HTTP"}}},
                            )
                            self.assertEqual(resp.status, 200)

                            msg1 = await ws1.receive_json()
                            msg2 = await ws2.receive_json()
                            self.assertEqual(msg1["type"], "notes_updated")
                            self.assertEqual(msg2["type"], "notes_updated")
                            self.assertEqual(msg1["notes"]["nodes"]["backend/app.py::main"]["note"], "Nota HTTP")
                            self.assertEqual(msg2["notes"]["nodes"]["backend/app.py::main"]["note"], "Nota HTTP")

                            # Guardado vía WS en ws1 también se propaga a ws2.
                            await ws1.send_json(
                                {
                                    "type": "save_notes",
                                    "payload": {"nodes": {"backend/app.py::main": {"note": "Nota WS"}}},
                                }
                            )
                            ws1_reply = await ws1.receive_json()
                            ws2_reply = await ws2.receive_json()
                            self.assertEqual(ws1_reply["notes"]["nodes"]["backend/app.py::main"]["note"], "Nota WS")
                            self.assertEqual(ws2_reply["notes"]["nodes"]["backend/app.py::main"]["note"], "Nota WS")

        asyncio.run(_verify())

    def test_rebuild_and_broadcast_handles_errors_cleanly(self) -> None:
        multi_dir = REPO_ROOT / "examples" / "multi"
        graph = _build_project_graph(multi_dir)

        def _failing_rebuild() -> tuple[dict, dict]:
            raise RuntimeError("fallo simulado de disco")

        async def _verify() -> None:
            app = create_app(normalize_path(multi_dir), graph, rebuild_fn=_failing_rebuild)
            stderr_buf = io.StringIO()
            with mock.patch("sys.stderr", stderr_buf):
                await rebuild_and_broadcast(app)
            self.assertIn("fallo simulado de disco", stderr_buf.getvalue())
            self.assertEqual(app["graph"] if "graph" in app else graph, graph)

        asyncio.run(_verify())

    def test_watcher_tracks_and_cleans_up_rebuild_tasks_safely(self) -> None:
        async def _verify() -> None:
            loop = asyncio.get_running_loop()
            ran = asyncio.Event()

            async def _failing_cb() -> None:
                ran.set()
                raise ValueError("error controlado del watcher")

            with tempfile.TemporaryDirectory() as tmp:
                handler = DebouncedRebuildHandler(
                    target=Path(tmp),
                    is_single_file=False,
                    loop=loop,
                    on_rebuild=_failing_cb,
                    debounce_seconds=0.01,
                )
                stderr_buf = io.StringIO()
                with mock.patch("sys.stderr", stderr_buf):
                    handler._trigger_rebuild()  # noqa: SLF001
                    self.assertEqual(len(handler._tasks), 1)  # noqa: SLF001
                    await ran.wait()
                    await asyncio.sleep(0.02)
                self.assertEqual(len(handler._tasks), 0)  # noqa: SLF001
                self.assertIn("error controlado del watcher", stderr_buf.getvalue())

        asyncio.run(_verify())

    def test_known_apis_sanitizes_docs_url_schemes(self) -> None:
        self.assertEqual(sanitize_docs_url("https://docs.python.org/3/"), "https://docs.python.org/3/")
        self.assertEqual(sanitize_docs_url("http://localhost:8080/docs"), "http://localhost:8080/docs")
        self.assertEqual(sanitize_docs_url("javascript:alert(1)"), "")
        self.assertEqual(sanitize_docs_url("JAVASCRIPT:alert(1)"), "")
        self.assertEqual(sanitize_docs_url("data:text/html,<script>alert(1)</script>"), "")
        self.assertEqual(sanitize_docs_url("file:///C:/Windows/win.ini"), "")
        self.assertEqual(sanitize_docs_url("https://"), "")

        with tempfile.TemporaryDirectory() as tmp:
            fake_cache = Path(tmp) / "cache"
            with mock.patch("codemap.paths.storage_root", return_value=fake_cache):
                update_known_apis(
                    {
                        "action": "mark",
                        "apis": [
                            {
                                "api_id": "js:evil",
                                "symbol": "evil",
                                "docs_url": "javascript:alert(document.domain)",
                            },
                            {
                                "api_id": "py:json.loads",
                                "symbol": "json.loads",
                                "docs_url": "https://docs.python.org/3/library/json.html",
                            },
                        ],
                    }
                )
                loaded = load_known_apis()
                self.assertTrue((fake_cache / "known_apis.json").is_file())
                self.assertEqual(loaded["known"]["js:evil"]["docs_url"], "")
                self.assertEqual(
                    loaded["known"]["py:json.loads"]["docs_url"],
                    "https://docs.python.org/3/library/json.html",
                )

    def test_notes_storage_rejects_bool_nan_inf_and_supports_creation_keys(self) -> None:
        normalized = normalize_node_entry(
            {
                "note": "hola",
                "pinned": True,
                "x": True,
                "y": float("nan"),
                "pinned_positions": {
                    "functions": {"x": 10.5, "y": -20},
                    "creation_functions": {"x": 42, "y": 84.5},
                    "creation_layers_files": {"x": 100, "y": 200},
                    "creation_modules": {"x": float("inf"), "y": 10},
                    "creation_files": {"x": False, "y": 10},
                    "invalid_key": {"x": 1, "y": 2},
                },
            }
        )
        self.assertIsNone(normalized["x"])
        self.assertIsNone(normalized["y"])
        self.assertEqual(
            normalized["pinned_positions"],
            {
                "functions": {"x": 10.5, "y": -20.0},
                "creation_functions": {"x": 42.0, "y": 84.5},
                "creation_layers_files": {"x": 100.0, "y": 200.0},
            },
        )
        self.assertFalse(any(math.isnan(v["x"]) for v in normalized["pinned_positions"].values()))

        # Persistencia concurrente segura y atómica.
        with tempfile.TemporaryDirectory() as tmp:
            fake_cache = Path(tmp) / "cache"
            target = normalize_path(Path(tmp) / "proj")
            graph = {"nodes": [{"id": f"f.py::fn{i}", "fingerprint": f"fp{i}"} for i in range(8)]}
            with mock.patch("codemap.paths.storage_root", return_value=fake_cache):
                errors: list[Exception] = []

                def _worker(idx: int) -> None:
                    try:
                        update_notes(
                            target,
                            {
                                "nodes": {
                                    f"f.py::fn{idx}": {
                                        "note": f"nota {idx}",
                                        "pinned_positions": {"creation_functions": {"x": idx * 10, "y": idx * 20}},
                                    }
                                }
                            },
                            graph,
                        )
                    except Exception as exc:  # noqa: BLE001
                        errors.append(exc)

                threads = [threading.Thread(target=_worker, args=(i,)) for i in range(8)]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join()

                self.assertEqual(errors, [])
                loaded = load_notes(target)
                for i in range(8):
                    self.assertEqual(loaded["nodes"][f"f.py::fn{i}"]["note"], f"nota {i}")
                    self.assertEqual(
                        loaded["nodes"][f"f.py::fn{i}"]["pinned_positions"]["creation_functions"],
                        {"x": float(i * 10), "y": float(i * 20)},
                    )

    def test_clean_orphan_projects_rejects_path_traversal_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            fake_cache = base / "cache"
            victim_dir = base / "victim_do_not_delete"
            victim_dir.mkdir(parents=True)
            (victim_dir / "keep.txt").write_text("safe", encoding="utf-8")

            missing_proj = base / "deleted_project"
            valid_key = project_hash(normalize_path(missing_proj))

            with mock.patch("codemap.paths.storage_root", return_value=fake_cache):
                register_project(
                    normalize_path(missing_proj),
                    {
                        "project_name": "deleted_project",
                        "generated_at": "2026-11-22T00:00:00Z",
                    },
                )
                valid_cache_dir = fake_cache / valid_key
                valid_cache_dir.mkdir(parents=True, exist_ok=True)
                (valid_cache_dir / "graph.json").write_text("{}", encoding="utf-8")

                # Inyectar una clave maliciosa en index.json apuntando fuera de cache.
                index_file = fake_cache / "index.json"
                index_data = json.loads(index_file.read_text(encoding="utf-8"))
                index_data["projects"]["../victim_do_not_delete"] = {
                    "root_path": str(base / "nonexistent"),
                    "project_name": "evil",
                    "last_generated": "2026-11-22T00:00:00Z",
                }
                atomic_write_text(index_file, json.dumps(index_data), encoding="utf-8")

                removed = clean_orphan_projects()

                # La carpeta externa víctima permanece intacta y solo el proyecto huérfano válido se limpia.
                self.assertTrue(victim_dir.is_dir())
                self.assertTrue((victim_dir / "keep.txt").is_file())
                self.assertFalse(valid_cache_dir.exists())
                self.assertEqual(removed, [normalize_path(missing_proj)])
                cleaned_index = json.loads(index_file.read_text(encoding="utf-8"))
                self.assertNotIn("../victim_do_not_delete", cleaned_index["projects"])


class TestCycle3Phase1FileDocstrings(unittest.TestCase):
    def test_python_module_docstrings_extracted_with_and_without_headers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_tree(
                root,
                {
                    "with_shebang.py": """
                    #!/usr/bin/env python3
                    # -*- coding: utf-8 -*-
                    \"\"\"Módulo principal con shebang.

                    Descripción detallada en segunda línea.
                    \"\"\"

                    def run():
                        return 1
                    """,
                    "no_doc.py": """
                    # Solo un comentario
                    import os

                    def helper():
                        \"\"\"Doc de función, no de archivo.\"\"\"
                        return os.name
                    """,
                },
            )
            graph = _build_project_graph(root)
            nodes = _node_map(graph)

            self.assertEqual(
                nodes["with_shebang.py"]["docstring"],
                "Módulo principal con shebang.\n\nDescripción detallada en segunda línea.",
            )
            self.assertEqual(nodes["no_doc.py"]["docstring"], "")
            self.assertEqual(nodes["no_doc.py::helper"]["docstring"], "Doc de función, no de archivo.")

    def test_js_ts_file_docstrings_do_not_steal_first_function_jsdoc(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_tree(
                root,
                {
                    "before_import.js": """
                    /**
                     * Cliente HTTP para recursos de usuarios.
                     */
                    import { helper } from './helper.js';

                    /** Obtiene la lista de usuarios. */
                    export function getUsers() {
                      return helper();
                    }
                    """,
                    "block_header.js": """
                    /* Motor de renderizado del lienzo.
                     * Maneja zoom y paneo.
                     */

                    export function initCanvas() {
                      return true;
                    }
                    """,
                    "file_tag.js": """
                    /**
                     * @file Utilidades matemáticas del dominio.
                     */
                    export function sum(a, b) {
                      return a + b;
                    }
                    """,
                    "blank_line_header.ts": """
                    /**
                     * Módulo de tipos y validadores TS.
                     */

                    export function validateId(id: string): boolean {
                      return id.length > 0;
                    }
                    """,
                    "attached_fn_jsdoc.js": """
                    /** Nombre completo con mayúscula inicial. */
                    export const formatName = (u) => u.first;
                    """,
                    "pragma_and_doc.js": """
                    #!/usr/bin/env node
                    /* eslint-disable no-console */
                    /**
                     * Script CLI de mantenimiento.
                     */
                    console.log('ready');
                    export function runTask() {
                      return 1;
                    }
                    """,
                    "only_pragma.js": """
                    /* eslint-disable no-unused-vars */
                    export function noop() {}
                    """,
                },
            )
            graph = _build_project_graph(root)
            nodes = _node_map(graph)

            self.assertEqual(nodes["before_import.js"]["docstring"], "Cliente HTTP para recursos de usuarios.")
            self.assertEqual(nodes["before_import.js::getUsers"]["docstring"], "Obtiene la lista de usuarios.")

            self.assertEqual(
                nodes["block_header.js"]["docstring"],
                "Motor de renderizado del lienzo.\nManeja zoom y paneo.",
            )
            self.assertEqual(nodes["block_header.js::initCanvas"]["docstring"], "")

            # `@file` pegado a la función pertenece al archivo y NO se duplica en la función.
            self.assertEqual(nodes["file_tag.js"]["docstring"], "Utilidades matemáticas del dominio.")
            self.assertEqual(nodes["file_tag.js::sum"]["docstring"], "")

            # Separado por línea en blanco pertenece al archivo y NO se duplica en la función.
            self.assertEqual(nodes["blank_line_header.ts"]["docstring"], "Módulo de tipos y validadores TS.")
            self.assertEqual(nodes["blank_line_header.ts::validateId"]["docstring"], "")

            # JSDoc pegado a la función sin `@file` pertenece a la función, NO al archivo.
            self.assertEqual(nodes["attached_fn_jsdoc.js"]["docstring"], "")
            self.assertEqual(
                nodes["attached_fn_jsdoc.js::formatName"]["docstring"],
                "Nombre completo con mayúscula inicial.",
            )

            # Shebang + pragma eslint ignorados; se extrae el docstring real.
            self.assertEqual(nodes["pragma_and_doc.js"]["docstring"], "Script CLI de mantenimiento.")
            self.assertEqual(nodes["only_pragma.js"]["docstring"], "")

    def test_examples_multi_docstrings_exposed_in_graph_and_ai_exporter(self) -> None:
        multi_dir = REPO_ROOT / "examples" / "multi"
        graph = _build_project_graph(multi_dir)
        nodes = _node_map(graph)

        # Archivos Python con docstring de módulo real.
        self.assertEqual(nodes["backend/app.py"]["docstring"], "Punto de entrada del backend de ejemplo.")
        self.assertEqual(
            nodes["backend/services/users.py"]["docstring"],
            "Servicio de usuarios con acceso a datos.",
        )

        # format.js solo tiene JSDoc de formatName: no debe robarse como docstring del archivo.
        self.assertEqual(nodes["frontend/src/format.js"]["docstring"], "")
        self.assertEqual(
            nodes["frontend/src/format.js::formatName"]["docstring"],
            "Nombre completo con mayúscula inicial.",
        )

        # Exportador IA (JSON + Markdown): incluye docstrings de archivo cuando existen y poda vacíos.
        ai_graph = build_ai_graph(graph, include_flow=False)
        ai_nodes = _node_map(ai_graph)
        self.assertEqual(
            ai_nodes["backend/services/users.py"]["docstring"],
            "Servicio de usuarios con acceso a datos.",
        )
        self.assertNotIn("docstring", ai_nodes["frontend/src/format.js"])

        md = build_ai_markdown(graph, include_flow=False)
        self.assertIn("> Punto de entrada del backend de ejemplo.", md)
        self.assertIn("> Servicio de usuarios con acceso a datos.", md)


if __name__ == "__main__":
    unittest.main()
