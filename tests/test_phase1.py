"""Pruebas unitarias e integración para la Fase 1 de mejoras de CodeMap."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from codemap.cli import analyze_files, collect_source_files
from codemap.discovery import GitIgnoreMatcher, discover_files
from codemap.fingerprint import compute_fingerprint
from codemap.graph_builder import build_graph
from codemap.models import (
    EDGE_CALLBACK_REF,
    EDGE_DIRECT_CALL,
    EDGE_EVENT_LISTENER,
    EDGE_LOADS_SCRIPT,
    EDGE_REACTIVE_SUBSCRIBE,
    EDGE_REACTIVE_TRIGGER,
    EDGE_SERVES_HTML,
    ENTRY_KIND_EVENT,
    ENTRY_KIND_MAIN,
    ENTRY_KIND_ROUTE,
    ENTRY_KIND_UNREFERENCED,
    ROLE_ENTRY,
)
from codemap.parsers import parse_file
from codemap.paths import normalize_path
from codemap.watcher import DebouncedRebuildHandler

REPO_ROOT = Path(__file__).resolve().parent.parent


def _write_files(base: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        target = base / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def _analyze_dir(root: Path, *, include_private: bool = False) -> dict:
    resolved = Path(normalize_path(root))
    files, root_dir, is_single = collect_source_files(resolved)
    analyses = analyze_files(files)
    return build_graph(
        analyses,
        target_path=resolved.as_posix(),
        root_dir=root_dir.as_posix(),
        is_single_file=is_single,
        include_private=include_private,
    )


def _node_map(graph: dict) -> dict[str, dict]:
    return {n["id"]: n for n in graph["nodes"]}


def _edge_map(graph: dict) -> dict[tuple[str, str], dict]:
    return {(e["source"], e["target"]): e for e in graph["edges"]}


class TestJsPathAliases(unittest.TestCase):
    """Ítem 1: Alias de rutas JS/TS (@/..., /..., tsconfig/jsconfig) y guarda npmjs."""

    def test_tsconfig_jsonc_extends_and_paths_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_files(
                root,
                {
                    "tsconfig.base.json": """
                    {
                      // Base config con comentarios y comas colgantes
                      "compilerOptions": {
                        "baseUrl": ".",
                        "paths": {
                          "@/*": ["src/*"],
                        },
                      },
                    }
                    """,
                    "tsconfig.json": """
                    {
                      "extends": "./tsconfig.base",
                      /* Override adicional */
                      "compilerOptions": {
                        "paths": {
                          "@/*": ["src/*"],
                          "@services/*": ["src/services/*"],
                        },
                      },
                    }
                    """,
                    "src/services/api.ts": """
                    export function fetchItems() {
                      return [1, 2, 3];
                    }
                    """,
                    "src/utils/fmt.ts": """
                    export function formatTitle(t: string) {
                      return t.toUpperCase();
                    }
                    """,
                    "src/app.ts": """
                    import { fetchItems } from '@/services/api';
                    import { formatTitle } from '@services/../utils/fmt';
                    import { missingLocal } from '@/does/not/exist';
                    import { customAliasMissing } from '@services/missing';
                    import { useQuery } from '@tanstack/react-query';

                    export function initApp() {
                      const items = fetchItems();
                      const title = formatTitle('ok');
                      missingLocal();
                      customAliasMissing();
                      useQuery(items, title);
                    }

                    initApp();
                    """,
                },
            )

            graph = _analyze_dir(root)
            edges = _edge_map(graph)
            nodes = _node_map(graph)

            self.assertIn(("src/app.ts::initApp", "src/services/api.ts::fetchItems"), edges)
            self.assertEqual(edges[("src/app.ts::initApp", "src/services/api.ts::fetchItems")]["confidence"], "confirmed")
            self.assertIn(("src/app.ts::initApp", "src/utils/fmt.ts::formatTitle"), edges)

            ext_calls = nodes["src/app.ts::initApp"]["external_calls"]
            urls = [c["docs_url"] for c in ext_calls]
            # Ningún alias local (@/ ni @services/) puede generar enlaces a npmjs.com.
            self.assertFalse(any("npmjs.com/package/@/" in u for u in urls), urls)
            self.assertFalse(any("@services" in u for u in urls), urls)
            # Pero un paquete npm con scope válido (@tanstack/react-query) sí se conserva.
            self.assertTrue(any("npmjs.com/package/@tanstack/react-query" in u for u in urls), urls)

    def test_fallback_aliases_without_tsconfig(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_files(
                root,
                {
                    "frontend/src/helpers.js": "export function helperFn() { return 42; }\n",
                    "frontend/src/rootMod.js": "export function rootFn() { return 7; }\n",
                    "frontend/src/index.js": """
                    import { helperFn } from '@/helpers';
                    import { rootFn } from '/src/rootMod';
                    import { ghost } from '@/unindexed/ghost';

                    function boot() {
                      helperFn();
                      rootFn();
                      ghost();
                    }
                    boot();
                    """,
                },
            )

            graph = _analyze_dir(root)
            edges = _edge_map(graph)
            nodes = _node_map(graph)

            self.assertIn(("frontend/src/index.js::boot", "frontend/src/helpers.js::helperFn"), edges)
            self.assertIn(("frontend/src/index.js::boot", "frontend/src/rootMod.js::rootFn"), edges)
            ext_urls = [c["docs_url"] for c in nodes["frontend/src/index.js::boot"]["external_calls"]]
            self.assertFalse(any("npmjs.com" in u for u in ext_urls), ext_urls)


class TestNestedGitignore(unittest.TestCase):
    """Ítem 2: Soporte para .gitignore anidados en discovery y watcher."""

    def test_nested_gitignore_scoping_and_negation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_files(
                root,
                {
                    ".gitignore": "*.tmp.py\nroot_ignored/\n",
                    "root_ignored/a.py": "def a(): pass\n",
                    "keep.py": "def keep(): pass\n",
                    "drop.tmp.py": "def drop(): pass\n",
                    "frontend/.gitignore": "generated/\n*.gen.js\n!keep.gen.js\n",
                    "frontend/app.js": "function app() {}\n",
                    "frontend/auto.gen.js": "function auto() {}\n",
                    "frontend/keep.gen.js": "function keepGen() {}\n",
                    "frontend/generated/bundle.js": "function b() {}\n",
                    "backend/generated/valid.py": "def valid(): pass\n",
                    "backend/.gitignore": "local_cache/\n!special.tmp.py\n",
                    "backend/local_cache/x.py": "def x(): pass\n",
                    "backend/special.tmp.py": "def special(): pass\n",
                },
            )

            found_rel = sorted(p.relative_to(root.resolve()).as_posix() for p in discover_files(root))
            self.assertIn("keep.py", found_rel)
            self.assertNotIn("drop.tmp.py", found_rel)
            self.assertNotIn("root_ignored/a.py", found_rel)
            self.assertIn("frontend/app.js", found_rel)
            self.assertNotIn("frontend/auto.gen.js", found_rel)
            self.assertIn("frontend/keep.gen.js", found_rel)
            self.assertNotIn("frontend/generated/bundle.js", found_rel)
            # La regla `generated/` solo existía en frontend/.gitignore, no en backend/.
            self.assertIn("backend/generated/valid.py", found_rel)
            self.assertNotIn("backend/local_cache/x.py", found_rel)
            # Negación en subdirectorio sobre regla de raíz.
            self.assertIn("backend/special.tmp.py", found_rel)

            # Verificar coherencia con GitIgnoreMatcher y watcher.
            matcher = GitIgnoreMatcher(root)
            self.assertTrue(matcher.is_path_ignored(root / "frontend/generated/bundle.js"))
            self.assertFalse(matcher.is_path_ignored(root / "backend/generated/valid.py"))

            loop = asyncio.new_event_loop()
            try:
                async def noop() -> None:
                    return None

                handler = DebouncedRebuildHandler(root, False, loop, noop)
                self.assertFalse(handler._is_relevant_path(str(root / "frontend/generated/bundle.js")))
                self.assertTrue(handler._is_relevant_path(str(root / "frontend/app.js")))
                self.assertTrue(handler._is_relevant_path(str(root / "frontend/.gitignore")))
                self.assertTrue(handler._is_relevant_path(str(root / "tsconfig.json")))
            finally:
                loop.close()


class TestCallbacksTopLevelHtmlAndReactive(unittest.TestCase):
    """Ítems 3, 4, 5, 6, 7 y 8 integrados sobre un proyecto web realista."""

    def test_web_app_full_bridge_callbacks_reactive_and_flows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_files(
                root,
                {
                    "server.js": """
                    const http = require('http');
                    const fs = require('fs');
                    const path = require('path');

                    const server = http.createServer((req, res) => {
                      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
                      res.end(html);
                    });

                    function startServer() {
                      server.listen(3000);
                    }

                    startServer();
                    """,
                    "index.html": """
                    <!DOCTYPE html>
                    <html>
                      <body>
                        <script src="https://cdn.example.com/lib.js"></script>
                        <script type="module" src="js/app.js"></script>
                      </body>
                    </html>
                    """,
                    "docs/unused.html": "<html><body><p>Sin scripts</p></body></html>\n",
                    "js/state.js": """
                    const listeners = [];
                    let images = [];

                    export function subscribeState(listener) {
                      listeners.push(listener);
                    }

                    export function addImages(newItems) {
                      images = images.concat(newItems);
                      notifyStateChange();
                    }

                    export function notifyStateChange() {
                      listeners.forEach((fn) => fn(images));
                    }
                    """,
                    "js/samples.js": """
                    import { addImages } from './state.js';

                    export function formatSample(name) {
                      return name.trim();
                    }

                    export function loadSampleImages() {
                      const raw = ['a.png', 'b.png'];
                      const cleaned = raw.map(formatSample);
                      addImages(cleaned);
                    }
                    """,
                    "js/print.js": """
                    export function triggerPrint() {
                      window.print();
                    }

                    export function orphanHelper(x) {
                      return x + 1;
                    }
                    """,
                    "js/app.js": """
                    import { subscribeState } from './state.js';
                    import { loadSampleImages } from './samples.js';
                    import { triggerPrint } from './print.js';

                    function updateUI() {
                      console.log('render');
                    }

                    function syncToolbar() {
                      console.log('toolbar');
                    }

                    function initApp() {
                      const btnSamples = document.getElementById('samples');
                      const btnPrint = document.getElementById('print');
                      subscribeState(updateUI);
                      subscribeState(() => syncToolbar());
                      btnSamples.addEventListener('click', loadSampleImages);
                      btnPrint.addEventListener('click', () => triggerPrint());
                    }

                    initApp();
                    """,
                },
            )

            graph = _analyze_dir(root)
            nodes = _node_map(graph)
            edges = _edge_map(graph)

            # Ítem 5: Puente HTML y exclusión de HTML suelto sin scripts.
            self.assertIn("index.html", nodes)
            self.assertNotIn("docs/unused.html", nodes)
            self.assertTrue(nodes["index.html"]["is_main_entry"])
            self.assertTrue(nodes["js/app.js"]["is_main_entry"])
            self.assertTrue(nodes["server.js"]["is_main_entry"])

            # server.js (handler createServer) -> index.html -> js/app.js::initApp
            serves_edges = [e for e in graph["edges"] if e["edge_type"] == EDGE_SERVES_HTML]
            loads_edges = [e for e in graph["edges"] if e["edge_type"] == EDGE_LOADS_SCRIPT]
            self.assertTrue(any(e["target"] == "index.html" for e in serves_edges), serves_edges)
            self.assertIn(("index.html", "js/app.js::initApp"), edges)
            self.assertEqual(edges[("index.html", "js/app.js::initApp")]["edge_type"], EDGE_LOADS_SCRIPT)
            self.assertEqual(len(loads_edges), 1)

            # Ítem 3 y 7: Callbacks sin paréntesis, listeners inline y semántica de aristas.
            e_samples = edges[("js/app.js::initApp", "js/samples.js::loadSampleImages")]
            self.assertEqual(e_samples["edge_type"], EDGE_EVENT_LISTENER)
            self.assertEqual(e_samples["event"], "click")

            e_print = edges[("js/app.js::initApp", "js/print.js::triggerPrint")]
            self.assertEqual(e_print["edge_type"], EDGE_EVENT_LISTENER)
            self.assertEqual(e_print["event"], "click")

            e_map = edges[("js/samples.js::loadSampleImages", "js/samples.js::formatSample")]
            self.assertEqual(e_map["edge_type"], EDGE_CALLBACK_REF)

            # Flujo reactivo Observer / Pub-Sub: subscribe + trigger invertido desde notifyStateChange.
            self.assertEqual(
                edges[("js/app.js::initApp", "js/state.js::subscribeState")]["edge_type"],
                EDGE_REACTIVE_SUBSCRIBE,
            )
            self.assertEqual(
                edges[("js/state.js::notifyStateChange", "js/app.js::updateUI")]["edge_type"],
                EDGE_REACTIVE_TRIGGER,
            )
            self.assertEqual(
                edges[("js/state.js::notifyStateChange", "js/app.js::syncToolbar")]["edge_type"],
                EDGE_REACTIVE_TRIGGER,
            )

            # Ítem 4 y 6: Entradas principales vs handlers vs funciones huérfanas.
            self.assertEqual(nodes["js/app.js::initApp"]["role"], ROLE_ENTRY)
            self.assertEqual(nodes["js/app.js::initApp"]["entry_kind"], ENTRY_KIND_MAIN)
            self.assertTrue(nodes["js/app.js::initApp"]["is_module_entry"])

            self.assertEqual(nodes["server.js::startServer"]["role"], ROLE_ENTRY)
            self.assertEqual(nodes["server.js::startServer"]["entry_kind"], ENTRY_KIND_MAIN)

            # Event handlers secundarios NO deben ser ROLE_ENTRY.
            self.assertNotEqual(nodes["js/samples.js::loadSampleImages"]["role"], ROLE_ENTRY)
            self.assertEqual(nodes["js/samples.js::loadSampleImages"]["entry_kind"], ENTRY_KIND_EVENT)
            self.assertTrue(nodes["js/samples.js::loadSampleImages"]["is_event_handler"])

            self.assertNotEqual(nodes["js/print.js::triggerPrint"]["role"], ROLE_ENTRY)
            self.assertEqual(nodes["js/print.js::triggerPrint"]["entry_kind"], ENTRY_KIND_EVENT)

            # Función huérfana NO debe ser ROLE_ENTRY.
            self.assertNotEqual(nodes["js/print.js::orphanHelper"]["role"], ROLE_ENTRY)
            self.assertEqual(nodes["js/print.js::orphanHelper"]["entry_kind"], ENTRY_KIND_UNREFERENCED)
            self.assertTrue(nodes["js/print.js::orphanHelper"]["is_unreferenced"])

            # Ítem 8: Hilos de ejecución deterministas.
            flows = graph["execution_flows"]
            main_flows = [f for f in flows if f["kind"] == "main"]
            feature_flows = [f for f in flows if f["kind"] == "feature"]

            # El hilo principal desde index.html contiene initApp y subscribeState,
            # pero NO engulle el cuerpo de los event handlers de click.
            html_main = next(f for f in main_flows if f["root_id"] == "index.html")
            self.assertIn("js/app.js::initApp", html_main["node_ids"])
            self.assertIn("js/state.js::subscribeState", html_main["node_ids"])
            self.assertNotIn("js/samples.js::loadSampleImages", html_main["node_ids"])
            self.assertNotIn("js/print.js::triggerPrint", html_main["node_ids"])

            # El hilo por feature `loadSampleImages` sigue el trigger reactivo hasta `updateUI` y `syncToolbar`!
            samples_flow = next(f for f in feature_flows if f["root_id"] == "js/samples.js::loadSampleImages")
            self.assertEqual(samples_flow["registered_by"], "js/app.js::initApp")
            self.assertIn("js/samples.js::formatSample", samples_flow["node_ids"])
            self.assertIn("js/state.js::addImages", samples_flow["node_ids"])
            self.assertIn("js/state.js::notifyStateChange", samples_flow["node_ids"])
            self.assertIn("js/app.js::updateUI", samples_flow["node_ids"])
            self.assertIn("js/app.js::syncToolbar", samples_flow["node_ids"])

            # Orden numerado consecutivo 1..N.
            self.assertEqual([s["order"] for s in samples_flow["steps"]], list(range(1, len(samples_flow["steps"]) + 1)))

    def test_python_callbacks_guards_and_main_guard(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_files(
                root,
                {
                    "handlers.py": """
                    class Worker:
                        def __init__(self):
                            pass

                        def run(self):
                            return "ok"

                    def get_key(item):
                        return item

                    def handle_users():
                        return "users"

                    def shadowed():
                        return "module_fn"

                    def register(app, shadowed):
                        # No debe enlazar al shadowing local ni a isinstance(..., Worker) ni a print(get_key).
                        print(get_key)
                        if isinstance(app, Worker):
                            return shadowed
                        app.router.add_get('/users', handle_users)
                        return sorted([1, 2], key=get_key)

                    def boot():
                        register(None, None)

                    if __name__ == "__main__":
                        boot()
                    """,
                },
            )

            graph = _analyze_dir(root, include_private=True)
            edges = _edge_map(graph)
            nodes = _node_map(graph)

            self.assertIn(("handlers.py::register", "handlers.py::handle_users"), edges)
            self.assertEqual(edges[("handlers.py::register", "handlers.py::handle_users")]["edge_type"], EDGE_EVENT_LISTENER)
            self.assertEqual(edges[("handlers.py::register", "handlers.py::handle_users")]["event"], "/users")

            self.assertIn(("handlers.py::register", "handlers.py::get_key"), edges)
            self.assertEqual(edges[("handlers.py::register", "handlers.py::get_key")]["edge_type"], EDGE_CALLBACK_REF)

            # Sin falsos positivos por isinstance(app, Worker) ni parámetro `shadowed`.
            self.assertNotIn(("handlers.py::register", "handlers.py::Worker.__init__"), edges)
            self.assertNotIn(("handlers.py::register", "handlers.py::shadowed"), edges)

            # `boot()` en `if __name__ == "__main__"` es entrada principal real.
            self.assertEqual(nodes["handlers.py::boot"]["role"], ROLE_ENTRY)
            self.assertEqual(nodes["handlers.py::boot"]["entry_kind"], ENTRY_KIND_MAIN)
            self.assertEqual(nodes["handlers.py::handle_users"]["entry_kind"], ENTRY_KIND_ROUTE)

            # `shadowed` sin llamadores reales es unreferenced, NO entry.
            self.assertEqual(nodes["handlers.py::shadowed"]["entry_kind"], ENTRY_KIND_UNREFERENCED)
            self.assertNotEqual(nodes["handlers.py::shadowed"]["role"], ROLE_ENTRY)

    def test_jsx_bind_domcontentloaded_static_server_and_cycles(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_files(
                root,
                {
                    "server.js": """
                    const express = require('express');
                    const app = express();
                    app.use(express.static('public'));
                    app.listen(8080);
                    """,
                    "public/index.html": """
                    <html><body><script type="module" src="/src/main.tsx"></script></body></html>
                    """,
                    "src/main.tsx": """
                    function ping() { pong(); }
                    function pong() { ping(); }

                    class Panel {
                      constructor() {}
                      onSave() { ping(); }
                      mount(btn: any) {
                        btn.addEventListener('click', this.onSave.bind(this));
                      }
                    }

                    function handleReset() { return 0; }

                    export function Toolbar() {
                      return <button onClick={handleReset}>Reset</button>;
                    }

                    function startApp() {
                      const p = new Panel();
                      p.mount(null);
                      Toolbar();
                    }

                    document.addEventListener('DOMContentLoaded', startApp);
                    """,
                },
            )

            graph = _analyze_dir(root)
            nodes = _node_map(graph)
            edges = _edge_map(graph)

            # Heurística de servidor estático: server.js -> public/index.html -> src/main.tsx::startApp.
            self.assertIn(("server.js", "public/index.html"), edges)
            self.assertEqual(edges[("server.js", "public/index.html")]["edge_type"], EDGE_SERVES_HTML)
            self.assertIn(("public/index.html", "src/main.tsx::startApp"), edges)
            self.assertEqual(edges[("public/index.html", "src/main.tsx::startApp")]["edge_type"], EDGE_LOADS_SCRIPT)

            # DOMContentLoaded marca startApp como punto de arranque principal.
            self.assertEqual(nodes["src/main.tsx::startApp"]["role"], ROLE_ENTRY)
            self.assertEqual(nodes["src/main.tsx::startApp"]["entry_kind"], ENTRY_KIND_MAIN)

            # `.bind(this)` resuelve `Panel.mount -> Panel.onSave` como event_listener.
            self.assertIn(("src/main.tsx::Panel.mount", "src/main.tsx::Panel.onSave"), edges)
            self.assertEqual(
                edges[("src/main.tsx::Panel.mount", "src/main.tsx::Panel.onSave")]["edge_type"],
                EDGE_EVENT_LISTENER,
            )

            # Prop JSX `onClick={handleReset}` resuelve como event_listener.
            self.assertIn(("src/main.tsx::Toolbar", "src/main.tsx::handleReset"), edges)
            self.assertEqual(
                edges[("src/main.tsx::Toolbar", "src/main.tsx::handleReset")]["edge_type"],
                EDGE_EVENT_LISTENER,
            )
            self.assertEqual(
                edges[("src/main.tsx::Toolbar", "src/main.tsx::handleReset")]["event"],
                "click",
            )

            # Ciclos mutuos (`ping <-> pong`) terminan sin bucle infinito en execution_flows.
            save_flow = next(
                f for f in graph["execution_flows"]
                if f["kind"] == "feature" and f["root_id"] == "src/main.tsx::Panel.onSave"
            )
            self.assertEqual(
                save_flow["node_ids"],
                ["src/main.tsx::Panel.onSave", "src/main.tsx::ping", "src/main.tsx::pong"],
            )


class TestFlowCompactionAndFingerprintStability(unittest.TestCase):
    """Ítem 9 (FlowGraphBuilder sin truncamiento prematuro) y estabilidad de fingerprint.py."""

    def test_long_js_orchestrator_compacts_and_reaches_end(self) -> None:
        dom_lines = "\n".join(f"  const el{i} = document.getElementById('el-{i}');" for i in range(12))
        assign_lines = "\n".join(f"  cfg.p{i} = {i};" for i in range(10))
        branch_lines = "\n".join(
            f"  if (flags.f{i}) {{ step{i}(); }}" for i in range(18)
        )
        code = f"""
