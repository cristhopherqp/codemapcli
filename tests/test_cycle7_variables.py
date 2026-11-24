"""Pruebas del Ciclo 7 (Fases 7.1 y 7.2): Variables/Constantes Top-Level, anti-sombreado y visor."""

from __future__ import annotations

import asyncio
import json
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from codemap.discovery import discover_files
from codemap.exporter import build_ai_graph, build_ai_markdown
from codemap.graph_builder import build_graph
from codemap.models import EDGE_READS_VAR
from codemap.parsers import parse_file
from codemap.paths import normalize_path
from codemap.server import create_app

REPO_ROOT = Path(__file__).resolve().parent.parent
VIEWER_DIR = REPO_ROOT / "codemap" / "viewer"


def _build_temp_graph(files: dict[str, str], *, include_private: bool = False) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for rel, content in files.items():
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(textwrap.dedent(content).lstrip("\n"), encoding="utf-8")
        analyses = [a for p in discover_files(root) if (a := parse_file(p)) is not None]
        norm = normalize_path(root)
        return build_graph(
            analyses,
            target_path=norm,
            root_dir=norm,
            is_single_file=False,
            include_private=include_private,
        )


class TestCycle7Phase1VariablesBackend(unittest.TestCase):
    def test_python_top_level_variables_extraction_and_exclusions(self) -> None:
        files = {
            "settings.py": '''
                """Configuración global del servicio."""

                import os
                from typing import Final

                # Número máximo de reintentos HTTP.
                MAX_RETRIES: int = 3
                TIMEOUT: Final[float] = 5.5  # segundos de espera
                current_mode = "fast"
                HOST, PORT = "127.0.0.1", 8080
                API_TOKEN = "sk-live-very-secret-token"
                _PRIVATE_FLAG = True

                # Debe excluirse (callable lambda, atributo, subíndice y bloque __main__).
                adder = lambda x: x + 1
                state_bag = {}
                state_bag["k"] = 1

                def boot():
                    return MAX_RETRIES

                if __name__ == "__main__":
                    MAIN_ONLY = 999
                    boot()
            ''',
        }

        graph = _build_temp_graph(files, include_private=False)
        var_nodes = {n["id"]: n for n in graph["nodes"] if n["type"] == "variable"}

        self.assertEqual(
            set(var_nodes.keys()),
            {
                "settings.py::MAX_RETRIES",
                "settings.py::TIMEOUT",
                "settings.py::current_mode",
                "settings.py::HOST",
                "settings.py::PORT",
                "settings.py::API_TOKEN",
                "settings.py::state_bag",
            },
        )
        self.assertEqual(graph["meta"]["total_variables"], 7)

        # Clasificación constant vs variable, docstrings y tipos.
        self.assertEqual(var_nodes["settings.py::MAX_RETRIES"]["var_kind"], "constant")
        self.assertEqual(var_nodes["settings.py::MAX_RETRIES"]["type_annotation"], "int")
        self.assertEqual(var_nodes["settings.py::MAX_RETRIES"]["value_preview"], "3")
        self.assertIn("reintentos HTTP", var_nodes["settings.py::MAX_RETRIES"]["docstring"])

        self.assertEqual(var_nodes["settings.py::TIMEOUT"]["var_kind"], "constant")
        self.assertEqual(var_nodes["settings.py::TIMEOUT"]["type_annotation"], "Final[float]")
        self.assertIn("segundos de espera", var_nodes["settings.py::TIMEOUT"]["docstring"])

        self.assertEqual(var_nodes["settings.py::current_mode"]["var_kind"], "variable")
        self.assertEqual(var_nodes["settings.py::HOST"]["value_preview"], '"127.0.0.1"')
        self.assertEqual(var_nodes["settings.py::PORT"]["value_preview"], "8080")

        # Redacción obligatoria de secretos en value_preview.
        self.assertEqual(var_nodes["settings.py::API_TOKEN"]["value_preview"], '"[REDACTED]"')

        # Excluidos por defecto: lambda, __main__, privados.
        self.assertNotIn("settings.py::adder", var_nodes)
        self.assertNotIn("settings.py::MAIN_ONLY", var_nodes)
        self.assertNotIn("settings.py::_PRIVATE_FLAG", var_nodes)

        # Orden por línea dentro del archivo.
        lines = [n["line"] for n in graph["nodes"] if n["type"] == "variable"]
        self.assertEqual(lines, sorted(lines))

        # Con `--include-private`, `_PRIVATE_FLAG` aparece.
        graph_priv = _build_temp_graph(files, include_private=True)
        priv_vars = {n["id"] for n in graph_priv["nodes"] if n["type"] == "variable"}
        self.assertIn("settings.py::_PRIVATE_FLAG", priv_vars)

    def test_python_lexical_shadowing_and_cross_file_reads_var(self) -> None:
        files = {
            "config.py": '''
                API_URL = "https://api.example.com"
                TIMEOUT = 10
            ''',
            "worker.py": '''
                import config
                from config import API_URL

                MAX_RETRIES = 3
                ITEM = "global-item"
                CONFIG_MAP = {"mode": "strict"}
                current_count = 0

                def helper(MAX_RETRIES=0):
                    return MAX_RETRIES

                def real_reader():
                    mode = CONFIG_MAP.get("mode")
                    return (MAX_RETRIES, API_URL, config.TIMEOUT, mode)

                def shadowed_param(MAX_RETRIES):
                    return MAX_RETRIES + 1

                def shadowed_local():
                    MAX_RETRIES = 99
                    return MAX_RETRIES

                def shadowed_comprehension():
                    return [ITEM for ITEM in range(3)]

                def kwarg_only():
                    return helper(MAX_RETRIES=5)

                def global_reader():
                    global current_count
                    current_count = current_count + 1
                    return current_count
            ''',
        }

        graph = _build_temp_graph(files)
        reads = {
            (e["source"], e["target"])
            for e in graph["edges"]
            if e["edge_type"] == EDGE_READS_VAR
        }

        # Lecturas reales (local, atributo sobre dict, from-import y module.ATTR).
        self.assertIn(("worker.py::real_reader", "worker.py::MAX_RETRIES"), reads)
        self.assertIn(("worker.py::real_reader", "worker.py::CONFIG_MAP"), reads)
        self.assertIn(("worker.py::real_reader", "config.py::API_URL"), reads)
        self.assertIn(("worker.py::real_reader", "config.py::TIMEOUT"), reads)

        # `global current_count` rompe el sombreado local.
        self.assertIn(("worker.py::global_reader", "worker.py::current_count"), reads)

        # Cero falsos positivos por sombreado de parámetro, local, comprensión o kwarg.
        self.assertNotIn(("worker.py::shadowed_param", "worker.py::MAX_RETRIES"), reads)
        self.assertNotIn(("worker.py::shadowed_local", "worker.py::MAX_RETRIES"), reads)
        self.assertNotIn(("worker.py::shadowed_comprehension", "worker.py::ITEM"), reads)
        self.assertNotIn(("worker.py::kwarg_only", "worker.py::MAX_RETRIES"), reads)
        self.assertNotIn(("worker.py::helper", "worker.py::MAX_RETRIES"), reads)

    def test_js_ts_variables_shadowing_and_reexport_resolution(self) -> None:
        files = {
            "constants.ts": """
                /** Límite máximo de intentos en red. */
                export const MAX_RETRIES: number = 4;
                export const SECRET_KEY = "super-secret-value";
                export let activeMode = "auto";
                export enum Status {
                  OK = "ok",
                  ERR = "err",
                }
            """,
            "barrel.ts": """
                export { MAX_RETRIES, Status } from "./constants";
            """,
            "service.ts": """
                import { MAX_RETRIES, Status } from "./barrel";
                import * as cfg from "./constants";

                const LOCAL_TAG = "svc";
                const noop = () => 1;
                const fs = require("fs");

                export function runTask() {
                  const payload = { LOCAL_TAG, status: Status.OK };
                  return [MAX_RETRIES, cfg.activeMode, payload];
                }

                export function shadowedBlock() {
                  if (true) {
                    const MAX_RETRIES = 1;
                    return MAX_RETRIES;
                  }
                  return 0;
                }

                export function shadowedDestructured({ MAX_RETRIES, LOCAL_TAG: tag }: any) {
                  return MAX_RETRIES + tag;
                }
            """,
        }

        graph = _build_temp_graph(files)
        nodes = {n["id"]: n for n in graph["nodes"]}
        var_ids = {n["id"] for n in graph["nodes"] if n["type"] == "variable"}

        self.assertIn("constants.ts::MAX_RETRIES", var_ids)
        self.assertIn("constants.ts::SECRET_KEY", var_ids)
        self.assertIn("constants.ts::activeMode", var_ids)
        self.assertIn("constants.ts::Status", var_ids)
        self.assertIn("service.ts::LOCAL_TAG", var_ids)

        # Excluidos: arrow function (`noop`) y `require("fs")` (`fs`).
        self.assertNotIn("service.ts::noop", var_ids)
        self.assertNotIn("service.ts::fs", var_ids)

        # JSDoc en constante NO robado por el archivo, tipo TS y redacción de secreto.
        self.assertEqual(nodes["constants.ts"]["docstring"], "")
        self.assertIn("intentos en red", nodes["constants.ts::MAX_RETRIES"]["docstring"])
        self.assertEqual(nodes["constants.ts::MAX_RETRIES"]["type_annotation"], "number")
        self.assertEqual(nodes["constants.ts::SECRET_KEY"]["value_preview"], '"[REDACTED]"')
        self.assertEqual(nodes["constants.ts::activeMode"]["var_kind"], "variable")
        self.assertEqual(nodes["constants.ts::Status"]["var_kind"], "constant")

        reads = {
            (e["source"], e["target"])
            for e in graph["edges"]
            if e["edge_type"] == EDGE_READS_VAR
        }
        # Re-exportación multi-salto (`service.ts` -> `barrel.ts` -> `constants.ts`), shorthand y namespace.
        self.assertIn(("service.ts::runTask", "constants.ts::MAX_RETRIES"), reads)
        self.assertIn(("service.ts::runTask", "constants.ts::Status"), reads)
        self.assertIn(("service.ts::runTask", "constants.ts::activeMode"), reads)
        self.assertIn(("service.ts::runTask", "service.ts::LOCAL_TAG"), reads)

        # Sin falsos positivos por sombreado en bloque o desestructuración de parámetros.
        self.assertNotIn(("service.ts::shadowedBlock", "constants.ts::MAX_RETRIES"), reads)
        self.assertNotIn(("service.ts::shadowedDestructured", "constants.ts::MAX_RETRIES"), reads)
        self.assertNotIn(("service.ts::shadowedDestructured", "service.ts::LOCAL_TAG"), reads)

    def test_graph_metrics_isolation_and_ai_exporter_compactness(self) -> None:
        base_files = {
            "app.py": '''
                def main():
                    return worker()

                def worker():
                    return 42
            ''',
        }
        with_vars_files = {
            "app.py": '''
                BASE_VALUE = 40
                DELTA = 2

                def main():
                    return worker() + DELTA

                def worker():
                    return BASE_VALUE
            ''',
        }

        g_base = _build_temp_graph(base_files)
        g_vars = _build_temp_graph(with_vars_files)

        fn_base = {n["id"]: n for n in g_base["nodes"] if n["type"] == "function"}
        fn_vars = {n["id"]: n for n in g_vars["nodes"] if n["type"] == "function"}

        # Las variables y aristas `reads_var` NO alteran `is_terminal`, `entry_kind`, `arch_layer` ni `execution_flows`.
        for fn_id in ("app.py::main", "app.py::worker"):
            self.assertEqual(fn_vars[fn_id]["is_terminal"], fn_base[fn_id]["is_terminal"])
            self.assertEqual(fn_vars[fn_id]["entry_kind"], fn_base[fn_id]["entry_kind"])
            self.assertEqual(fn_vars[fn_id]["arch_layer"], fn_base[fn_id]["arch_layer"])

        self.assertEqual(
            [[s["node_id"] for s in f["steps"]] for f in g_vars["execution_flows"]],
            [[s["node_id"] for s in f["steps"]] for f in g_base["execution_flows"]],
        )
        self.assertTrue(fn_vars["app.py::worker"]["is_terminal"])

        # Exportador IA JSON + Markdown incluye variables compactas y aristas `lee`.
        ai_json = build_ai_graph(g_vars)
        self.assertEqual(ai_json["meta"]["total_variables"], 2)
        ai_vars = [n for n in ai_json["nodes"] if n["type"] == "variable"]
        self.assertEqual({n["id"] for n in ai_vars}, {"app.py::BASE_VALUE", "app.py::DELTA"})
        self.assertTrue(any(e.get("edge_type") == EDGE_READS_VAR for e in ai_json["edges"]))

        ai_md = build_ai_markdown(g_vars)
        self.assertIn("[constante]", ai_md)
        self.assertIn("BASE_VALUE", ai_md)
        self.assertIn("(lee)", ai_md)


