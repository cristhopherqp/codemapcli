"""Pruebas unitarias de la Fase 2 (Ciclo 4): enrutamiento ortogonal en ↑ Creación, clic central y 3 modos de código."""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

from codemap.discovery import discover_files
from codemap.graph_builder import build_graph
from codemap.parsers import parse_file
from codemap.paths import normalize_path

REPO_ROOT = Path(__file__).resolve().parent.parent
VIEWER_DIR = REPO_ROOT / "codemap" / "viewer"


def _build_examples_multi_graph() -> dict:
    root = REPO_ROOT / "examples" / "multi"
    target = normalize_path(root)
    analyses = [a for p in discover_files(root) if (a := parse_file(p)) is not None]
    return build_graph(
        analyses,
        target_path=target,
        root_dir=target,
        is_single_file=False,
        include_private=False,
    )


class TestCycle4Phase2RoutingMiddleClickAndCodeView(unittest.TestCase):
    def setUp(self) -> None:
        self.html = (VIEWER_DIR / "index.html").read_text(encoding="utf-8")
        self.css = (VIEWER_DIR / "styles.css").read_text(encoding="utf-8")
        self.js = (VIEWER_DIR / "app.js").read_text(encoding="utf-8")

    def test_creation_mode_preserves_orthogonal_elk_routing_without_crossing_nodes(self) -> None:
        graph = _build_examples_multi_graph()
        script = (
            "const fs = require('fs');\n"
            f"const ELK = require({json.dumps(str(VIEWER_DIR / 'vendor' / 'elk.bundled.js'))});\n"
            f"const cytoscape = require({json.dumps(str(VIEWER_DIR / 'vendor' / 'cytoscape.min.js'))});\n"
            f"const src = fs.readFileSync({json.dumps(str(VIEWER_DIR / 'app.js'))}, 'utf8');\n"
            "const extractFn = (name) => {\n"
            "  const idx = src.indexOf('function ' + name + '(');\n"
            "  if (idx < 0) throw new Error('Missing ' + name);\n"
            "  let depth = 0, started = false, end = idx;\n"
            "  for (let i = idx; i < src.length; i++) {\n"
            "    if (src[i] === '{') { depth++; started = true; }\n"
            "    else if (src[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }\n"
            "  }\n"
            "  return src.slice(idx, end);\n"
            "};\n"
            "const elkOptMatch = src.match(/const ELK_LAYOUT_OPTIONS = \\{[\\s\\S]*?\\};/);\n"
            "const staggerMatch = src.match(/const CREATION_ROW_STAGGER_PX = \\d+;/);\n"
            "const state = { activeLevel: 3, expandedFunctions: new Set(), groupingMode: 'folders', layoutOrderMode: 'creation' };\n"
            "eval([\n"
            "  elkOptMatch[0].replace(/^const /, 'var '),\n"
            "  staggerMatch[0].replace(/^const /, 'var '),\n"
            "  extractFn('buildStylesheet'),\n"
            "  extractFn('estimateWrappedTextMetrics'),\n"
            "  extractFn('estimateFlowStepSize'),\n"
            "  extractFn('estimateNodeSize'),\n"
            "  extractFn('estimateCompoundHeaderWidth'),\n"
            "  extractFn('computeElkSubtreeWidth'),\n"
            "  extractFn('buildElkInput'),\n"
            "  extractFn('collectAbsolutePositions'),\n"
            "  extractFn('collectAllLayoutedEdges'),\n"
            "  extractFn('shiftElkSubtreeY'),\n"
            "  extractFn('applyCreationRowStagger'),\n"
            "  extractFn('computeStaggeredChannelShiftY'),\n"
            "  extractFn('adjustElkSectionPoints'),\n"
            "  extractFn('convertElkPointsToCytoscapeSegments'),\n"
            "  extractFn('applyElkEdgeRoutes'),\n"
            "].join('\\n'));\n"
            "const graph = JSON.parse(fs.readFileSync(0, 'utf8'));\n"
            "(async () => {\n"
            "  const elk = new ELK();\n"
            "  const visibleNodes = graph.nodes\n"
            "    .filter((n) => ['module', 'file', 'function'].includes(n.type))\n"
            "    .map((n) => ({\n"
            "      data: {\n"
            "        id: n.id,\n"
            "        parent: n.parent || undefined,\n"
            "        type: n.type,\n"
            "        role: n.role || n.type,\n"
            "        label: n.label,\n"
            "        line: n.line || 0,\n"
            "      },\n"
            "    }));\n"
            "  const nodeIds = new Set(visibleNodes.map((n) => n.data.id));\n"
            "  const visibleEdges = graph.edges\n"
            "    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))\n"
            "    .map((e, i) => ({\n"
            "      data: { id: 'e' + i, source: e.source, target: e.target, label: e.event || '', kind: 'call', confidence: e.confidence || 'confirmed' },\n"
            "    }));\n"
            "\n"
            "  const elkIn = buildElkInput(visibleNodes, visibleEdges);\n"
            "  const layouted = await elk.layout(elkIn);\n"
            "  const elkPos = new Map();\n"
            "  const offsets = new Map([['root', { x: 0, y: 0 }]]);\n"
            "  collectAbsolutePositions(layouted, 0, 0, elkPos, offsets);\n"
            "  const dataById = new Map(visibleNodes.map((n) => [n.data.id, n.data]));\n"
            "  const shifted = applyCreationRowStagger(layouted, elkPos, new Set(), dataById, CREATION_ROW_STAGGER_PX);\n"
            "\n"
            "  const cy = cytoscape({ headless: true, styleEnabled: true, style: buildStylesheet(), elements: [...visibleNodes, ...visibleEdges] });\n"
            "  cy.nodes().forEach((n) => {\n"
            "    const p = elkPos.get(n.id());\n"
            "    if (p && !n.isParent()) n.position(p);\n"
            "  });\n"
            "  applyElkEdgeRoutes(cy, layouted, elkPos, offsets, new Set(), 'upward', shifted.staggerMeta);\n"
            "\n"
            "  const allEdges = [];\n"
            "  collectAllLayoutedEdges(layouted, allEdges);\n"
            "  const leafBoxes = [];\n"
            "  const collectLeaves = (node) => {\n"
            "    if (node.children && node.children.length > 0) {\n"
            "      for (const c of node.children) collectLeaves(c);\n"
            "    } else if (node.id !== 'root') {\n"
            "      const p = elkPos.get(node.id);\n"
            "      if (p) leafBoxes.push({ id: node.id, left: p.x - node.width / 2, right: p.x + node.width / 2, top: p.y - node.height / 2, bottom: p.y + node.height / 2 });\n"
            "    }\n"
            "  };\n"
            "  collectLeaves(layouted);\n"
            "\n"
            "  let edgesWithBends = 0;\n"
            "  let edgesWithBendsRouted = 0;\n"
            "  let totalRouted = 0;\n"
            "  const nonOrtho = [];\n"
            "  const crossings = [];\n"
            "  for (const e of allEdges) {\n"
            "    const sec = e.sections && e.sections[0];\n"
            "    const src = e.sources[0], tgt = e.targets[0];\n"
            "    const cyEdge = cy.getElementById(e.id);\n"
            "    const isRouted = cyEdge.hasClass('elk-routed');\n"
            "    if (isRouted) totalRouted++;\n"
            "    if (sec && Array.isArray(sec.bendPoints) && sec.bendPoints.length > 0) {\n"
            "      edgesWithBends++;\n"
            "      if (isRouted) edgesWithBendsRouted++;\n"
            "    }\n"
            "    const off = offsets.get(e.container || 'root') || { x: 0, y: 0 };\n"
            "    const pts = adjustElkSectionPoints(sec, e.container || 'root', off, src, tgt, shifted.staggerMeta);\n"
            "    for (let i = 0; i < pts.length - 1; i++) {\n"
            "      const dx = Math.abs(pts[i + 1].x - pts[i].x);\n"
            "      const dy = Math.abs(pts[i + 1].y - pts[i].y);\n"
            "      if (dx > 0.01 && dy > 0.01) {\n"
            "        nonOrtho.push({ edge: e.id, src, tgt, p1: pts[i], p2: pts[i + 1] });\n"
            "      }\n"
            "      const x1 = Math.min(pts[i].x, pts[i + 1].x), x2 = Math.max(pts[i].x, pts[i + 1].x);\n"
            "      const y1 = Math.min(pts[i].y, pts[i + 1].y), y2 = Math.max(pts[i].y, pts[i + 1].y);\n"
            "      for (const b of leafBoxes) {\n"
            "        if (b.id === src || b.id === tgt) continue;\n"
            "        if (x2 > b.left + 1 && x1 < b.right - 1 && y2 > b.top + 1 && y1 < b.bottom - 1) {\n"
            "          crossings.push({ edge: e.id, src, tgt, crossed: b.id, seg: [pts[i], pts[i + 1]] });\n"
            "        }\n"
            "      }\n"
            "    }\n"
            "  }\n"
            "\n"
            "  // Caso con un nodo fijado: solo sus aristas incidentes pierden `elk-routed`, las demás se conservan.\n"
            "  const pinnedId = 'frontend/src/main.ts::bootstrap';\n"
            "  applyElkEdgeRoutes(cy, layouted, elkPos, offsets, new Set([pinnedId]), 'upward', shifted.staggerMeta);\n"
            "  let pinnedIncidentRouted = 0;\n"
            "  let nonPinnedBendsRouted = 0;\n"
            "  for (const e of allEdges) {\n"
            "    const src = e.sources[0], tgt = e.targets[0];\n"
            "    const cyEdge = cy.getElementById(e.id);\n"
            "    const isRouted = cyEdge.hasClass('elk-routed');\n"
            "    if (src === pinnedId || tgt === pinnedId) {\n"
            "      if (isRouted) pinnedIncidentRouted++;\n"
            "    } else if (e.sections && e.sections[0] && e.sections[0].bendPoints && e.sections[0].bendPoints.length > 0) {\n"
            "      if (isRouted) nonPinnedBendsRouted++;\n"
            "    }\n"
            "  }\n"
            "\n"
            "  console.log(JSON.stringify({\n"
            "    upOptions: elkIn.layoutOptions,\n"
            "    totalEdges: allEdges.length,\n"
            "    shiftedCount: shifted.size,\n"
            "    edgesWithBends,\n"
            "    edgesWithBendsRouted,\n"
            "    totalRouted,\n"
            "    nonOrtho,\n"
            "    crossings,\n"
            "    pinnedIncidentRouted,\n"
            "    nonPinnedBendsRouted,\n"
            "  }));\n"
            "  cy.destroy();\n"
            "})();\n"
        )
        proc = subprocess.run(
            ["node", "-e", script],
            input=json.dumps(graph),
            capture_output=True,
            text=True,
            check=True,
        )
        res = json.loads(proc.stdout)

        # Espaciado reforzado en modo UP (`↑ Creación`).
        self.assertEqual(res["upOptions"]["elk.direction"], "UP")
        self.assertEqual(res["upOptions"]["elk.spacing.edgeEdge"], "16")
        self.assertEqual(res["upOptions"]["elk.layered.spacing.edgeEdgeBetweenLayers"], "16")
        self.assertEqual(res["upOptions"]["elk.layered.spacing.edgeNodeBetweenLayers"], "24")
        self.assertEqual(res["upOptions"]["elk.layered.spacing.nodeNodeBetweenLayers"], "54")

        # El escalonamiento debe activarse y aun así TODAS las aristas con bendPoints conservan `elk-routed`.
        self.assertGreater(res["shiftedCount"], 0)
        self.assertGreater(res["edgesWithBends"], 0)
        self.assertEqual(res["edgesWithBendsRouted"], res["edgesWithBends"])
        self.assertGreaterEqual(res["totalRouted"], res["edgesWithBends"])

        # Estricta ortogonalidad (0 segmentos diagonales) y 0 cruces sobre nodos hoja no incidentes.
        self.assertEqual(res["nonOrtho"], [], f"Segmentos no ortogonales detectados: {res['nonOrtho']}")
        self.assertEqual(res["crossings"], [], f"Aristas cruzando nodos escalonados: {res['crossings']}")

        # Solo nodos fijados por el usuario ceden a `taxi`; los escalonados no fijados mantienen `elk-routed`.
        self.assertEqual(res["pinnedIncidentRouted"], 0)
        self.assertGreater(res["nonPinnedBendsRouted"], 0)

    def test_middle_click_floating_window_and_pan_contracts(self) -> None:
        self.assertIn("Clic central en nodo", self.html)
        self.assertIn("Solo flujo", self.html)
        self.assertIn("Solo código", self.html)
        self.assertIn("Flujo y código", self.html)

        self.assertIn("function hitTestCyNodeAtClientPoint(", self.js)
        self.assertIn('eventTarget.addEventListener("auxclick", onAuxClick, true)', self.js)
        self.assertIn('eventTarget.removeEventListener("auxclick", onAuxClick, true)', self.js)
        self.assertIn("onMiddleClick", self.js)

        script = (
            "const fs = require('fs');\n"
            f"const src = fs.readFileSync({json.dumps(str(VIEWER_DIR / 'app.js'))}, 'utf8');\n"
            "const extractFn = (name) => {\n"
            "  const idx = src.indexOf('function ' + name + '(');\n"
            "  if (idx < 0) throw new Error('Missing ' + name);\n"
            "  let depth = 0, started = false, end = idx;\n"
            "  for (let i = idx; i < src.length; i++) {\n"
            "    if (src[i] === '{') { depth++; started = true; }\n"
            "    else if (src[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }\n"
            "  }\n"
            "  return src.slice(idx, end);\n"
            "};\n"
            "eval(extractFn('hitTestCyNodeAtClientPoint'));\n"
            "const mkNode = (id, parent, ancLen, bb) => ({\n"
            "  id: () => id,\n"
            "  visible: () => true,\n"
            "  isParent: () => parent,\n"
            "  ancestors: () => ({ length: ancLen }),\n"
            "  renderedBoundingBox: () => bb,\n"
            "});\n"
            "const nodes = [\n"
            "  mkNode('mod_backend', true, 0, { x1: 0, y1: 0, x2: 400, y2: 300 }),\n"
            "  mkNode('backend/users.py', true, 1, { x1: 20, y1: 20, x2: 360, y2: 260 }),\n"
            "  mkNode('backend/users.py::build_report', false, 2, { x1: 50, y1: 60, x2: 220, y2: 110 }),\n"
            "];\n"
            "const cyMock = {\n"
            "  container: () => ({ getBoundingClientRect: () => ({ left: 100, top: 50 }) }),\n"
            "  nodes: () => ({ forEach: (fn) => nodes.forEach(fn) }),\n"
            "};\n"
            "const hitLeaf = hitTestCyNodeAtClientPoint(cyMock, 200, 130);\n"
            "const hitFile = hitTestCyNodeAtClientPoint(cyMock, 400, 250);\n"
            "const hitEmpty = hitTestCyNodeAtClientPoint(cyMock, 50, 10);\n"
            "console.log(JSON.stringify({\n"
            "  hitLeaf: hitLeaf ? hitLeaf.id() : null,\n"
            "  hitFile: hitFile ? hitFile.id() : null,\n"
            "  hitEmpty: hitEmpty ? hitEmpty.id() : null,\n"
            "}));\n"
        )
        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        res = json.loads(proc.stdout)
        self.assertEqual(res["hitLeaf"], "backend/users.py::build_report")
        self.assertEqual(res["hitFile"], "backend/users.py")
        self.assertIsNone(res["hitEmpty"])

    def test_floating_window_three_modes_code_highlighting_and_bidirectional_sync(self) -> None:
        # Contratos CSS y JS para los 3 modos de vista.
        for token in (
            ".fw-mode-switcher",
            ".fw-mode-btn",
            ".fw-code-pane",
            ".fw-body.mode-split",
            ".fw-code-line.highlighted-step",
            ".tok-keyword",
            ".tok-string",
            ".tok-comment",
            ".tok-number",
        ):
            self.assertIn(token, self.css)

        for token in (
            "function appendHighlightedCodeTokens(",
            "function findBestFlowStepForLine(",
            "function highlightFloatingCodeForStep(",
            "function renderFloatingWindowSource(",
            "async function loadFloatingWindowSource(",
            "async function setFloatingWindowViewMode(",
            "/source?node_id=",
        ):
            self.assertIn(token, self.js)

        # Seguridad XSS: renderFloatingWindowSource y appendHighlightedCodeTokens no deben usar innerHTML.
        for fn_name in ("renderFloatingWindowSource", "appendHighlightedCodeTokens"):
            idx = self.js.index(f"function {fn_name}(")
            depth = 0
            started = False
            end = idx
            for i in range(idx, len(self.js)):
                if self.js[i] == "{":
                    depth += 1
                    started = True
                elif self.js[i] == "}":
                    depth -= 1
                    if started and depth == 0:
                        end = i + 1
                        break
            body = self.js[idx:end]
            self.assertNotIn("innerHTML", body, f"{fn_name} no debe usar innerHTML al renderizar código fuente")

        # Ejecución real en Node de `findBestFlowStepForLine`, `findFlowStepRange` y `appendHighlightedCodeTokens`.
        script = (
            "const fs = require('fs');\n"
            f"const src = fs.readFileSync({json.dumps(str(VIEWER_DIR / 'app.js'))}, 'utf8');\n"
            "const extractFn = (name) => {\n"
            "  const idx = src.indexOf('function ' + name + '(');\n"
            "  if (idx < 0) throw new Error('Missing ' + name);\n"
            "  let depth = 0, started = false, end = idx;\n"
            "  for (let i = idx; i < src.length; i++) {\n"
            "    if (src[i] === '{') { depth++; started = true; }\n"
            "    else if (src[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }\n"
            "  }\n"
            "  return src.slice(idx, end);\n"
            "};\n"
            "const kwMatch = src.match(/const CODE_KEYWORDS_BY_LANG = \\{[\\s\\S]*?\\};/);\n"
            "const state = {\n"
            "  nodesById: new Map([\n"
            "    ['fn_demo', {\n"
            "      id: 'fn_demo',\n"
            "      internal_flow: [\n"
            "        { id: 's0', line: 10, end_line: 10, is_container: false },\n"
            "        { id: 's1', line: 12, end_line: 18, is_container: true },\n"
            "        { id: 's2', line: 13, end_line: 14, is_container: false, parent_id: 's1' },\n"
            "        { id: 's3', line: 15, end_line: 17, is_container: false, parent_id: 's1' },\n"
            "      ],\n"
            "    }],\n"
            "  ]),\n"
            "};\n"
            "const document = {\n"
            "  createTextNode: (text) => ({ type: 'text', text }),\n"
            "  createElement: (tag) => ({ type: 'el', tag, className: '', textContent: '', children: [], appendChild(c) { this.children.push(c); } }),\n"
            "};\n"
            "eval([\n"
            "  kwMatch[0].replace(/^const /, 'var '),\n"
            "  extractFn('appendHighlightedCodeTokens'),\n"
            "  extractFn('findFlowStepRange'),\n"
            "  extractFn('findBestFlowStepForLine'),\n"
            "].join('\\n'));\n"
            "\n"
            "const pyLine = 'return \"<script>alert(1)</script>\" # count = 42';\n"
            "const pyHost = document.createElement('span');\n"
            "appendHighlightedCodeTokens(pyHost, pyLine, 'python');\n"
            "const pyReconstructed = pyHost.children.map((c) => c.type === 'text' ? c.text : c.textContent).join('');\n"
            "const pyClasses = pyHost.children.filter((c) => c.type === 'el').map((c) => [c.className, c.textContent]);\n"
            "\n"
            "const jsLine = 'const total = 123; // note';\n"
            "const jsHost = document.createElement('span');\n"
            "appendHighlightedCodeTokens(jsHost, jsLine, 'typescript');\n"
            "const jsReconstructed = jsHost.children.map((c) => c.type === 'text' ? c.text : c.textContent).join('');\n"
            "const jsClasses = jsHost.children.filter((c) => c.type === 'el').map((c) => [c.className, c.textContent]);\n"
            "\n"
            "const pickId = (s) => (s ? s.id : null);\n"
            "console.log(JSON.stringify({\n"
            "  stepL10: pickId(findBestFlowStepForLine('fn_demo', 10)),\n"
            "  stepL13: pickId(findBestFlowStepForLine('fn_demo', 13)),\n"
            "  stepL16: pickId(findBestFlowStepForLine('fn_demo', 16)),\n"
            "  stepL18: pickId(findBestFlowStepForLine('fn_demo', 18)),\n"
            "  stepL99: pickId(findBestFlowStepForLine('fn_demo', 99)),\n"
            "  rangeS2: findFlowStepRange('fn_demo', 's2'),\n"
            "  pyReconstructed,\n"
            "  pyClasses,\n"
            "  jsReconstructed,\n"
            "  jsClasses,\n"
            "}));\n"
        )
        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        res = json.loads(proc.stdout)

        # Selección de paso más específico (hoja sobre contenedor) y fallback al contenedor.
        self.assertEqual(res["stepL10"], "s0")
        self.assertEqual(res["stepL13"], "s2")
        self.assertEqual(res["stepL16"], "s3")
        self.assertEqual(res["stepL18"], "s1")
        self.assertIsNone(res["stepL99"])
        self.assertEqual(res["rangeS2"], {"startLine": 13, "endLine": 14})

        # Resaltado sintáctico reconstruye el texto exacto byte a byte sin perder caracteres ni interpretar HTML.
        self.assertEqual(res["pyReconstructed"], 'return "<script>alert(1)</script>" # count = 42')
        self.assertIn(["tok-keyword", "return"], res["pyClasses"])
        self.assertIn(["tok-string", '"<script>alert(1)</script>"'], res["pyClasses"])
        self.assertIn(["tok-comment", "# count = 42"], res["pyClasses"])

        self.assertEqual(res["jsReconstructed"], "const total = 123; // note")
        self.assertIn(["tok-keyword", "const"], res["jsClasses"])
        self.assertIn(["tok-number", "123"], res["jsClasses"])
        self.assertIn(["tok-comment", "// note"], res["jsClasses"])

        # Sintaxis completa de app.js.
        check = subprocess.run(
            ["node", "--check", str(VIEWER_DIR / "app.js")],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(check.returncode, 0, check.stderr)


if __name__ == "__main__":
    unittest.main()
