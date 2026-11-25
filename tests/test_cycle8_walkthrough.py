"""Pruebas del Ciclo 8 (Fases 8.1, 8.2 y 8.3): Recorrido Visual Estático ('Chispa'), contrato v1 y motor canvas."""

from __future__ import annotations

import json
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

from codemap.discovery import discover_files
from codemap.exporter import build_ai_graph
from codemap.graph_builder import build_graph
from codemap.parsers import parse_file
from codemap.paths import normalize_path

REPO_ROOT = Path(__file__).resolve().parent.parent
VIEWER_DIR = REPO_ROOT / "codemap" / "viewer"
WALKTHROUGH_JS = VIEWER_DIR / "walkthrough.js"


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


class TestCycle8WalkthroughBackendAndGenerator(unittest.TestCase):
    def test_aggregate_edges_emits_sorted_unique_call_lines_and_keeps_ai_export_compact(self) -> None:
        files = {
            "app.py": '''
                def helper(x):
                    return x + 1

                def main():
                    a = helper(1)
                    b = helper(2)
                    c = helper(3)
                    return a + b + c
            ''',
        }
        graph = _build_temp_graph(files)
        edge = next(
            e for e in graph["edges"]
            if e["source"] == "app.py::main" and e["target"] == "app.py::helper"
        )
        self.assertEqual(edge["call_count"], 3)
        self.assertEqual(edge["line"], 5)
        self.assertEqual(edge["call_lines"], [5, 6, 7])

        # El exportador IA no engorda con `call_lines`.
        ai_graph = build_ai_graph(graph)
        ai_edge = next(e for e in ai_graph["edges"] if e["source"] == "app.py::main")
        self.assertNotIn("call_lines", ai_edge)

    def test_pulse_mode_dfs_call_return_cycle_protection_and_schema_v1(self) -> None:
        files = {
            "flow.py": '''
                def leaf(v):
                    return v * 2

                def cycle_b():
                    return cycle_a()

                def cycle_a():
                    return cycle_b()

                def main():
                    x = leaf(1)
                    y = leaf(2)
                    z = cycle_a()
                    return x + y + z
            ''',
        }
        graph = _build_temp_graph(files)
        script = (
            f"const wt = require({json.dumps(str(WALKTHROUGH_JS))});\n"
            f"const graph = {json.dumps(graph)};\n"
            "const trace = wt.StaticWalkthroughGenerator.generate(graph, {\n"
            "  rootId: 'flow.py::main',\n"
            "  granularity: 'pulse',\n"
            "});\n"
            "const capped = wt.StaticWalkthroughGenerator.generate(graph, {\n"
            "  rootId: 'flow.py::main',\n"
            "  granularity: 'pulse',\n"
            "  maxEvents: 4,\n"
            "});\n"
            "const dyn = wt.StaticWalkthroughGenerator.normalizeTrace({\n"
            "  schema_version: 1,\n"
            "  mode: 'dynamic',\n"
            "  granularity: 'pulse',\n"
            "  root_id: 'flow.py::main',\n"
            "  events: [\n"
            "    { kind: 'enter', fn_id: 'flow.py::main', stack_frame: { fn_id: 'flow.py::main', label: 'main()', call_line: 10 }, timestamp_us: 100 },\n"
            "    { kind: 'call', from: 'flow.py::main', to: 'flow.py::leaf', fn_id: 'flow.py::leaf', stack_frame: { fn_id: 'flow.py::leaf', label: 'leaf()', call_line: 11 }, timestamp_us: 250 },\n"
            "    { kind: 'return', from: 'flow.py::leaf', to: 'flow.py::main', fn_id: 'flow.py::main', timestamp_us: 390 },\n"
            "  ],\n"
            "});\n"
            "console.log(JSON.stringify({\n"
            "  schema_version: trace.schema_version,\n"
            "  mode: trace.mode,\n"
            "  granularity: trace.granularity,\n"
            "  truncated: trace.truncated,\n"
            "  events: trace.events.map((e) => ({\n"
            "    seq: e.seq,\n"
            "    kind: e.kind,\n"
            "    from: e.from,\n"
            "    to: e.to,\n"
            "    line: e.line,\n"
            "    depth: e.call_stack.length,\n"
            "    tsNull: e.timestamp_us === null,\n"
            "    diffNull: e.locals_diff === null,\n"
            "    excNull: e.exception_info === null,\n"
            "  })),\n"
            "  cappedTruncated: capped.truncated,\n"
            "  cappedLen: capped.events.length,\n"
            "  dynDepths: dyn.events.map((e) => e.call_stack.length),\n"
            "  dynMode: dyn.mode,\n"
            "}));\n"
        )
        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        res = json.loads(proc.stdout)

        self.assertEqual(res["schema_version"], 1)
        self.assertEqual(res["mode"], "static")
        self.assertEqual(res["granularity"], "pulse")
        self.assertFalse(res["truncated"])

        evs = res["events"]
        # Todos los eventos reservan campos de traza dinámica en `null`.
        for ev in evs:
            self.assertTrue(ev["tsNull"])
            self.assertTrue(ev["diffNull"])
            self.assertTrue(ev["excNull"])

        # Empieza con `enter`, termina con `exit`, y realiza 2 llamadas explícitas `leaf` (L11, L12) + ciclo acotado.
        self.assertEqual(evs[0]["kind"], "enter")
        self.assertEqual(evs[-1]["kind"], "exit")
        leaf_calls = [e for e in evs if e["kind"] == "call" and e["to"] == "flow.py::leaf"]
        self.assertEqual([e["line"] for e in leaf_calls], [11, 12])
        leaf_returns = [e for e in evs if e["kind"] == "return" and e["from"] == "flow.py::leaf"]
        self.assertEqual(len(leaf_returns), 2)

        # La recursión mutua `cycle_a -> cycle_b -> cycle_a` se detiene sin bucle infinito y equilibra call/return.
        call_count = sum(1 for e in evs if e["kind"] == "call")
        ret_count = sum(1 for e in evs if e["kind"] == "return")
        self.assertEqual(call_count, ret_count)
        self.assertEqual(evs[-1]["depth"], 1)

        # Protección `MAX_EVENTS` y compatibilidad `normalizeTrace` con trazas dinámicas.
        self.assertTrue(res["cappedTruncated"])
        self.assertEqual(res["cappedLen"], 4)
        self.assertEqual(res["dynMode"], "dynamic")
        self.assertEqual(res["dynDepths"], [1, 2, 1])

    def test_step_mode_step_into_step_over_loops_and_branch_overrides(self) -> None:
        files = {
            "pipeline.py": '''
                def transform(item):
                    cleaned = item.strip()
                    return cleaned.upper()

                def run_pipeline(items):
                    if not items:
                        raise ValueError("empty")
                    results = []
                    for raw in items:
                        val = transform(raw)
                        results.append(val)
                    try:
                        total = len(results)
                    except TypeError:
                        total = 0
                    return total
            ''',
        }
        graph = _build_temp_graph(files)
        script = (
            f"const wt = require({json.dumps(str(WALKTHROUGH_JS))});\n"
            f"const graph = {json.dumps(graph)};\n"
            "const stepIntoTrace = wt.StaticWalkthroughGenerator.generate(graph, {\n"
            "  rootId: 'pipeline.py::run_pipeline',\n"
            "  granularity: 'step',\n"
            "  stepInto: true,\n"
            "});\n"
            "const stepOverTrace = wt.StaticWalkthroughGenerator.generate(graph, {\n"
            "  rootId: 'pipeline.py::run_pipeline',\n"
            "  granularity: 'step',\n"
            "  stepInto: false,\n"
            "});\n"
            "const guardBranch = stepIntoTrace.events.find((e) => e.branch_options && e.branch_options.length > 1);\n"
            "const errorOpt = guardBranch ? guardBranch.branch_options.find((o) => o.is_error) : null;\n"
            "const overrideMap = {};\n"
            "if (guardBranch && errorOpt) overrideMap[guardBranch.branch_key] = errorOpt.target_step_id;\n"
            "const errorTrace = wt.StaticWalkthroughGenerator.generate(graph, {\n"
            "  rootId: 'pipeline.py::run_pipeline',\n"
            "  granularity: 'step',\n"
            "  stepInto: true,\n"
            "  branchOverrides: overrideMap,\n"
            "});\n"
            "const tryBranch = stepIntoTrace.events.find((e) => (e.branch_options || []).some((o) => o.kind === 'exception'));\n"
            "const excOpt = tryBranch ? tryBranch.branch_options.find((o) => o.kind === 'exception') : null;\n"
            "const excOverrides = {};\n"
            "if (tryBranch && excOpt) excOverrides[tryBranch.branch_key] = excOpt.target_step_id;\n"
            "const catchTrace = wt.StaticWalkthroughGenerator.generate(graph, {\n"
            "  rootId: 'pipeline.py::run_pipeline',\n"
            "  granularity: 'step',\n"
            "  stepInto: true,\n"
            "  branchOverrides: excOverrides,\n"
            "});\n"
            "console.log(JSON.stringify({\n"
            "  intoHasChildSteps: stepIntoTrace.events.some((e) => e.fn_id === 'pipeline.py::transform' && e.kind === 'step'),\n"
            "  intoHasReturn: stepIntoTrace.events.some((e) => e.kind === 'return' && e.fn_id === 'pipeline.py::run_pipeline'),\n"
            "  intoMaxDepth: Math.max(...stepIntoTrace.events.map((e) => e.call_stack.length)),\n"
            "  intoAvoidsThrowByDefault: !stepIntoTrace.events.some((e) => e.kind === 'throw'),\n"
            "  guardHasFlashedEdges: Boolean(guardBranch && guardBranch.flashed_edges.length > 0),\n"
            "  overHasChildSteps: stepOverTrace.events.some((e) => e.fn_id === 'pipeline.py::transform'),\n"
            "  overHasStepOverCall: stepOverTrace.events.some((e) => e.kind === 'call' && e.step_over === true),\n"
            "  errorTraceHasThrow: errorTrace.events.some((e) => e.kind === 'throw'),\n"
            "  catchTraceHasCatch: catchTrace.events.some((e) => e.kind === 'catch'),\n"
            "}));\n"
        )
        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        res = json.loads(proc.stdout)

        # Step Into entra en `transform()` (pasando por los pasos hijos dentro del bucle `for`) y retorna.
        self.assertTrue(res["intoHasChildSteps"])
        self.assertTrue(res["intoHasReturn"])
        self.assertEqual(res["intoMaxDepth"], 2)

        # Happy path por defecto evita `raise ValueError("empty")` y emite destello rojo en `flashed_edges`.
        self.assertTrue(res["intoAvoidsThrowByDefault"])
        self.assertTrue(res["guardHasFlashedEdges"])

        # Step Over NO apila `transform`, emite pulso `step_over: true`.
        self.assertFalse(res["overHasChildSteps"])
        self.assertTrue(res["overHasStepOverCall"])

        # Overrides manuales permiten simular la rama `throw` y la rama `except`/`catch`.
        self.assertTrue(res["errorTraceHasThrow"])
        self.assertTrue(res["catchTraceHasCatch"])