class TestCycle7SourceEndpointForVariables(unittest.TestCase):
    def test_get_source_returns_exact_variable_lines_and_enforces_confinement(self) -> None:
        async def _verify() -> None:
            with tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp)
                outside = base / "secret.txt"
                outside.write_text("TOP SECRET\n", encoding="utf-8")
                root = base / "proj"
                root.mkdir()
                (root / "cfg.py").write_text(
                    textwrap.dedent(
                        '''
                        # Configuración principal de caché.
                        CACHE_TTL: int = 300
                        MULTI_CONFIG = {
                            "host": "localhost",
                            "port": 6379,
                        }

                        def read_ttl():
                            return CACHE_TTL
                        '''
                    ).lstrip("\n"),
                    encoding="utf-8",
                )
                analyses = [a for p in discover_files(root) if (a := parse_file(p)) is not None]
                norm = normalize_path(root)
                graph = build_graph(
                    analyses,
                    target_path=norm,
                    root_dir=norm,
                    is_single_file=False,
                    include_private=False,
                )
                app = create_app(norm, graph)
                async with TestClient(TestServer(app)) as client:
                    resp = await client.get("/source", params={"node_id": "cfg.py::MULTI_CONFIG"})
                    self.assertEqual(resp.status, 200)
                    payload = await resp.json()
                    self.assertEqual(payload["node_id"], "cfg.py::MULTI_CONFIG")
                    self.assertEqual(payload["start_line"], 3)
                    self.assertEqual(payload["end_line"], 6)
                    self.assertIn('"host": "localhost"', payload["code"])
                    self.assertIn('"port": 6379', payload["code"])

                    missing = await client.get("/source", params={"node_id": "cfg.py::DOES_NOT_EXIST"})
                    self.assertEqual(missing.status, 404)

                # Confinamiento estricto: un file_path manipulado fuera de root_dir debe devolver 403.
                for node in graph["nodes"]:
                    if node["id"] == "cfg.py":
                        node["file_path"] = str(outside)
                tampered_app = create_app(norm, graph)
                async with TestClient(TestServer(tampered_app)) as client:
                    resp_escape = await client.get("/source", params={"node_id": "cfg.py::MULTI_CONFIG"})
                    self.assertEqual(resp_escape.status, 403)

        asyncio.run(_verify())