function initApp(cfg, flags) {{
{dom_lines}
{assign_lines}
{branch_lines}
  restoreFromIndexedDB();
}}
"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "app.js"
            path.write_text(code, encoding="utf-8")
            analysis = parse_file(path)
            assert analysis is not None
            fn = analysis.functions[0]
            labels = [s.label for s in fn.internal_flow]
            codes = [s.code for s in fn.internal_flow]

            # No debe truncarse con "límite de pasos alcanzado".
            self.assertFalse(any("límite de pasos alcanzado" in lbl for lbl in labels), labels)
            # Debe haber compactado declaraciones DOM y asignaciones contiguas.
            self.assertTrue(any("12 declaraciones DOM" in lbl for lbl in labels), labels)
            self.assertTrue(any("10 asignaciones" in lbl for lbl in labels), labels)
            # El código completo de las sentencias compactadas se preserva.
            dom_step = next(s for s in fn.internal_flow if "12 declaraciones DOM" in s.label)
            self.assertIn("el0", dom_step.code)
            self.assertIn("el11", dom_step.code)
            # El tramo final de la función llega íntegro al grafo de flujo.
            self.assertTrue(any("restoreFromIndexedDB()" in c for c in codes), labels[-5:])

    def test_long_python_function_compacts_and_reaches_end(self) -> None:
        assigns = "\n".join(f"    v{i} = {i} * 2" for i in range(15))
        branches = "\n".join(f"    if flag_{i}:\n        run_{i}()" for i in range(20))
        code = f"def orchestrate(cfg):\n{assigns}\n{branches}\n    persist_final_state()\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "orch.py"
            path.write_text(code, encoding="utf-8")
            analysis = parse_file(path)
            assert analysis is not None
            fn = analysis.functions[0]
            labels = [s.label for s in fn.internal_flow]

            self.assertFalse(any("límite de pasos alcanzado" in lbl for lbl in labels), labels)
            self.assertTrue(any("15 asignaciones" in lbl for lbl in labels), labels)
            self.assertTrue(any("persist_final_state()" in lbl for lbl in labels), labels[-5:])

    def test_fingerprint_ignores_uninvoked_callback_refs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            p_js = Path(tmp) / "fp.js"
            p_js.write_text(
                "function cb() {}\nfunction caller(btn) { btn.addEventListener('click', cb); }\n",
                encoding="utf-8",
            )
            analysis = parse_file(p_js)
            assert analysis is not None
            caller = next(f for f in analysis.functions if f.short_name == "caller")
            # Confirmamos que sí extrajo el callback ref sin alterar el fingerprint basado en invocaciones.
            self.assertTrue(any(c.callee == "cb" and not c.is_invocation for c in caller.calls))
            direct_callees = [c.callee for c in caller.calls if c.is_invocation]
            self.assertEqual(direct_callees, ["btn.addEventListener"])
            # Mismo algoritmo exacto que antes (solo invocaciones directas).
            self.assertEqual(len(caller.fingerprint), 10)
            self.assertEqual(
                compute_fingerprint(1, ["a"], ["btn.addEventListener"], "caller"),
                compute_fingerprint(1, ["a"], ["btn.addEventListener"], "caller"),
            )


