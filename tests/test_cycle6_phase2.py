"""Pruebas de Fase 6.2 (Ciclo 6): anclaje estricto por ámbito de contenedor, Nivel 3+ y recálculo local de aristas."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codemap.discovery import discover_files
from codemap.graph_builder import build_graph
from codemap.notes_storage import load_notes, reconcile_notes, save_notes, update_notes
from codemap.parsers import parse_file
from codemap.paths import normalize_path

REPO_ROOT = Path(__file__).resolve().parent.parent
VIEWER_DIR = REPO_ROOT / "codemap" / "viewer"


def _build_graph_for(target_path: Path, is_single_file: bool) -> dict:
    norm = normalize_path(target_path)
    if is_single_file:
        analysis = parse_file(target_path)
        assert analysis is not None
        analyses = [analysis]
        root_dir = normalize_path(target_path.parent)
    else:
        analyses = [a for p in discover_files(target_path) if (a := parse_file(p)) is not None]
        root_dir = norm
    return build_graph(
        analyses,
        target_path=norm,
        root_dir=root_dir,
        is_single_file=is_single_file,
        include_private=False,
    )


class TestCycle6Phase2NotesStorageProtection(unittest.TestCase):
    def _sample_graph(self, fn_id: str = "app.py::process", step_ids: tuple[str, ...] = ("n1", "n2", "n3")) -> dict:
        return {
            "nodes": [
                {"id": "app.py", "type": "file", "label": "app.py", "parent": None},
                {
                    "id": fn_id,
                    "type": "function",
                    "label": fn_id.split("::")[-1] + "()",
                    "parent": "app.py",
                    "fingerprint": "fp_process_v1",
                    "internal_flow": [
                        {"id": sid, "label": f"step {sid}", "role": "transform", "kind": "step", "is_container": False}
                        for sid in step_ids
                    ],
                },
            ],
            "edges": [],
        }

    def test_reconcile_preserves_flow_step_and_layer_pins(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp) / "cache"
            target = normalize_path(Path(tmp) / "proj")
            graph = self._sample_graph()

            with patch.dict(os.environ, {"CODEMAP_CACHE_DIR": str(cache_dir)}):
                update_notes(
                    target,
                    {
                        "nodes": {
                            "layer::0": {
                                "pinned": True,
                                "pinned_positions": {"layers_functions": {"x": 320.5, "y": 140.0}},
                            },
                            "app.py": {
                                "pinned": True,
                                "pinned_positions": {"functions": {"x": 500.0, "y": 280.0}},
                            },
                            "app.py::process::n2": {
                                "pinned": True,
                                "pinned_positions": {
                                    "intra": {"x": 110.5, "y": 420.0},
                                    "creation_intra": {"x": 180.0, "y": 510.0},
                                },
                            },
                        }
                    },
                    graph,
                )

                reconciled = reconcile_notes(target, graph)
                self.assertIn("layer::0", reconciled["nodes"])
                self.assertIn("app.py", reconciled["nodes"])
                self.assertIn("app.py::process::n2", reconciled["nodes"])
                self.assertEqual(reconciled["orphans"], [])
                self.assertEqual(
                    reconciled["nodes"]["app.py::process::n2"]["pinned_positions"]["intra"],
                    {"x": 110.5, "y": 420.0},
                )
                self.assertEqual(
                    reconciled["nodes"]["app.py::process::n2"]["pinned_positions"]["creation_intra"],
                    {"x": 180.0, "y": 510.0},
                )

    def test_reconcile_migrates_flow_steps_on_function_rename_and_filters_stale_pins(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp) / "cache"
            target = normalize_path(Path(tmp) / "proj")
            graph_v1 = self._sample_graph("app.py::old_fn", ("n1", "n2", "n3", "n4", "n5"))
            graph_v2 = self._sample_graph("app.py::renamed_fn", ("n1", "n2", "n3"))

            with patch.dict(os.environ, {"CODEMAP_CACHE_DIR": str(cache_dir)}):
                save_notes(
                    target,
                    {
                        "nodes": {
                            "app.py::old_fn": {
                                "note": "Orquestador principal",
                                "pinned": True,
                                "pinned_positions": {"intra": {"x": 400.0, "y": 250.0}},
                                "last_fingerprint": "fp_process_v1",
                            },
                            "app.py::old_fn::n2": {
                                "pinned": True,
                                "pinned_positions": {"intra": {"x": 410.0, "y": 310.0}},
                            },
                            # Paso desaparecido SOLO con pin (sin nota ni rol): debe descartarse sin ir a orphans.
                            "app.py::old_fn::n4": {
                                "pinned": True,
                                "pinned_positions": {"intra": {"x": 420.0, "y": 390.0}},
                            },
                            # Paso desaparecido CON nota humana: debe conservarse en orphans.
                            "app.py::old_fn::n5": {
                                "note": "Validar borde nulo aquí",
                                "pinned": True,
                                "pinned_positions": {"intra": {"x": 430.0, "y": 450.0}},
                            },
                            "layer::2": {
                                "pinned": True,
                                "pinned_positions": {"layers_intra": {"x": 700.0, "y": 600.0}},
                            },
                        },
                        "orphans": [],
                    },
                )

                reconciled = reconcile_notes(target, graph_v2)
                nodes = reconciled["nodes"]

                self.assertNotIn("app.py::old_fn", nodes)
                self.assertIn("app.py::renamed_fn", nodes)
                self.assertEqual(nodes["app.py::renamed_fn"]["note"], "Orquestador principal")

                # El paso n2 migró automáticamente al nuevo ID de la función renombrada.
                self.assertNotIn("app.py::old_fn::n2", nodes)
                self.assertIn("app.py::renamed_fn::n2", nodes)
                self.assertEqual(
                    nodes["app.py::renamed_fn::n2"]["pinned_positions"]["intra"],
                    {"x": 410.0, "y": 310.0},
                )

                # layer::2 intacto.
                self.assertIn("layer::2", nodes)

                # n4 (solo pin) NO contamina orphans; n5 (con nota) SÍ se preserva en orphans.
                orphan_ids = [o["old_id"] for o in reconciled["orphans"]]
                self.assertNotIn("app.py::old_fn::n4", orphan_ids)
                self.assertIn("app.py::old_fn::n5", orphan_ids)

                # Recarga desde disco consistente.
                reloaded = load_notes(target)
                self.assertEqual(set(reloaded["nodes"]), {"app.py::renamed_fn", "app.py::renamed_fn::n2", "layer::2"})


class TestCycle6Phase2ScopedPinningAndLocalRerouting(unittest.TestCase):
    def test_viewer_contracts_and_syntax(self) -> None:
        js = (VIEWER_DIR / "app.js").read_text(encoding="utf-8")
        self.assertIn("function filterOutermostDraggedNodes(", js)
        self.assertIn("function collectScopeAndExternalEdges(", js)
        self.assertIn("function rerouteExternalEdgesLocally(", js)
        self.assertIn("function applyScopedPinsToLayout(", js)
        self.assertIn("function handleNodeDragFreeBatch(", js)
        self.assertIn('selector: \'edge[taxiDir = "leftward"]\'', js)
        self.assertIn('state.cy.on("grab", "node"', js)
        self.assertNotIn("cyNode && cyNode.length > 0 && !cyNode.isParent()", js)

        check = subprocess.run(["node", "--check", str(VIEWER_DIR / "app.js")], capture_output=True, text=True, check=False)
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_container_drag_and_reload_preserve_internal_routes_without_child_contamination(self) -> None:
        """Verifica arrastre de contenedor, deduplicación multi-selección, Nivel 3+ y rerouting local sin badLine."""
        graphs = {
            "examples_multi": _build_graph_for(REPO_ROOT / "examples" / "multi", False),
            "python_parser": _build_graph_for(REPO_ROOT / "codemap" / "parsers" / "python_parser.py", True),
        }

        harness = (
            "const fs = require('fs');\n"
            f"const ELK = require({json.dumps(str(VIEWER_DIR / 'vendor' / 'elk.bundled.js'))});\n"
            f"const cytoscape = require({json.dumps(str(VIEWER_DIR / 'vendor' / 'cytoscape.min.js'))});\n"
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
            "  const re = new RegExp('const ' + name + ' = (\\\\{[\\\\s\\\\S]*?\\\\}|\"[^\"]+\"|\\\\d+);');\n"
            "  const m = src.match(re);\n"
            "  if (!m) throw new Error('Missing const ' + name);\n"
            "  return m[0].replace(/^const /, 'var ');\n"
            "};\n"
            "var _activeDragExternalEdges = [];\n"
            "var _pendingDragFreeNodes = new Map();\n"
            "var _dragFreeFlushScheduled = false;\n"
            "var postedBodies = [];\n"
            "global.fetch = async (_url, opts) => {\n"
            "  const body = JSON.parse(opts.body);\n"
            "  postedBodies.push(body);\n"
            "  for (const [k, v] of Object.entries(body.nodes || {})) state.notes.nodes[k] = v;\n"
            "  return { ok: true, json: async () => state.notes };\n"
            "};\n"
            "const state = {\n"
            "  activeLevel: 3,\n"
            "  expandedFunctions: new Set(),\n"
            "  groupingMode: 'folders',\n"
            "  layoutOrderMode: 'execution',\n"
            "  notes: { nodes: {}, orphans: [] },\n"
            "  nodesById: new Map(),\n"
            "  floatingWindows: new Map(),\n"
            "  selectedNodeId: null,\n"
            "  cy: null,\n"
            "};\n"
            "function getActiveFlowStepMaps() { return { flow: null, nodeOrder: new Map(), edgeOrder: new Map() }; }\n"
            "function updatePinButton() {}\n"
            "function countDescendantFunctions() { return 0; }\n"
            "function countHiddenUtilityCallees() { return 0; }\n"
            "eval([\n"
            "  matchConst('ELK_LAYOUT_OPTIONS'),\n"
            "  matchConst('CREATION_FILE_ELK_OPTIONS'),\n"
            "  matchConst('CREATION_CONTAINER_ELK_OPTIONS'),\n"
            "  matchConst('CREATION_ROW_STAGGER_PX'),\n"
            "  matchConst('CREATION_MACRO_EDGE_PREFIX'),\n"
            "  matchConst('LEGACY_PIN_FALLBACK_KEY'),\n"
            "  extractFn('getCurrentLayoutContextKey'),\n"
            "  extractFn('getPinnedPositionForContext'),\n"
            "  extractFn('isPinnedInCurrentContext'),\n"
            "  extractFn('getNoteEntry'),\n"
            "  extractFn('buildDisplayLabel'),\n"
            "  extractFn('buildStylesheet'),\n"
            "  extractFn('estimateWrappedTextMetrics'),\n"
            "  extractFn('estimateFlowStepSize'),\n"
            "  extractFn('appendInternalFlowElements'),\n"
            "  extractFn('appendInternalFlowEdges'),\n"
            "  extractFn('estimateNodeSize'),\n"
            "  extractFn('estimateCompoundHeaderWidth'),\n"
            "  extractFn('computeElkSubtreeWidth'),\n"
            "  extractFn('assignCreationBands'),\n"
            "  extractFn('computeCreationPartition'),\n"
            "  extractFn('computeIntraTierFoundationDepths'),\n"
            "  extractFn('buildCreationElkInput'),\n"
            "  extractFn('buildPostStaggerBoxes'),\n"
            "  extractFn('stitchCrossFileEdgeOntoMacroCorridor'),\n"
            "  extractFn('buildElkInput'),\n"
            "  extractFn('collectAbsolutePositions'),\n"
            "  extractFn('collectAllLayoutedEdges'),\n"
            "  extractFn('shiftElkSubtreeY'),\n"
            "  extractFn('applyCreationRowStagger'),\n"
            "  extractFn('computeStaggeredChannelShiftY'),\n"
            "  extractFn('adjustElkSectionPoints'),\n"
            "  extractFn('convertElkPointsToCytoscapeSegments'),\n"
            "  extractFn('applyElkEdgeRoutes'),\n"
            "  extractFn('filterOutermostDraggedNodes'),\n"
            "  extractFn('collectScopeAndExternalEdges'),\n"
            "  extractFn('computeDynamicTaxiDirection'),\n"
            "  extractFn('rerouteExternalEdgesLocally'),\n"
            "  extractFn('applyScopedPinsToLayout'),\n"
            "  extractFn('refreshCyNodeMetadata'),\n"
            "  extractFn('handleNodeDragFreeBatch'),\n"
            "].join('\\n'));\n"
            "function verifyRoutedEdge(cyEdge) {\n"
            "  const parsePx = (s, pos) => {\n"
            "    if (typeof s !== 'string') return null;\n"
            "    const p = s.trim().split(/\\s+/);\n"
            "    if (p.length !== 2) return null;\n"
            "    const dx = parseFloat(p[0]), dy = parseFloat(p[1]);\n"
            "    return Number.isFinite(dx) && Number.isFinite(dy) ? { x: pos.x + dx, y: pos.y + dy } : null;\n"
            "  };\n"
            "  const sEnd = parsePx(cyEdge.data('srcEndpoint'), cyEdge.source().position());\n"
            "  const tEnd = parsePx(cyEdge.data('tgtEndpoint'), cyEdge.target().position());\n"
            "  if (!sEnd || !tEnd) return false;\n"
            "  const dx = tEnd.x - sEnd.x, dy = tEnd.y - sEnd.y, len = Math.hypot(dx, dy);\n"
            "  if (!Number.isFinite(len) || len < 2) return false;\n"
            "  const ws = cyEdge.data('segWeights') || [], ds = cyEdge.data('segDistances') || [];\n"
            "  if (!ws.length || ws.length !== ds.length) return false;\n"
            "  const nx = -dy / len, ny = dx / len;\n"
            "  const pts = ws.map((w, i) => ({ x: sEnd.x + w * dx + ds[i] * nx, y: sEnd.y + w * dy + ds[i] * ny }));\n"
            "  if (Math.hypot(pts[0].x - sEnd.x, pts[0].y - sEnd.y) < 0.9) return false;\n"
            "  const last = pts[pts.length - 1];\n"
            "  if (Math.hypot(last.x - tEnd.x, last.y - tEnd.y) < 0.9) return false;\n"
            "  return true;\n"
            "}\n"
            "const graphs = JSON.parse(fs.readFileSync(0, 'utf8'));\n"
            "(async () => {\n"
            "  const elk = new ELK();\n"
            "  // === ESCENARIO 1: Arrastre de archivo en examples/multi (Nivel 3) ===\n"
            "  const multi = graphs.examples_multi;\n"
            "  state.activeLevel = 3;\n"
            "  state.layoutOrderMode = 'execution';\n"
            "  state.notes = { nodes: {}, orphans: [] };\n"
            "  state.nodesById = new Map(multi.nodes.map((n) => [n.id, n]));\n"
            "  const mNodes = multi.nodes\n"
            "    .filter((n) => ['module', 'file', 'function'].includes(n.type))\n"
            "    .map((n) => ({ data: { id: n.id, parent: n.parent || undefined, type: n.type, role: n.role || n.type, label: n.label, line: n.line || 0, pinned: 'false', collapsed: 'false', expandedFn: 'false' } }));\n"
            "  const mNodeIds = new Set(mNodes.map((n) => n.data.id));\n"
            "  const mEdges = multi.edges\n"
            "    .filter((e) => mNodeIds.has(e.source) && mNodeIds.has(e.target) && e.source !== e.target)\n"
            "    .map((e, i) => ({ data: { id: 'me_' + i, source: e.source, target: e.target, kind: 'call', label: '', confidence: 'confirmed' } }));\n"
            "  const mElkIn = buildElkInput(mNodes, mEdges, { forceExecution: true });\n"
            "  const mLayouted = await elk.layout(mElkIn);\n"
            "  const mElkPos = new Map(), mOffsets = new Map([['root', { x: 0, y: 0 }]]);\n"
            "  collectAbsolutePositions(mLayouted, 0, 0, mElkPos, mOffsets);\n"
            "  const cy1 = cytoscape({ headless: true, styleEnabled: true, layout: { name: 'preset' }, style: buildStylesheet(), elements: [...mNodes, ...mEdges] });\n"
            "  state.cy = cy1;\n"
            "  cy1.batch(() => { cy1.nodes().forEach((n) => { if (!n.isParent()) { const p = mElkPos.get(n.id()); if (p) n.position(p); } }); });\n"
            "  cy1.batch(() => { applyElkEdgeRoutes(cy1, mLayouted, mElkPos, mOffsets, new Set(), 'downward', null, null); });\n"
            "\n"
            "  // Elegir un archivo que tenga >=1 arista interna Y >=1 arista externa.\n"
            "  let targetFile = null;\n"
            "  cy1.nodes('[type = \"file\"]').forEach((f) => {\n"
            "    if (targetFile || !f.isParent()) return;\n"
            "    const descIds = new Set(f.descendants().map((d) => d.id()));\n"
            "    descIds.add(f.id());\n"
            "    let intern = 0, extern = 0;\n"
            "    cy1.edges().forEach((e) => {\n"
            "      const s = descIds.has(e.source().id()), t = descIds.has(e.target().id());\n"
            "      if (s && t) intern++; else if (s !== t) extern++;\n"
            "    });\n"
            "    if (intern > 0 && extern > 0) targetFile = f;\n"
            "  });\n"
            "  if (!targetFile) throw new Error('No file with internal+external edges in examples/multi');\n"
            "  const fScope = new Set([targetFile.id(), ...targetFile.descendants().map((d) => d.id())]);\n"
            "  const internalBefore = new Map();\n"
            "  const externalEdgesList = [];\n"
            "  cy1.edges().forEach((e) => {\n"
            "    const s = fScope.has(e.source().id()), t = fScope.has(e.target().id());\n"
            "    if (s && t) {\n"
            "      internalBefore.set(e.id(), {\n"
            "        routed: e.hasClass('elk-routed'),\n"
            "        w: JSON.stringify(e.data('segWeights')),\n"
            "        d: JSON.stringify(e.data('segDistances')),\n"
            "      });\n"
            "    } else if (s !== t) {\n"
            "      externalEdgesList.push(e);\n"
            "    }\n"
            "  });\n"
            "\n"
            "  // Trasladar rígidamente el contenedor archivo (+260, +140) y disparar handleNodeDragFreeBatch con [archivo, hijo] (dedup jerárquica).\n"
            "  const firstChild = targetFile.descendants().filter((d) => !d.isParent())[0];\n"
            "  targetFile.descendants().forEach((d) => {\n"
            "    if (!d.isParent()) { const p = d.position(); d.position({ x: p.x + 260, y: p.y + 140 }); }\n"
            "  });\n"
            "  cy1.nodes(':parent').updateCompoundBounds(true);\n"
            "  const expectedMovedCenter = { ...targetFile.position() };\n"
            "  postedBodies = [];\n"
            "  await handleNodeDragFreeBatch([targetFile, firstChild]);\n"
            "\n"
            "  const dragPostedKeys = Object.keys(postedBodies[0].nodes);\n"
            "  const contaminatedChildren = targetFile.descendants().filter((d) => d.data('pinned') === 'true').map((d) => d.id());\n"
            "  let internalPreserved = true;\n"
            "  for (const [eid, snap] of internalBefore.entries()) {\n"
            "    const e = cy1.getElementById(eid);\n"
            "    if (e.hasClass('elk-routed') !== snap.routed || JSON.stringify(e.data('segWeights')) !== snap.w || JSON.stringify(e.data('segDistances')) !== snap.d) {\n"
            "      internalPreserved = false;\n"
            "    }\n"
            "  }\n"
            "  const externalInvalidAfterDrag = externalEdgesList.filter((e) => e.hasClass('elk-routed') && !verifyRoutedEdge(e)).map((e) => e.id());\n"
            "  const externalRoutedAfterDrag = externalEdgesList.filter((e) => e.hasClass('elk-routed')).length;\n"
            "  cy1.destroy();\n"
            "\n"
            "  // === ESCENARIO 2: Recarga con contenedor fijado (aplicación rígida top-down sin contaminar hijos) ===\n"
            "  const cy2 = cytoscape({ headless: true, styleEnabled: true, layout: { name: 'preset' }, style: buildStylesheet(), elements: [...mNodes, ...mEdges] });\n"
            "  const mElkPos2 = new Map(), mOffsets2 = new Map([['root', { x: 0, y: 0 }]]);\n"
            "  collectAbsolutePositions(mLayouted, 0, 0, mElkPos2, mOffsets2);\n"
            "  cy2.batch(() => { cy2.nodes().forEach((n) => { if (!n.isParent()) { const p = mElkPos2.get(n.id()); if (p) n.position(p); } }); });\n"
            "  const pinMap = new Map([[targetFile.id(), { x: Math.round(expectedMovedCenter.x * 10) / 10, y: Math.round(expectedMovedCenter.y * 10) / 10 }]]);\n"
            "  const pinRes = applyScopedPinsToLayout(cy2, mElkPos2, mOffsets2, pinMap);\n"
            "  const extAfterReload = [];\n"
            "  applyElkEdgeRoutes(cy2, mLayouted, mElkPos2, mOffsets2, pinRes.individuallyPinnedIds, 'downward', null, null, pinRes.rigidShiftByNodeId, extAfterReload);\n"
            "  rerouteExternalEdgesLocally(cy2, extAfterReload);\n"
            "  const reloadedFileCenter = cy2.getElementById(targetFile.id()).position();\n"
            "  const reloadInternalAllRouted = Array.from(internalBefore.keys()).every((eid) => {\n"
            "    const e = cy2.getElementById(eid);\n"
            "    return e.hasClass('elk-routed') && verifyRoutedEdge(e);\n"
            "  });\n"
            "  const reloadExternalAllValid = extAfterReload.every((e) => !e.hasClass('elk-routed') || verifyRoutedEdge(e));\n"
            "  cy2.destroy();\n"
            "\n"
            "  // === ESCENARIO 3: Nivel 3+ (expandedFn + flowContainer + paso flow hoja) en python_parser.py (Creación) ===\n"
            "  const py = graphs.python_parser;\n"
            "  state.activeLevel = 4;\n"
            "  state.layoutOrderMode = 'creation';\n"
            "  state.notes = { nodes: {}, orphans: [] };\n"
            "  state.nodesById = new Map(py.nodes.map((n) => [n.id, n]));\n"
            "  const fnTarget = py.nodes.find((n) => n.id === 'python_parser.py::walk_try_statement');\n"
            "  const pNodes = [], pNodeIds = new Set();\n"
            "  for (const n of py.nodes) {\n"
            "    if (!['module', 'file', 'function'].includes(n.type)) continue;\n"
            "    const exp = n.id === fnTarget.id;\n"
            "    pNodeIds.add(n.id);\n"
            "    pNodes.push({ data: { id: n.id, parent: n.parent || undefined, type: n.type, role: n.role || n.type, label: n.label, line: n.line || 0, expandedFn: exp ? 'true' : 'false', collapsed: 'false', pinned: 'false' } });\n"
            "    if (exp) appendInternalFlowElements(n, pNodes, pNodeIds);\n"
            "  }\n"
            "  const pEdges = py.edges\n"
            "    .filter((e) => pNodeIds.has(e.source) && pNodeIds.has(e.target) && e.source !== e.target)\n"
            "    .map((e, i) => ({ data: { id: 'pc_' + i, source: e.source, target: e.target, kind: 'call', label: '', confidence: 'confirmed' } }));\n"
            "  appendInternalFlowEdges(pNodes, pEdges, pNodeIds);\n"
            "  const pBuilt = buildCreationElkInput(pNodes, pEdges);\n"
            "  const pLayouted = await elk.layout(pBuilt.elkGraph);\n"
            "  const pElkPos = new Map(), pOffsets = new Map([['root', { x: 0, y: 0 }]]);\n"
            "  collectAbsolutePositions(pLayouted, 0, 0, pElkPos, pOffsets);\n"
            "  const pDataById = new Map(pNodes.map((n) => [n.data.id, n.data]));\n"
            "  const pShifted = applyCreationRowStagger(pLayouted, pElkPos, new Set(), pDataById, CREATION_ROW_STAGGER_PX);\n"
            "  const cy3 = cytoscape({ headless: true, styleEnabled: true, layout: { name: 'preset' }, style: buildStylesheet(), elements: [...pNodes, ...pEdges] });\n"
            "  state.cy = cy3;\n"
            "  cy3.batch(() => { cy3.nodes().forEach((n) => { if (!n.isParent()) { const p = pElkPos.get(n.id()); if (p) n.position(p); } }); });\n"
            "  cy3.batch(() => { applyElkEdgeRoutes(cy3, pLayouted, pElkPos, pOffsets, new Set(), 'downward', pShifted.staggerMeta, pBuilt.creationMeta); });\n"
            "\n"
            "  // Arrastrar un flowContainer (n23) y un paso flow hoja (n5 rombo de decisión) y verificar persistencia en creation_intra.\n"
            "  const loopNode = cy3.getElementById('python_parser.py::walk_try_statement::n23');\n"
            "  const diaNode = cy3.getElementById('python_parser.py::walk_try_statement::n5');\n"
            "  loopNode.descendants().forEach((d) => { if (!d.isParent()) { const p = d.position(); d.position({ x: p.x + 120, y: p.y + 40 }); } });\n"
            "  postedBodies = [];\n"
            "  await handleNodeDragFreeBatch([loopNode]);\n"
            "  const loopPostedKeys = Object.keys(postedBodies[0].nodes);\n"
            "  const loopChildPinned = loopNode.descendants().filter((d) => d.data('pinned') === 'true').length;\n"
            "  const loopInternalAllRouted = cy3.edges().filter((e) => {\n"
            "    const ids = new Set([loopNode.id(), ...loopNode.descendants().map((d) => d.id())]);\n"
            "    return ids.has(e.source().id()) && ids.has(e.target().id());\n"
            "  }).every((e) => e.hasClass('elk-routed') && verifyRoutedEdge(e));\n"
            "\n"
            "  const dp = diaNode.position();\n"
            "  diaNode.position({ x: dp.x + 90, y: dp.y + 20 });\n"
            "  postedBodies = [];\n"
            "  await handleNodeDragFreeBatch([diaNode]);\n"
            "  const diaPostedKeys = Object.keys(postedBodies[0].nodes);\n"
            "  const diaHasCreationIntra = Boolean(state.notes.nodes[diaNode.id()].pinned_positions.creation_intra);\n"
            "  const invalidFlowAfterDrag = cy3.edges('[kind = \"flow\"]').filter((e) => e.hasClass('elk-routed') && !verifyRoutedEdge(e)).map((e) => e.id());\n"
            "  cy3.destroy();\n"
            "\n"
            "  console.log(JSON.stringify({\n"
            "    targetFileId: targetFile.id(),\n"
            "    dragPostedKeys,\n"
            "    contaminatedChildren,\n"
            "    internalPreserved,\n"
            "    externalCount: externalEdgesList.length,\n"
            "    externalRoutedAfterDrag,\n"
            "    externalInvalidAfterDrag,\n"
            "    reloadCenterDeltaX: Math.abs(reloadedFileCenter.x - expectedMovedCenter.x),\n"
            "    reloadCenterDeltaY: Math.abs(reloadedFileCenter.y - expectedMovedCenter.y),\n"
            "    reloadInternalAllRouted,\n"
            "    reloadExternalAllValid,\n"
            "    reloadExternalCount: extAfterReload.length,\n"
            "    loopPostedKeys,\n"
            "    loopChildPinned,\n"
            "    loopInternalAllRouted,\n"
            "    diaPostedKeys,\n"
            "    diaHasCreationIntra,\n"
            "    invalidFlowAfterDrag,\n"
            "  }));\n"
            "})();\n"
        )

        proc = subprocess.run(
            ["node", "-e", harness],
            input=json.dumps(graphs),
            capture_output=True,
            text=True,
            check=True,
        )
        res = json.loads(proc.stdout)

        # Escenario 1: Arrastre de archivo (+ deduplicación jerárquica).
        self.assertEqual(res["dragPostedKeys"], [res["targetFileId"]])
        self.assertEqual(res["contaminatedChildren"], [])
        self.assertTrue(res["internalPreserved"], "Aristas internas del archivo arrastrado debían permanecer intactas")
        self.assertGreater(res["externalCount"], 0)
        self.assertEqual(res["externalRoutedAfterDrag"], res["externalCount"])
        self.assertEqual(res["externalInvalidAfterDrag"], [])

        # Escenario 2: Recarga aplicando pin de contenedor rígidamente.
        self.assertLess(res["reloadCenterDeltaX"], 0.6)
        self.assertLess(res["reloadCenterDeltaY"], 0.6)
        self.assertTrue(res["reloadInternalAllRouted"])
        self.assertTrue(res["reloadExternalAllValid"])
        self.assertGreater(res["reloadExternalCount"], 0)

        # Escenario 3: Nivel 3+ (flowContainer y rombo flow hoja) en Creación (1→N).
        self.assertEqual(res["loopPostedKeys"], ["python_parser.py::walk_try_statement::n23"])
        self.assertEqual(res["loopChildPinned"], 0)
        self.assertTrue(res["loopInternalAllRouted"])
        self.assertEqual(res["diaPostedKeys"], ["python_parser.py::walk_try_statement::n5"])
        self.assertTrue(res["diaHasCreationIntra"])
        self.assertEqual(res["invalidFlowAfterDrag"], [])


if __name__ == "__main__":
    unittest.main()
