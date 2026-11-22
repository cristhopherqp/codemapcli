"""Pruebas unitarias de la Fase 3 (Ciclo 3): alto contraste en Modo Foco (T), orden ↑ Creación y escalonamiento."""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

from codemap.notes_storage import VALID_LAYOUT_LEVELS

REPO_ROOT = Path(__file__).resolve().parent.parent
VIEWER_DIR = REPO_ROOT / "codemap" / "viewer"


class TestCycle3Phase3FocusAndCreationOrder(unittest.TestCase):
    def setUp(self) -> None:
        self.html = (VIEWER_DIR / "index.html").read_text(encoding="utf-8")
        self.css = (VIEWER_DIR / "styles.css").read_text(encoding="utf-8")
        self.js = (VIEWER_DIR / "app.js").read_text(encoding="utf-8")

    def test_viewer_exposes_layout_order_toggle_help_and_line_metadata(self) -> None:
        self.assertIn('id="btn-layout-order"', self.html)
        self.assertIn("Orden: ↓ Ejecución", self.html)
        self.assertIn("Clic derecho", self.html)
        self.assertIn("Orden: ↓ / ↑", self.html)
        self.assertIn(".layout-order-btn", self.css)
        self.assertIn(".layout-order-btn.creation-mode", self.css)
        self.assertIn('"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES"', self.js)
        self.assertGreaterEqual(self.js.count("line: rawNode.line || 0"), 3)
        self.assertIn('selector: \'edge[taxiDir = "upward"]\'', self.js)
        self.assertIn("function applyCreationRowStagger(", self.js)
        self.assertIn("function toggleLayoutOrderMode(", self.js)

        check = subprocess.run(
            ["node", "--check", str(VIEWER_DIR / "app.js")],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_cytoscape_focus_branch_halo_preserves_semantic_edge_colors(self) -> None:
        script = (
            "const fs = require('fs');\n"
            f"const cytoscape = require({json.dumps(str(VIEWER_DIR / 'vendor' / 'cytoscape.min.js'))});\n"
            f"const src = fs.readFileSync({json.dumps(str(VIEWER_DIR / 'app.js'))}, 'utf8');\n"
            "const extract = (name) => {\n"
            "  const idx = src.indexOf('function ' + name + '(');\n"
            "  if (idx < 0) throw new Error('Missing ' + name);\n"
            "  let depth = 0, started = false, end = idx;\n"
            "  for (let i = idx; i < src.length; i++) {\n"
            "    if (src[i] === '{') { depth++; started = true; }\n"
            "    else if (src[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }\n"
            "  }\n"
            "  return src.slice(idx, end);\n"
            "};\n"
            "eval(extract('buildStylesheet'));\n"
            "const cy = cytoscape({\n"
            "  headless: true,\n"
            "  styleEnabled: true,\n"
            "  style: buildStylesheet(),\n"
            "  elements: [\n"
            "    { data: { id: 'a', type: 'function', role: 'entry', label: 'a()' } },\n"
            "    { data: { id: 'b', type: 'function', role: 'transform', label: 'b()' } },\n"
            "    { data: { id: 'c', type: 'function', role: 'io', label: 'c()' } },\n"
            "    { data: { id: 'd', type: 'function', role: 'transform', label: 'd()' } },\n"
            "    { data: { id: 'e_ev', source: 'a', target: 'b', kind: 'call', edgeType: 'event_listener', confidence: 'confirmed', taxiDir: 'upward' } },\n"
            "    { data: { id: 'e_cb', source: 'a', target: 'c', kind: 'call', edgeType: 'callback_ref', confidence: 'confirmed', taxiDir: 'downward' } },\n"
            "    { data: { id: 'e_dir', source: 'a', target: 'd', kind: 'call', edgeType: 'direct_call', confidence: 'confirmed', taxiDir: 'downward' } },\n"
            "  ],\n"
            "});\n"
            "const eEv = cy.getElementById('e_ev').addClass('trace-callee trace-branch-active');\n"
            "const eCb = cy.getElementById('e_cb').addClass('trace-callee trace-branch-active');\n"
            "const eDir = cy.getElementById('e_dir').addClass('trace-callee trace-branch-active');\n"
            "const nB = cy.getElementById('b').addClass('trace-callee trace-branch-active');\n"
            "console.log(JSON.stringify({\n"
            "  evLineColor: eEv.style('line-color'),\n"
            "  evArrowColor: eEv.style('target-arrow-color'),\n"
            "  evUnderlayColor: eEv.style('underlay-color'),\n"
            "  evUnderlayOpacity: parseFloat(eEv.style('underlay-opacity')),\n"
            "  evUnderlayPadding: parseFloat(eEv.style('underlay-padding')),\n"
            "  evWidth: parseFloat(eEv.style('width')),\n"
            "  evArrowScale: parseFloat(eEv.style('arrow-scale')),\n"
            "  evZIndex: parseInt(eEv.style('z-index'), 10),\n"
            "  evTaxiDir: eEv.style('taxi-direction'),\n"
            "  cbLineColor: eCb.style('line-color'),\n"
            "  dirLineColor: eDir.style('line-color'),\n"
            "  nodeBorderColor: nB.style('border-color'),\n"
            "  nodeUnderlayColor: nB.style('underlay-color'),\n"
            "  nodeUnderlayOpacity: parseFloat(nB.style('underlay-opacity')),\n"
            "}));\n"
            "cy.destroy();\n"
        )
        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        res = json.loads(proc.stdout)

        # Flecha `event_listener` conserva su ámbar semántico `#f59e0b` (rgb(245, 158, 11)) con halo blanco-hielo `#f8fafc`.
        self.assertEqual(res["evLineColor"], "rgb(245,158,11)")
        self.assertEqual(res["evArrowColor"], "rgb(245,158,11)")
        self.assertEqual(res["evUnderlayColor"], "rgb(248,250,252)")
        self.assertAlmostEqual(res["evUnderlayOpacity"], 0.42, places=2)
        self.assertAlmostEqual(res["evUnderlayPadding"], 5.0, places=2)
        self.assertAlmostEqual(res["evWidth"], 4.0, places=2)
        self.assertAlmostEqual(res["evArrowScale"], 1.3, places=2)
        self.assertEqual(res["evZIndex"], 40)
        self.assertEqual(res["evTaxiDir"], "upward")

        # `callback_ref` conserva `#c084fc` y `direct_call` usa `#fbbf24` en `trace-callee`.
        self.assertEqual(res["cbLineColor"], "rgb(192,132,252)")
        self.assertEqual(res["dirLineColor"], "rgb(251,191,36)")

        # Nodo destino activo con borde y halo blanco-hielo `#f8fafc`.
        self.assertEqual(res["nodeBorderColor"], "rgb(248,250,252)")
        self.assertEqual(res["nodeUnderlayColor"], "rgb(248,250,252)")
        self.assertAlmostEqual(res["nodeUnderlayOpacity"], 0.24, places=2)

    def test_elk_creation_order_staggering_non_overlap_and_context_keys(self) -> None:
        script = (
            "const fs = require('fs');\n"
            f"const ELK = require({json.dumps(str(VIEWER_DIR / 'vendor' / 'elk.bundled.js'))});\n"
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
            "if (!elkOptMatch) throw new Error('Missing ELK_LAYOUT_OPTIONS');\n"
            "const staggerMatch = src.match(/const CREATION_ROW_STAGGER_PX = \\d+;/);\n"
            "const state = { activeLevel: 3, expandedFunctions: new Set(), groupingMode: 'folders', layoutOrderMode: 'execution' };\n"
            "eval([\n"
            "  elkOptMatch[0].replace(/^const /, 'var '),\n"
            "  staggerMatch[0].replace(/^const /, 'var '),\n"
            "  extractFn('getCurrentLayoutContextKey'),\n"
            "  extractFn('estimateWrappedTextMetrics'),\n"
            "  extractFn('estimateFlowStepSize'),\n"
            "  extractFn('estimateNodeSize'),\n"
            "  extractFn('estimateCompoundHeaderWidth'),\n"
            "  extractFn('computeElkSubtreeWidth'),\n"
            "  extractFn('buildElkInput'),\n"
            "  extractFn('collectAbsolutePositions'),\n"
            "  extractFn('shiftElkSubtreeY'),\n"
            "  extractFn('applyCreationRowStagger'),\n"
            "].join('\\n'));\n"
            "(async () => {\n"
            "  const elk = new ELK();\n"
            "  // 1. Verificar todas las claves de contexto para pinned_positions en ambos modos.\n"
            "  const contextKeys = [];\n"
            "  for (const mode of ['execution', 'creation']) {\n"
            "    state.layoutOrderMode = mode;\n"
            "    for (const grp of ['folders', 'layers']) {\n"
            "      state.groupingMode = grp;\n"
            "      for (const lvl of [1, 2, 3, 4]) {\n"
            "        state.activeLevel = lvl;\n"
            "        contextKeys.push(getCurrentLayoutContextKey());\n"
            "      }\n"
            "    }\n"
            "  }\n"
            "  state.groupingMode = 'folders';\n"
            "  state.activeLevel = 3;\n"
            "\n"
            "  // 2. Grafo con 3 helpers hermanas (desordenadas adrede en la entrada) llamadas por `main` (L50).\n"
            "  const visibleNodes = [\n"
            "    { data: { id: 'f.js', type: 'file', label: 'f.js', line: 0 } },\n"
            "    { data: { id: 'f.js::h3', parent: 'f.js', type: 'function', role: 'transform', label: 'h3()', line: 30 } },\n"
            "    { data: { id: 'f.js::main', parent: 'f.js', type: 'function', role: 'entry', label: 'main()', line: 50 } },\n"
            "    { data: { id: 'f.js::h1', parent: 'f.js', type: 'function', role: 'transform', label: 'h1()', line: 10 } },\n"
            "    { data: { id: 'f.js::h2', parent: 'f.js', type: 'function', role: 'transform', label: 'h2()', line: 20 } },\n"
            "  ];\n"
            "  const visibleEdges = [\n"
            "    { data: { id: 'e1', source: 'f.js::main', target: 'f.js::h1', label: '' } },\n"
            "    { data: { id: 'e2', source: 'f.js::main', target: 'f.js::h2', label: '' } },\n"
            "    { data: { id: 'e3', source: 'f.js::main', target: 'f.js::h3', label: '' } },\n"
            "  ];\n"
            "\n"
            "  // Modo Ejecución (DOWN): main arriba, helpers abajo.\n"
            "  state.layoutOrderMode = 'execution';\n"
            "  const downInput = buildElkInput(visibleNodes, visibleEdges);\n"
            "  const downChildOrder = downInput.children[0].children.map((c) => c.id);\n"
            "  const downLayout = await elk.layout(downInput);\n"
            "  const downPos = new Map();\n"
            "  collectAbsolutePositions(downLayout, 0, 0, downPos);\n"
            "\n"
            "  // Modo Creación (UP): helpers arriba escalonadas (+14px) y main abajo sin solaparse.\n"
            "  state.layoutOrderMode = 'creation';\n"
            "  const upInput = buildElkInput(visibleNodes, visibleEdges);\n"
            "  const upLayout = await elk.layout(upInput);\n"
            "  const upPos = new Map();\n"
            "  collectAbsolutePositions(upLayout, 0, 0, upPos);\n"
            "  const origLayerGap = upPos.get('f.js::main').y - upPos.get('f.js::h3').y;\n"
            "  const dataById = new Map(visibleNodes.map((n) => [n.data.id, n.data]));\n"
            "  const shifted = applyCreationRowStagger(upLayout, upPos, new Set(), dataById, CREATION_ROW_STAGGER_PX);\n"
            "\n"
            "  // Caso con nodo fijado (h2 pinned): no debe desplazarse.\n"
            "  const upPosPinned = new Map();\n"
            "  collectAbsolutePositions(upLayout, 0, 0, upPosPinned);\n"
            "  const h2BeforePin = upPosPinned.get('f.js::h2').y;\n"
            "  const shiftedWithPin = applyCreationRowStagger(upLayout, upPosPinned, new Set(['f.js::h2']), dataById, CREATION_ROW_STAGGER_PX);\n"
            "\n"
            "  // Verificar que los pasos de flujo intra-función (`type === 'flow'`) NO se reordenan alfabéticamente (s2 antes que s10).\n"
            "  const flowNodes = [\n"
            "    { data: { id: 'fn', type: 'function', expandedFn: 'true', label: 'fn()', line: 1 } },\n"
            "    { data: { id: 'fn::s2', parent: 'fn', type: 'flow', role: 'transform', label: 'step 2', line: 0 } },\n"
            "    { data: { id: 'fn::s10', parent: 'fn', type: 'flow', role: 'transform', label: 'step 10', line: 0 } },\n"
            "  ];\n"
            "  const flowInput = buildElkInput(flowNodes, []);\n"
            "  const flowChildOrder = flowInput.children[0].children.map((c) => c.id);\n"
            "\n"
            "  console.log(JSON.stringify({\n"
            "    contextKeys,\n"
            "    downDirection: downInput.layoutOptions['elk.direction'],\n"
            "    upDirection: upInput.layoutOptions['elk.direction'],\n"
            "    modelOrderStrategy: upInput.layoutOptions['elk.layered.considerModelOrder.strategy'],\n"
            "    downChildOrder,\n"
            "    flowChildOrder,\n"
            "    downMainY: downPos.get('f.js::main').y,\n"
            "    downH1Y: downPos.get('f.js::h1').y,\n"
            "    upH1Y: upPos.get('f.js::h1').y,\n"
            "    upH2Y: upPos.get('f.js::h2').y,\n"
            "    upH3Y: upPos.get('f.js::h3').y,\n"
            "    upMainY: upPos.get('f.js::main').y,\n"
            "    origLayerGap,\n"
            "    shifted: Array.from(shifted).sort(),\n"
            "    h2BeforePin,\n"
            "    h2AfterPin: upPosPinned.get('f.js::h2').y,\n"
            "    h3AfterPinDelta: upPosPinned.get('f.js::h3').y - upPosPinned.get('f.js::h1').y,\n"
            "    shiftedWithPin: Array.from(shiftedWithPin).sort(),\n"
            "  }));\n"
            "})();\n"
        )
        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        res = json.loads(proc.stdout)

        # Todas las claves generadas por getCurrentLayoutContextKey() deben estar permitidas en notes_storage.py.
        for key in res["contextKeys"]:
            self.assertIn(key, VALID_LAYOUT_LEVELS, f"Clave no soportada en notes_storage: {key}")
        self.assertIn("creation_functions", res["contextKeys"])
        self.assertIn("creation_layers_functions", res["contextKeys"])

        # Opciones ELKjs y ordenación por `line` ascendente (sin alterar pasos intra-función).
        self.assertEqual(res["downDirection"], "DOWN")
        self.assertEqual(res["upDirection"], "UP")
        self.assertEqual(res["modelOrderStrategy"], "NODES_AND_EDGES")
        self.assertEqual(res["downChildOrder"], ["f.js::h1", "f.js::h2", "f.js::h3", "f.js::main"])
        self.assertEqual(res["flowChildOrder"], ["fn::s2", "fn::s10"])

        # Dirección vertical invertida entre ↓ Ejecución y ↑ Creación.
        self.assertLess(res["downMainY"], res["downH1Y"])
        self.assertLess(res["upH1Y"], res["upMainY"])

        # Escalonamiento exacto de +14px entre hermanas en la misma fila (h1 -> h2 -> h3).
        self.assertAlmostEqual(res["upH2Y"] - res["upH1Y"], 14.0, places=2)
        self.assertAlmostEqual(res["upH3Y"] - res["upH2Y"], 14.0, places=2)

        # Capa inferior (`main`) desplazada hacia abajo preservando exactamente el espacio inter-capa original de ELK (sin solaparse).
        self.assertAlmostEqual(res["upMainY"] - res["upH3Y"], res["origLayerGap"], places=2)
        self.assertGreaterEqual(res["upMainY"] - res["upH3Y"], 64.0)

        # Nodos escalonados/desplazados reportados para desactivar `elk-routed` y usar `taxi` dinámico.
        self.assertEqual(res["shifted"], ["f.js::h2", "f.js::h3", "f.js::main"])

        # Nodo fijado (`h2`) queda intacto; solo las hermanas no fijadas (`h1`, `h3`) se escalonan (+14px).
        self.assertAlmostEqual(res["h2AfterPin"], res["h2BeforePin"], places=2)
        self.assertAlmostEqual(res["h3AfterPinDelta"], 14.0, places=2)
        self.assertNotIn("f.js::h2", res["shiftedWithPin"])


if __name__ == "__main__":
    unittest.main()