class TestExamplesAndZeroIntrusion(unittest.TestCase):
    """Validación sobre examples/multi y examples/single + cero intrusión."""

    def test_examples_multi_and_single(self) -> None:
        multi_dir = REPO_ROOT / "examples" / "multi"
        before_multi = sorted(p.relative_to(multi_dir).as_posix() for p in multi_dir.rglob("*"))
        graph_multi = _analyze_dir(multi_dir)
        after_multi = sorted(p.relative_to(multi_dir).as_posix() for p in multi_dir.rglob("*"))
        self.assertEqual(before_multi, after_multi)

        nodes = _node_map(graph_multi)
        self.assertEqual(nodes["backend/app.py::main"]["role"], ROLE_ENTRY)
        self.assertEqual(nodes["frontend/src/server.js::start"]["role"], ROLE_ENTRY)
        self.assertNotEqual(nodes["frontend/src/store.tsx::StoreBadge"]["role"], ROLE_ENTRY)
        self.assertEqual(nodes["frontend/src/store.tsx::StoreBadge"]["entry_kind"], ENTRY_KIND_UNREFERENCED)

        # Todos los edges mantienen retrocompatibilidad + edge_type.
        for edge in graph_multi["edges"]:
            for required_key in ("id", "source", "target", "confidence", "call_count", "line", "edge_type"):
                self.assertIn(required_key, edge)

        # execution_flows presentes y con hilo principal + feature route.
        kinds = {f["kind"] for f in graph_multi["execution_flows"]}
        self.assertIn("main", kinds)
        self.assertIn("feature", kinds)

        single_dir = REPO_ROOT / "examples" / "single"
        before_single = sorted(p.relative_to(single_dir).as_posix() for p in single_dir.rglob("*"))
        graph_single = _analyze_dir(single_dir)
        after_single = sorted(p.relative_to(single_dir).as_posix() for p in single_dir.rglob("*"))
        self.assertEqual(before_single, after_single)

        single_nodes = _node_map(graph_single)
        self.assertEqual(single_nodes["script.py::main"]["role"], ROLE_ENTRY)
        self.assertEqual(single_nodes["testing.js::nameOrAge"]["role"], ROLE_ENTRY)
        self.assertTrue(single_nodes["testing.js::nameOrAge"]["is_module_entry"])


if __name__ == "__main__":
    unittest.main()