class TestCycle8CanvasGeometryAndContracts(unittest.TestCase):
    def test_orthogonal_polyline_extraction_arc_length_and_return_reversal_in_cytoscape(self) -> None:
        script = (
            "const fs = require('fs');\n"
            f"const cytoscape = require({json.dumps(str(VIEWER_DIR / 'vendor' / 'cytoscape.min.js'))});\n"
            f"const wt = require({json.dumps(str(WALKTHROUGH_JS))});\n"
            f"const appSrc = fs.readFileSync({json.dumps(str(VIEWER_DIR / 'app.js'))}, 'utf8');\n"
            "const extractFn = (name) => {\n"
            "  const start = appSrc.indexOf('function ' + name + '(');\n"
            "  if (start < 0) throw new Error('Missing ' + name);\n"
            "  let pDepth = 0, bodyStart = start;\n"
            "  for (let i = start; i < appSrc.length; i++) {\n"
            "    if (appSrc[i] === '(') pDepth++;\n"
            "    else if (appSrc[i] === ')') { pDepth--; if (pDepth === 0) { bodyStart = i + 1; break; } }\n"
            "  }\n"
            "  let depth = 0, started = false, end = bodyStart;\n"
            "  for (let i = bodyStart; i < appSrc.length; i++) {\n"
            "    if (appSrc[i] === '{') { depth++; started = true; }\n"
            "    else if (appSrc[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }\n"
            "  }\n"
            "  return appSrc.slice(start, end);\n"
            "};\n"
            "eval([extractFn('buildStylesheet'), extractFn('convertElkPointsToCytoscapeSegments')].join('\\n'));\n"
            "// Polilínea ortogonal 90°: (100,122) -> (100,200) -> (320,200) -> (320,278)\n"
            "const srcEnd = { x: 100, y: 122 };\n"
            "const tgtEnd = { x: 320, y: 278 };\n"
            "const interior = [{ x: 100, y: 200 }, { x: 320, y: 200 }];\n"
            "const seg = convertElkPointsToCytoscapeSegments(interior, srcEnd, tgtEnd);\n"
            "const cy = cytoscape({\n"
            "  headless: true,\n"
            "  styleEnabled: true,\n"
            "  style: buildStylesheet(),\n"
            "  layout: { name: 'preset' },\n"
            "  elements: [\n"
            "    { data: { id: 'fnA', type: 'function', role: 'entry', label: 'fnA()' }, position: { x: 100, y: 100 } },\n"
            "    { data: { id: 'fnB', type: 'function', role: 'transform', label: 'fnB()' }, position: { x: 320, y: 300 } },\n"
            "    {\n"
            "      data: {\n"
            "        id: 'pe_1', source: 'fnA', target: 'fnB', kind: 'call', edgeType: 'direct_call',\n"
            "        rawEdgeIds: ['e_1'], srcEndpoint: '0px 22px', tgtEndpoint: '0px -22px',\n"
            "        segWeights: seg.weights, segDistances: seg.distances,\n"
            "      },\n"
            "      classes: 'elk-routed',\n"
            "    },\n"
            "  ],\n"
            "});\n"
            "const fwdPoly = wt.extractEdgePolyline(cy, 'fnA', 'fnB', 'e_1', { reversed: false });\n"
            "const revPoly = wt.extractEdgePolyline(cy, 'fnB', 'fnA', 'e_1', { reversed: true });\n"
            "const isOrthogonal = (pts) => {\n"
            "  if (!pts || pts.length < 2) return false;\n"
            "  for (let i = 1; i < pts.length; i++) {\n"
            "    const dx = Math.abs(pts[i].x - pts[i - 1].x);\n"
            "    const dy = Math.abs(pts[i].y - pts[i - 1].y);\n"
            "    if (dx > 1.5 && dy > 1.5) return false;\n"
            "  }\n"
            "  return true;\n"
            "};\n"
            "const samples = [0, 0.25, 0.5, 0.75, 1].map((t) => wt.samplePolylineAt(fwdPoly, t));\n"
            "// Verificar proyección pan/zoom: x=100, y=200 con pan=(50,-20), zoom=1.5 -> (200, 280)\n"
            "const projected = wt.modelToScreen({ x: 100, y: 200 }, { x: 50, y: -20 }, 1.5);\n"
            "cy.destroy();\n"
            "console.log(JSON.stringify({\n"
            "  fwdLen: fwdPoly.length,\n"
            "  fwdOrtho: isOrthogonal(fwdPoly),\n"
            "  revOrtho: isOrthogonal(revPoly),\n"
            "  revStartsAtTgt: Math.hypot(revPoly[0].x - fwdPoly[fwdPoly.length - 1].x, revPoly[0].y - fwdPoly[fwdPoly.length - 1].y) < 1,\n"
            "  revEndsAtSrc: Math.hypot(revPoly[revPoly.length - 1].x - fwdPoly[0].x, revPoly[revPoly.length - 1].y - fwdPoly[0].y) < 1,\n"
            "  midSampleY: Math.round(samples[2].y),\n"
            "  projected,\n"
            "}));\n"
        )
        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        res = json.loads(proc.stdout)

        self.assertGreaterEqual(res["fwdLen"], 4)
        self.assertTrue(res["fwdOrtho"])
        self.assertTrue(res["revOrtho"])
        self.assertTrue(res["revStartsAtTgt"])
        self.assertTrue(res["revEndsAtSrc"])
        # El punto medio en longitud de arco cae sobre el tramo horizontal intermedio (y = 200).
        self.assertAlmostEqual(res["midSampleY"], 200, delta=2)
        self.assertEqual(res["projected"], {"x": 200, "y": 280})

    def test_viewer_walkthrough_html_css_js_contracts_and_syntax(self) -> None:
        html = (VIEWER_DIR / "index.html").read_text(encoding="utf-8")
        css = (VIEWER_DIR / "styles.css").read_text(encoding="utf-8")
        js = (VIEWER_DIR / "app.js").read_text(encoding="utf-8")

        for token in (
            'id="btn-walkthrough"',
            'id="walkthrough-canvas"',
            'id="walkthrough-hud"',
            'id="btn-wt-play"',
            'id="btn-wt-prev"',
            'id="btn-wt-next"',
            'id="wt-counter"',
            'id="wt-speed-select"',
            'id="btn-wt-mode-pulse"',
            'id="btn-wt-mode-step"',
            'id="btn-wt-step-into"',
            'id="wt-branch-bar"',
            'id="walkthrough-action-card"',
            'id="walkthrough-stack-panel"',
            'id="wt-stack-list"',
            'id="wt-code-preview-box"',
            'id="btn-inspector-walkthrough-flow"',
        ):
            self.assertIn(token, html)

        # `walkthrough.js` debe cargarse antes que `app.js`.
        self.assertLess(html.index('<script src="./walkthrough.js"></script>'), html.index('<script src="./app.js"></script>'))

        for token in (
            ".walkthrough-canvas",
            ".fw-walkthrough-canvas",
            ".walkthrough-hud",
            ".walkthrough-action-card",
            ".walkthrough-stack-panel",
            ".wt-branch-pill",
            ".wt-code-row.active",
        ):
            self.assertIn(token, css)

        self.assertIn("function initWalkthroughController(", js)
        self.assertIn("function highlightFloatingCodeLineRange(", js)

        for js_file in (WALKTHROUGH_JS, VIEWER_DIR / "app.js"):
            check = subprocess.run(["node", "--check", str(js_file)], capture_output=True, text=True, check=False)
            self.assertEqual(check.returncode, 0, f"Syntax error in {js_file.name}: {check.stderr}")


if __name__ == "__main__":
    unittest.main()