class TestCycle7Phase2ViewerAndCreationOrder(unittest.TestCase):
    def test_viewer_html_css_js_contracts_and_syntax(self) -> None:
        html = (VIEWER_DIR / "index.html").read_text(encoding="utf-8")
        css = (VIEWER_DIR / "styles.css").read_text(encoding="utf-8")
        js = (VIEWER_DIR / "app.js").read_text(encoding="utf-8")

        for token in (
            'id="btn-toggle-variables"',
            'id="variables-label-text"',
            'id="variables-count-badge"',
            'aria-pressed="false"',
            'class="shape shape-variable"',
            'class="edge-sample reads-var"',
            'id="detail-var-preview-block"',
            'id="btn-var-load-source"',
            'id="detail-file-variables-block"',
            'id="detail-internal-calls-title"',
        ):
            self.assertIn(token, html)

        for token in (
            ".shape-variable",
            ".edge-sample.reads-var",
            ".flow-badge-constant",
            ".flow-badge-variable",
            ".role-badge.role-variable",
            ".edge-type-reads_var",
            ".var-preview-header",
        ):
            self.assertIn(token, css)

        for token in (
            "showVariables: false",
            "function updateVariablesButton(",
            "async function toggleShowVariables(",
            "function updateFileVariablesBlock(",
            "function updateVarPreviewBlock(",
            "async function toggleSelectedVariableSource(",
            'node[type = "variable"]',
            'edge[kind = "call"][edgeType = "reads_var"]',
        ):
            self.assertIn(token, js)

        check = subprocess.run(
            ["node", "--check", str(VIEWER_DIR / "app.js")],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_variables_toggle_styles_and_creation_order_in_node_cytoscape_elk(self) -> None:
        files = {
            "pipeline.py": '''
                # Límite global.
                MAX_ITEMS = 50
                active_tag = "v1"

                def step_one():
                    return MAX_ITEMS

                def step_two():
                    return (step_one(), active_tag)
            ''',
        }
        raw_graph = _build_temp_graph(files)

        script = (
            "const fs = require('fs');\n"
            f"const cytoscape = require({json.dumps(str(VIEWER_DIR / 'vendor' / 'cytoscape.min.js'))});\n"
            f"const ELK = require({json.dumps(str(VIEWER_DIR / 'vendor' / 'elk.bundled.js'))});\n"
            f"const src = fs.readFileSync({json.dumps(str(VIEWER_DIR / 'app.js'))}, 'utf8');\n"
            "const extractFn = (name) => {\n"
            "  const idx = src.indexOf('function ' + name + '(');\n"
            "  const asyncIdx = src.indexOf('async function ' + name + '(');\n"
            "  const start = asyncIdx >= 0 && (idx < 0 || asyncIdx < idx) ? asyncIdx : idx;\n"
            "  if (start < 0) throw new Error('Missing ' + name);\n"
            "  let pDepth = 0, bodyStart = start;\n"
            "  for (let i = start; i < src.length; i++) {\n"
            "    if (src[i] === '(') pDepth++;\n"
            "    else if (src[i] === ')') { pDepth--; if (pDepth === 0) { bodyStart = i + 1; break; } }\n"
            "  }\n"
            "  let depth = 0, started = false, end = bodyStart;\n"
            "  for (let i = bodyStart; i < src.length; i++) {\n"
            "    if (src[i] === '{') { depth++; started = true; }\n"
            "    else if (src[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }\n"
            "  }\n"
            "  return src.slice(start, end);\n"
            "};\n"
            "const matchConst = (name) => {\n"
            "  const re = new RegExp('const ' + name + ' = (\\\\{[\\\\s\\\\S]*?\\\\}|\\\\[[\\\\s\\\\S]*?\\\\]|\"[^\"]+\"|\\\\d+);');\n"
            "  const m = src.match(re);\n"
            "  if (!m) throw new Error('Missing const ' + name);\n"
            "  return m[0].replace(/^const /, 'var ');\n"
            "};\n"
            f"const rawGraph = {json.dumps(raw_graph)};\n"
            "const state = {\n"
            "  rawGraph,\n"
            "  notes: { nodes: {}, orphans: [] },\n"
            "  nodesById: new Map(),\n"
            "  childrenByParent: new Map(),\n"
            "  flowsById: new Map(),\n"
            "  activeFlowId: null,\n"
            "  isolateActiveContext: false,\n"
            "  groupingMode: 'folders',\n"
            "  layoutOrderMode: 'creation',\n"
            "  nhops: { active: false, anchorIds: [], forwardDepth: 1, backwardDepth: 1 },\n"
            "  utilityNodeIds: new Set(),\n"
            "  utilityDetectionMode: 'strict',\n"
            "  hideUtilities: false,\n"
            "  showVariables: false,\n"
            "  totalVariables: 0,\n"
            "  utilityCalleesByNode: new Map(),\n"
            "  collapsedContainers: new Set(),\n"
            "  expandedFunctions: new Set(),\n"
            "  activeLevel: 3,\n"
            "  selectedNodeId: null,\n"
            "};\n"
            "function getActiveFlowStepMaps() { return { flow: null, nodeOrder: new Map(), edgeOrder: new Map() }; }\n"
            "function computeSubgraphFilter() { return null; }\n"
            "function hasCollapsedAncestor() { return false; }\n"
            "function isUtilityNodeHidden() { return false; }\n"
            "function countHiddenUtilityCallees() { return 0; }\n"
            "function countDescendantFunctions() { return 0; }\n"
            "function getNoteEntry() { return { note: '', pinned: false, pinned_positions: {} }; }\n"
            "function isPinnedInCurrentContext() { return false; }\n"
            "function getNodeArchLayer(n) { return typeof n.arch_layer === 'number' ? n.arch_layer : 3; }\n"
            "function appendInternalFlowElements() {}\n"
            "function appendInternalFlowEdges() {}\n"
            "function computeUtilityNodes() {}\n"
            "eval([\n"
            "  matchConst('CREATION_FILE_ELK_OPTIONS'),\n"
            "  matchConst('CREATION_CONTAINER_ELK_OPTIONS'),\n"
            "  matchConst('CREATION_ROW_STAGGER_PX'),\n"
            "  matchConst('CREATION_MACRO_EDGE_PREFIX'),\n"
            "  matchConst('EDGE_TYPE_PRIORITY'),\n"
            "  extractFn('indexGraph'),\n"
            "  extractFn('buildDisplayLabel'),\n"
            "  extractFn('resolveVisibleEndpoint'),\n"
            "  extractFn('pickHigherPriorityEdgeType'),\n"
            "  extractFn('buildProjectedEdgeLabel'),\n"
            "  extractFn('projectEdges'),\n"
            "  extractFn('buildVisibleElements'),\n"
            "  extractFn('buildStylesheet'),\n"
            "  extractFn('estimateWrappedTextMetrics'),\n"
            "  extractFn('estimateFlowStepSize'),\n"
            "  extractFn('estimateNodeSize'),\n"
            "  extractFn('estimateCompoundHeaderWidth'),\n"
            "  extractFn('computeElkSubtreeWidth'),\n"
            "  extractFn('assignCreationBands'),\n"
            "  extractFn('computeCreationPartition'),\n"
            "  extractFn('computeIntraTierFoundationDepths'),\n"
            "  extractFn('buildCreationElkInput'),\n"
            "  extractFn('collectAbsolutePositions'),\n"
            "  extractFn('shiftElkSubtreeY'),\n"
            "  extractFn('applyCreationRowStagger'),\n"
            "].join('\\n'));\n"
            "\n"
            "(async () => {\n"
            "  indexGraph(rawGraph);\n"
            "  // 1. Por defecto (`showVariables = false`), 0 nodos variable y 0 aristas `reads_var`.\n"
            "  const off = buildVisibleElements();\n"
            "  const offVars = off.nodes.filter((n) => n.data.type === 'variable').length;\n"
            "  const offReads = off.edges.filter((e) => e.data.edgeType === 'reads_var').length;\n"
            "\n"
            "  // 2. Al activar (`showVariables = true`), aparecen las pastillas y aristas `reads_var`.\n"
            "  state.showVariables = true;\n"
            "  const on = buildVisibleElements();\n"
            "  const onVars = on.nodes.filter((n) => n.data.type === 'variable').map((n) => n.data.id).sort();\n"
            "  const onReads = on.edges\n"
            "    .filter((e) => e.data.edgeType === 'reads_var')\n"
            "    .map((e) => [e.data.source, e.data.target])\n"
            "    .sort();\n"
            "\n"
            "  // 3. Estilos Cytoscape diferenciados para constante, variable mutable y arista `reads_var`.\n"
            "  const cy = cytoscape({\n"
            "    headless: true,\n"
            "    styleEnabled: true,\n"
            "    style: buildStylesheet(),\n"
            "    elements: [...on.nodes, ...on.edges],\n"
            "  });\n"
            "  const constNode = cy.getElementById('pipeline.py::MAX_ITEMS');\n"
            "  const varNode = cy.getElementById('pipeline.py::active_tag');\n"
            "  const readEdge = cy.edges('[edgeType = \"reads_var\"]').first();\n"
            "  const styles = {\n"
            "    constBorderStyle: constNode.style('border-style'),\n"
            "    constBorderColor: constNode.style('border-color'),\n"
            "    varBorderColor: varNode.style('border-color'),\n"
            "    edgeLineStyle: readEdge.style('line-style'),\n"
            "    edgeArrowShape: readEdge.style('target-arrow-shape'),\n"
            "    edgeOpacity: parseFloat(readEdge.style('opacity')),\n"
            "  };\n"
            "  cy.destroy();\n"
            "\n"
            "  // 4. Layout ELK en `Orden: Creación (1->N)`: las constantes (L2, L3) quedan por encima de las funciones (L5, L8).\n"
            "  const elk = new ELK();\n"
            "  const built = buildCreationElkInput(on.nodes, on.edges);\n"
            "  const layouted = await elk.layout(built.elkGraph);\n"
            "  const pos = new Map();\n"
            "  collectAbsolutePositions(layouted, 0, 0, pos);\n"
            "  const dataById = new Map(on.nodes.map((n) => [n.data.id, n.data]));\n"
            "  applyCreationRowStagger(layouted, pos, new Set(), dataById);\n"
            "  const yById = {\n"
            "    MAX_ITEMS: pos.get('pipeline.py::MAX_ITEMS').y,\n"
            "    active_tag: pos.get('pipeline.py::active_tag').y,\n"
            "    step_one: pos.get('pipeline.py::step_one').y,\n"
            "    step_two: pos.get('pipeline.py::step_two').y,\n"
            "  };\n"
            "\n"
            "  console.log(JSON.stringify({ totalVariables: state.totalVariables, offVars, offReads, onVars, onReads, styles, yById }));\n"
            "})().catch((err) => { console.error(err); process.exit(1); });\n"
        )

        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        res = json.loads(proc.stdout)

        self.assertEqual(res["totalVariables"], 2)
        self.assertEqual(res["offVars"], 0)
        self.assertEqual(res["offReads"], 0)
        self.assertEqual(res["onVars"], ["pipeline.py::MAX_ITEMS", "pipeline.py::active_tag"])
        self.assertEqual(
            res["onReads"],
            [
                ["pipeline.py::step_one", "pipeline.py::MAX_ITEMS"],
                ["pipeline.py::step_two", "pipeline.py::active_tag"],
            ],
        )
        self.assertEqual(res["styles"]["constBorderStyle"], "dashed")
        self.assertEqual(res["styles"]["edgeLineStyle"], "dotted")
        self.assertEqual(res["styles"]["edgeArrowShape"], "vee")
        self.assertAlmostEqual(res["styles"]["edgeOpacity"], 0.58, places=2)
        self.assertNotEqual(res["styles"]["constBorderColor"], res["styles"]["varBorderColor"])

        # En Creación (1→N), `MAX_ITEMS` y `active_tag` (arriba) preceden a `step_one` y `step_two`.
        y = res["yById"]
        self.assertLess(y["MAX_ITEMS"], y["step_one"])
        self.assertLess(y["active_tag"], y["step_two"])
        self.assertLess(y["step_one"], y["step_two"])


if __name__ == "__main__":
    unittest.main()
