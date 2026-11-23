"""Pruebas unitarias de Orden de Creación estricto (1→N) en todos los niveles, corredores macro cosidos y estilos."""

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

HARNESS_PREAMBLE = (
    "const fs = require('fs');\n"
    f"const ELK = require({json.dumps(str(VIEWER_DIR / 'vendor' / 'elk.bundled.js'))});\n"
    f"const cytoscape = require({json.dumps(str(VIEWER_DIR / 'vendor' / 'cytoscape.min.js'))});\n"
    f"const src = fs.readFileSync({json.dumps(str(VIEWER_DIR / 'app.js'))}, 'utf8');\n"
    "const extractFn = (name) => {\n"
    "  const idx = src.indexOf('function ' + name + '(');\n"
    "  if (idx < 0) throw new Error('Missing ' + name);\n"
    "  let pDepth = 0, bodyStart = idx;\n"
    "  for (let i = idx; i < src.length; i++) {\n"
    "    if (src[i] === '(') pDepth++;\n"
    "    else if (src[i] === ')') { pDepth--; if (pDepth === 0) { bodyStart = i + 1; break; } }\n"
    "  }\n"
    "  let depth = 0, started = false, end = bodyStart;\n"
    "  for (let i = bodyStart; i < src.length; i++) {\n"
    "    if (src[i] === '{') { depth++; started = true; }\n"
    "    else if (src[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }\n"
    "  }\n"
    "  return src.slice(idx, end);\n"
    "};\n"
    "const matchConst = (name) => {\n"
    "  const re = new RegExp('const ' + name + ' = (\\\\{[\\\\s\\\\S]*?\\\\}|\"[^\"]+\"|\\\\d+);');\n"
    "  const m = src.match(re);\n"
    "  if (!m) throw new Error('Missing const ' + name);\n"
    "  return m[0].replace(/^const /, 'var ');\n"
    "};\n"
    "const state = { activeLevel: 3, expandedFunctions: new Set(), groupingMode: 'folders', layoutOrderMode: 'creation' };\n"
    "eval([\n"
    "  matchConst('ELK_LAYOUT_OPTIONS'),\n"
    "  matchConst('CREATION_FILE_ELK_OPTIONS'),\n"
    "  matchConst('CREATION_CONTAINER_ELK_OPTIONS'),\n"
    "  matchConst('CREATION_ROW_STAGGER_PX'),\n"
    "  matchConst('CREATION_MACRO_EDGE_PREFIX'),\n"
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
    "].join('\\n'));\n"
)


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


class TestCycle5StrictCreationOrder(unittest.TestCase):
    def setUp(self) -> None:
        self.html = (VIEWER_DIR / "index.html").read_text(encoding="utf-8")
        self.js = (VIEWER_DIR / "app.js").read_text(encoding="utf-8")

    def test_config_js_strict_1_to_10_order_bands_and_zero_crossings(self) -> None:
        """Verifica orden exacto 1→10, bandas 2-3, +14px y 0 cruces sobre el grafo real de 10 funciones de config.js."""
        script = HARNESS_PREAMBLE + (
            "(async () => {\n"
            "  const elk = new ELK();\n"
            "  const fns = [\n"
            "    { id: 'src/config.js::ConfigError.constructor', label: 'ConfigError.constructor()', line: 27 },\n"
            "    { id: 'src/config.js::isPlainObject', label: 'isPlainObject()', line: 38 },\n"
            "    { id: 'src/config.js::assertNonEmptyString', label: 'assertNonEmptyString()', line: 49 },\n"
            "    { id: 'src/config.js::assertNumber', label: 'assertNumber()', line: 68 },\n"
            "    { id: 'src/config.js::validateHttpUrl', label: 'validateHttpUrl()', line: 94 },\n"
            "    { id: 'src/config.js::validateEndpointPath', label: 'validateEndpointPath()', line: 121 },\n"
            "    { id: 'src/config.js::validateSampling', label: 'validateSampling()', line: 136 },\n"
            "    { id: 'src/config.js::validateModelConfig', label: 'validateModelConfig()', line: 156 },\n"
            "    { id: 'src/config.js::resolveSafePath', label: 'resolveSafePath()', line: 180 },\n"
            "    { id: 'src/config.js::validateConfig', label: 'validateConfig()', line: 201 },\n"
            "  ];\n"
            "  const visibleNodes = [\n"
            "    { data: { id: 'src', type: 'module', label: 'src/', line: 0, archLayer: 3 } },\n"
            "    { data: { id: 'src/config.js', parent: 'src', type: 'file', label: 'config.js', line: 0, archLayer: 3 } },\n"
            "    ...fns.map((f) => ({ data: { id: f.id, parent: 'src/config.js', type: 'function', role: 'transform', label: f.label, line: f.line, archLayer: 3 } })),\n"
            "  ];\n"
            "  const rawPairs = [\n"
            "    ['assertNonEmptyString', 'ConfigError.constructor'],\n"
            "    ['assertNumber', 'ConfigError.constructor'],\n"
            "    ['validateHttpUrl', 'ConfigError.constructor'],\n"
            "    ['validateHttpUrl', 'assertNonEmptyString'],\n"
            "    ['validateEndpointPath', 'ConfigError.constructor'],\n"
            "    ['validateEndpointPath', 'assertNonEmptyString'],\n"
            "    ['validateSampling', 'isPlainObject'],\n"
            "    ['validateSampling', 'assertNumber'],\n"
            "    ['validateModelConfig', 'ConfigError.constructor'],\n"
            "    ['validateModelConfig', 'isPlainObject'],\n"
            "    ['validateModelConfig', 'assertNonEmptyString'],\n"
            "    ['validateModelConfig', 'assertNumber'],\n"
            "    ['validateModelConfig', 'validateHttpUrl'],\n"
            "    ['validateModelConfig', 'validateEndpointPath'],\n"
            "    ['validateModelConfig', 'validateSampling'],\n"
            "    ['validateModelConfig', 'resolveSafePath'],\n"
            "    ['resolveSafePath', 'ConfigError.constructor'],\n"
            "    ['resolveSafePath', 'assertNonEmptyString'],\n"
            "    ['validateConfig', 'ConfigError.constructor'],\n"
            "    ['validateConfig', 'isPlainObject'],\n"
            "    ['validateConfig', 'assertNonEmptyString'],\n"
            "    ['validateConfig', 'validateModelConfig'],\n"
            "    ['validateConfig', 'resolveSafePath'],\n"
            "  ];\n"
            "  const visibleEdges = rawPairs.map(([s, t], i) => ({\n"
            "    data: { id: 'e' + i, source: 'src/config.js::' + s, target: 'src/config.js::' + t, label: '', kind: 'call', confidence: 'confirmed' },\n"
            "  }));\n"
            "\n"
            "  const { elkGraph, creationMeta } = buildCreationElkInput(visibleNodes, visibleEdges);\n"
            "  const layouted = await elk.layout(elkGraph);\n"
            "  const elkPos = new Map();\n"
            "  const offsets = new Map([['root', { x: 0, y: 0 }]]);\n"
            "  collectAbsolutePositions(layouted, 0, 0, elkPos, offsets);\n"
            "  const dataById = new Map(visibleNodes.map((n) => [n.data.id, n.data]));\n"
            "  const shifted = applyCreationRowStagger(layouted, elkPos, new Set(), dataById, CREATION_ROW_STAGGER_PX);\n"
            "\n"
            "  const cy = cytoscape({ headless: true, styleEnabled: true, style: buildStylesheet(), elements: [...visibleNodes, ...visibleEdges] });\n"
            "  cy.nodes().forEach((n) => { const p = elkPos.get(n.id()); if (p && !n.isParent()) n.position(p); });\n"
            "  applyElkEdgeRoutes(cy, layouted, elkPos, offsets, new Set(), 'downward', shifted.staggerMeta, creationMeta);\n"
            "\n"
            "  const cfgNode = layouted.children[0].children[0];\n"
            "  const rawByBandOrder = [...cfgNode.children].sort((a, b) => a.y - b.y || a.x - b.x).map((c) => c.id);\n"
            "  const postStaggerYs = fns.map((f) => elkPos.get(f.id).y);\n"
            "  const boxes = buildPostStaggerBoxes(layouted, elkPos, dataById);\n"
            "  const allEdges = [];\n"
            "  collectAllLayoutedEdges(layouted, allEdges);\n"
            "  let nonOrtho = 0, crossings = 0, routedCount = 0;\n"
            "  for (const e of allEdges) {\n"
            "    const cyE = cy.getElementById(e.id);\n"
            "    if (cyE.hasClass('elk-routed')) routedCount++;\n"
            "    const sec = e.sections && e.sections[0];\n"
            "    const src = e.sources[0], tgt = e.targets[0];\n"
            "    const off = offsets.get(e.container || 'root') || { x: 0, y: 0 };\n"
            "    const pts = adjustElkSectionPoints(sec, e.container || 'root', off, src, tgt, shifted.staggerMeta);\n"
            "    for (let i = 0; i < pts.length - 1; i++) {\n"
            "      const dx = Math.abs(pts[i + 1].x - pts[i].x), dy = Math.abs(pts[i + 1].y - pts[i].y);\n"
            "      if (dx > 0.01 && dy > 0.01) nonOrtho++;\n"
            "      const x1 = Math.min(pts[i].x, pts[i + 1].x), x2 = Math.max(pts[i].x, pts[i + 1].x);\n"
            "      const y1 = Math.min(pts[i].y, pts[i + 1].y), y2 = Math.max(pts[i].y, pts[i + 1].y);\n"
            "      for (const b of boxes.leafBoxes) {\n"
            "        if (b.id === src || b.id === tgt) continue;\n"
            "        if (x2 > b.left + 1 && x1 < b.right - 1 && y2 > b.top + 1 && y1 < b.bottom - 1) crossings++;\n"
            "      }\n"
            "    }\n"
            "  }\n"
            "  console.log(JSON.stringify({\n"
            "    expectedOrder: fns.map((f) => f.id),\n"
            "    rawByBandOrder,\n"
            "    postStaggerYs,\n"
            "    routedCount,\n"
            "    totalEdges: visibleEdges.length,\n"
            "    nonOrtho,\n"
            "    crossings,\n"
            "  }));\n"
            "  cy.destroy();\n"
            "})();\n"
        )
        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        res = json.loads(proc.stdout)

        # Orden exacto 1 → 10 (arriba→abajo e izquierda→derecha) antes y después del escalonamiento +14px.
        self.assertEqual(res["rawByBandOrder"], res["expectedOrder"])
        for i in range(len(res["postStaggerYs"]) - 1):
            self.assertLess(
                res["postStaggerYs"][i],
                res["postStaggerYs"][i + 1],
                f"Y no estrictamente creciente en índice {i}: {res['postStaggerYs']}",
            )
        self.assertEqual(res["routedCount"], res["totalEdges"])
        self.assertEqual(res["nonOrtho"], 0)
        self.assertEqual(res["crossings"], 0)

    def test_all_levels_layers_expanded_fn_and_floating_window_in_creation_mode(self) -> None:
        """Verifica coherencia cimientos→ensamblaje en Nivel 1, 2, 3, 3+ (expandedFn), Capas y Ventana Flotante."""
        graph = _build_examples_multi_graph()
        script = HARNESS_PREAMBLE + (
            "const graph = JSON.parse(fs.readFileSync(0, 'utf8'));\n"
            "(async () => {\n"
            "  const elk = new ELK();\n"
            "  // 1. Nivel 1 sintético (4 módulos: utils -> services -> controllers -> app)\n"
            "  const l1Nodes = [\n"
            "    { data: { id: 'mod_app', type: 'module', label: 'app/', collapsed: 'true', archLayer: 0 } },\n"
            "    { data: { id: 'mod_utils', type: 'module', label: 'utils/', collapsed: 'true', archLayer: 3 } },\n"
            "    { data: { id: 'mod_ctrl', type: 'module', label: 'controllers/', collapsed: 'true', archLayer: 1 } },\n"
            "    { data: { id: 'mod_svc', type: 'module', label: 'services/', collapsed: 'true', archLayer: 2 } },\n"
            "  ];\n"
            "  const l1Edges = [\n"
            "    { data: { id: 'm1', source: 'mod_app', target: 'mod_ctrl', kind: 'call' } },\n"
            "    { data: { id: 'm2', source: 'mod_ctrl', target: 'mod_svc', kind: 'call' } },\n"
            "    { data: { id: 'm3', source: 'mod_svc', target: 'mod_utils', kind: 'call' } },\n"
            "    { data: { id: 'm4', source: 'mod_app', target: 'mod_utils', kind: 'call' } },\n"
            "  ];\n"
            "  const l1Built = buildCreationElkInput(l1Nodes, l1Edges);\n"
            "  const l1Lay = await elk.layout(l1Built.elkGraph);\n"
            "  const l1Order = [...l1Lay.children].sort((a, b) => a.y - b.y).map((c) => c.id);\n"
            "\n"
            "  // 2. Nivel 3 real en examples/multi con stitched macro corridors + verificación de 0 cruces\n"
            "  const visibleNodes = graph.nodes\n"
            "    .filter((n) => ['module', 'file', 'function'].includes(n.type))\n"
            "    .map((n) => ({\n"
            "      data: {\n"
            "        id: n.id, parent: n.parent || undefined, type: n.type, role: n.role || n.type,\n"
            "        label: n.label, line: n.line || 0,\n"
            "        archLayer: typeof n.arch_layer === 'number' ? n.arch_layer : undefined,\n"
            "      },\n"
            "    }));\n"
            "  const visIds = new Set(visibleNodes.map((n) => n.data.id));\n"
            "  const visibleEdges = graph.edges\n"
            "    .filter((e) => visIds.has(e.source) && visIds.has(e.target))\n"
            "    .map((e, i) => ({ data: { id: 'e' + i, source: e.source, target: e.target, kind: 'call', label: '' } }));\n"
            "  const l3Built = buildCreationElkInput(visibleNodes, visibleEdges);\n"
            "  const l3Lay = await elk.layout(l3Built.elkGraph);\n"
            "  const l3Pos = new Map();\n"
            "  const l3Off = new Map([['root', { x: 0, y: 0 }]]);\n"
            "  collectAbsolutePositions(l3Lay, 0, 0, l3Pos, l3Off);\n"
            "  const dataById = new Map(visibleNodes.map((n) => [n.data.id, n.data]));\n"
            "  const l3Shifted = applyCreationRowStagger(l3Lay, l3Pos, new Set(), dataById, CREATION_ROW_STAGGER_PX);\n"
            "  const l3Boxes = buildPostStaggerBoxes(l3Lay, l3Pos, dataById);\n"
            "\n"
            "  // Verificar stitched polylines de las 10 aristas inter-archivo -> 0 no-ortogonales, 0 cruces sobre hojas\n"
            "  const allL3ElkEdges = [];\n"
            "  collectAllLayoutedEdges(l3Lay, allL3ElkEdges);\n"
            "  const macroById = new Map();\n"
            "  for (const [k, info] of l3Built.creationMeta.macroByKey.entries()) macroById.set(info.id, { k, info });\n"
            "  const macroPts = new Map();\n"
            "  for (const e of allL3ElkEdges) {\n"
            "    if (!macroById.has(e.id)) continue;\n"
            "    const { k, info } = macroById.get(e.id);\n"
            "    const off = l3Off.get(e.container || info.lcaId || 'root') || { x: 0, y: 0 };\n"
            "    macroPts.set(k, adjustElkSectionPoints(e.sections[0], e.container || info.lcaId || 'root', off, info.fromContainer, info.toContainer, l3Shifted.staggerMeta, true));\n"
            "  }\n"
            "  const totals = new Map();\n"
            "  for (const m of l3Built.creationMeta.crossEdgeMeta.values()) totals.set(m.macroKey, (totals.get(m.macroKey) || 0) + 1);\n"
            "  const cursors = new Map();\n"
            "  let l3CrossNonOrtho = 0, l3CrossLeafHits = 0, l3CrossStitched = 0;\n"
            "  for (const e of visibleEdges) {\n"
            "    const meta = l3Built.creationMeta.crossEdgeMeta.get(e.data.id);\n"
            "    if (!meta) continue;\n"
            "    const idx = cursors.get(meta.macroKey) || 0;\n"
            "    cursors.set(meta.macroKey, idx + 1);\n"
            "    const pts = stitchCrossFileEdgeOntoMacroCorridor(e.data.source, e.data.target, macroPts.get(meta.macroKey), meta.reverseMacro, idx, totals.get(meta.macroKey), l3Boxes, meta.srcEnclosing, meta.tgtEnclosing);\n"
            "    if (pts && pts.length >= 2) l3CrossStitched++;\n"
            "    for (let i = 0; i < pts.length - 1; i++) {\n"
            "      const dx = Math.abs(pts[i + 1].x - pts[i].x), dy = Math.abs(pts[i + 1].y - pts[i].y);\n"
            "      if (dx > 0.01 && dy > 0.01) l3CrossNonOrtho++;\n"
            "      const x1 = Math.min(pts[i].x, pts[i + 1].x), x2 = Math.max(pts[i].x, pts[i + 1].x);\n"
            "      const y1 = Math.min(pts[i].y, pts[i + 1].y), y2 = Math.max(pts[i].y, pts[i + 1].y);\n"
            "      for (const b of l3Boxes.leafBoxes) {\n"
            "        if (b.id === e.data.source || b.id === e.data.target) continue;\n"
            "        if (x2 > b.left + 1 && x1 < b.right - 1 && y2 > b.top + 1 && y1 < b.bottom - 1) l3CrossLeafHits++;\n"
            "      }\n"
            "    }\n"
            "  }\n"
            "\n"
            "  // 3. Nivel 3+ (función expandida inline dentro de archivo en modo Creación sin crash de ELK)\n"
            "  const expNodes = [\n"
            "    { data: { id: 'users.py', type: 'file', label: 'users.py', line: 0, archLayer: 2 } },\n"
            "    { data: { id: 'users.py::get_user', parent: 'users.py', type: 'function', role: 'io', label: 'get_user()', line: 10 } },\n"
            "    { data: { id: 'users.py::build_report', parent: 'users.py', type: 'function', role: 'decision', label: 'build_report()', line: 22, expandedFn: 'true' } },\n"
            "    { data: { id: 'users.py::build_report::s1', parent: 'users.py::build_report', type: 'flow', role: 'entry', label: 'ENTRADA', line: 22 } },\n"
            "    { data: { id: 'users.py::build_report::s2', parent: 'users.py::build_report', type: 'flow', role: 'decision', label: 'if not users', line: 24 } },\n"
            "    { data: { id: 'users.py::build_report::s3', parent: 'users.py::build_report', type: 'flow', role: 'transform', label: 'return', line: 25 } },\n"
            "  ];\n"
            "  const expEdges = [\n"
            "    { data: { id: 'fe1', source: 'users.py::build_report::s1', target: 'users.py::build_report::s2', kind: 'flow' } },\n"
            "    { data: { id: 'fe2', source: 'users.py::build_report::s2', target: 'users.py::build_report::s3', kind: 'flow' } },\n"
            "  ];\n"
            "  const expBuilt = buildCreationElkInput(expNodes, expEdges);\n"
            "  const expLay = await elk.layout(expBuilt.elkGraph);\n"
            "  const expPos = new Map();\n"
            "  collectAbsolutePositions(expLay, 0, 0, expPos);\n"
            "\n"
            "  // 4. Capas de Flujo (layers 3 -> 2 -> 1 -> 0 de arriba abajo)\n"
            "  const layerNodes = [\n"
            "    { data: { id: 'layer::0', type: 'layer', layerIndex: 0, label: '0 · Entradas' } },\n"
            "    { data: { id: 'layer::1', type: 'layer', layerIndex: 1, label: '1 · Orquestadores' } },\n"
            "    { data: { id: 'layer::2', type: 'layer', layerIndex: 2, label: '2 · Servicios' } },\n"
            "    { data: { id: 'layer::3', type: 'layer', layerIndex: 3, label: '3 · Utilidades' } },\n"
            "    { data: { id: 'f0', parent: 'layer::0', type: 'function', label: 'main()', line: 10 } },\n"
            "    { data: { id: 'f1', parent: 'layer::1', type: 'function', label: 'ctrl()', line: 10 } },\n"
            "    { data: { id: 'f2', parent: 'layer::2', type: 'function', label: 'svc()', line: 10 } },\n"
            "    { data: { id: 'f3', parent: 'layer::3', type: 'function', label: 'util()', line: 10 } },\n"
            "  ];\n"
            "  const layerEdges = [\n"
            "    { data: { id: 'le1', source: 'f0', target: 'f1', kind: 'call' } },\n"
            "    { data: { id: 'le2', source: 'f1', target: 'f2', kind: 'call' } },\n"
            "    { data: { id: 'le3', source: 'f2', target: 'f3', kind: 'call' } },\n"
            "  ];\n"
            "  const layerBuilt = buildCreationElkInput(layerNodes, layerEdges);\n"
            "  const layerLay = await elk.layout(layerBuilt.elkGraph);\n"
            "  const layerOrder = [...layerLay.children].sort((a, b) => a.y - b.y).map((c) => c.id);\n"
            "\n"
            "  // 5. Ventana flotante de archivo (`store.tsx` con port_out arriba y port_in abajo)\n"
            "  const fwNodes = [\n"
            "    { data: { id: 'port_out::ext', type: 'port', portDir: 'out', label: 'ext()' } },\n"
            "    { data: { id: 's::ctor', type: 'function', label: 'Store.constructor()', line: 7 } },\n"
            "    { data: { id: 's::add', type: 'function', label: 'Store.add()', line: 11 } },\n"
            "    { data: { id: 's::sub', type: 'function', label: 'Store.subscribe()', line: 16 } },\n"
            "    { data: { id: 's::notify', type: 'function', label: 'Store.notify()', line: 20 } },\n"
            "    { data: { id: 's::badge', type: 'function', label: 'StoreBadge()', line: 25 } },\n"
            "    { data: { id: 'port_in::boot', type: 'port', portDir: 'in', label: 'bootstrap()' } },\n"
            "  ];\n"
            "  const fwEdges = [\n"
            "    { data: { id: 'fwe1', source: 's::add', target: 's::notify', kind: 'call' } },\n"
            "    { data: { id: 'fwe2', source: 's::notify', target: 'port_out::ext', kind: 'call' } },\n"
            "    { data: { id: 'fwe3', source: 'port_in::boot', target: 's::ctor', kind: 'call' } },\n"
            "    { data: { id: 'fwe4', source: 'port_in::boot', target: 's::add', kind: 'call' } },\n"
            "  ];\n"
            "  const fwBuilt = buildCreationElkInput(fwNodes, fwEdges, { floatingPorts: true });\n"
            "  const fwLay = await elk.layout(fwBuilt.elkGraph);\n"
            "  const fwOrder = [...fwLay.children].sort((a, b) => a.y - b.y || a.x - b.x).map((c) => c.id);\n"
            "\n"
            "  console.log(JSON.stringify({\n"
            "    l1Order,\n"
            "    backendOrder: [\n"
            "      ['utils.py', l3Boxes.boxOf.get('backend/utils.py').top],\n"
            "      ['services', l3Boxes.boxOf.get('backend/services').top],\n"
            "      ['app.py', l3Boxes.boxOf.get('backend/app.py').top],\n"
            "    ],\n"
            "    frontendOrder: [\n"
            "      ['format.js', l3Boxes.boxOf.get('frontend/src/format.js').top],\n"
            "      ['api.ts', l3Boxes.boxOf.get('frontend/src/api.ts').top],\n"
            "      ['store.tsx', l3Boxes.boxOf.get('frontend/src/store.tsx').top],\n"
            "      ['main.ts', l3Boxes.boxOf.get('frontend/src/main.ts').top],\n"
            "    ],\n"
            "    l3CrossExpected: l3Built.creationMeta.crossEdgeMeta.size,\n"
            "    l3CrossStitched,\n"
            "    l3CrossNonOrtho,\n"
            "    l3CrossLeafHits,\n"
            "    expFlowDown: expPos.get('users.py::build_report::s1').y < expPos.get('users.py::build_report::s2').y && expPos.get('users.py::build_report::s2').y < expPos.get('users.py::build_report::s3').y,\n"
            "    layerOrder,\n"
            "    fwOrder,\n"
            "  }));\n"
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

        # Nivel 1: cimientos arriba → entradas abajo.
        self.assertEqual(res["l1Order"], ["mod_utils", "mod_svc", "mod_ctrl", "mod_app"])

        # Nivel 2/3 backend y frontend: utilidades → servicios/estado → entradas.
        b_y = dict(res["backendOrder"])
        self.assertLess(b_y["utils.py"], b_y["services"])
        self.assertLess(b_y["services"], b_y["app.py"])

        f_y = dict(res["frontendOrder"])
        self.assertLess(f_y["format.js"], f_y["store.tsx"])
        self.assertLess(f_y["api.ts"], f_y["store.tsx"])
        self.assertLess(f_y["store.tsx"], f_y["main.ts"])

        # Corredores macro cosidos: 100% enrutados, 0 diagonales, 0 cruces sobre hojas.
        self.assertEqual(res["l3CrossStitched"], res["l3CrossExpected"])
        self.assertEqual(res["l3CrossNonOrtho"], 0)
        self.assertEqual(res["l3CrossLeafHits"], 0)

        # Nivel 3+ (expandedFn): flujo interno sigue yendo DOWN sin romper ELK.
        self.assertTrue(res["expFlowDown"])

        # Capas de Flujo invertidas de cimientos (3) a entradas (0).
        self.assertEqual(res["layerOrder"], ["layer::3", "layer::2", "layer::1", "layer::0"])

        # Ventana flotante de archivo: port_out arriba → funciones 1→5 en orden exacto → port_in abajo.
        self.assertEqual(
            res["fwOrder"],
            ["port_out::ext", "s::ctor", "s::add", "s::sub", "s::notify", "s::badge", "port_in::boot"],
        )

    def test_parallel_corridor_lane_offset_is_strictly_clamped_within_clearance(self) -> None:
        """Verifica que con 20 aristas paralelas el desplazamiento lateral nunca invade cajas adyacentes."""
        script = HARNESS_PREAMBLE + (
            "const boxOf = new Map([\n"
            "  ['srcFile', { id: 'srcFile', isContainer: true, left: 100, right: 320, top: 400, bottom: 540, cx: 210, cy: 470 }],\n"
            "  ['tgtFile', { id: 'tgtFile', isContainer: true, left: 100, right: 320, top: 40, bottom: 180, cx: 210, cy: 110 }],\n"
            "  ['srcFn', { id: 'srcFn', isContainer: false, left: 140, right: 280, top: 480, bottom: 520, cx: 210, cy: 500 }],\n"
            "  ['blockerInSrc', { id: 'blockerInSrc', isContainer: false, left: 140, right: 280, top: 420, bottom: 460, cx: 210, cy: 440 }],\n"
            "  ['tgtFn', { id: 'tgtFn', isContainer: false, left: 140, right: 280, top: 100, bottom: 140, cx: 210, cy: 120 }],\n"
            "  ['leftNeighbor', { id: 'leftNeighbor', isContainer: true, left: 0, right: 42, top: 200, bottom: 380, cx: 21, cy: 290 }],\n"
            "  ['rightNeighbor', { id: 'rightNeighbor', isContainer: true, left: 78, right: 340, top: 200, bottom: 380, cx: 209, cy: 290 }],\n"
            "]);\n"
            "const leafBoxes = [boxOf.get('srcFn'), boxOf.get('blockerInSrc'), boxOf.get('tgtFn')];\n"
            "const containerBoxes = [boxOf.get('srcFile'), boxOf.get('tgtFile'), boxOf.get('leftNeighbor'), boxOf.get('rightNeighbor')];\n"
            "const boxes = { boxOf, leafBoxes, containerBoxes };\n"
            "// Corredor vertical en x=60 (entre leftNeighbor.right=42 y rightNeighbor.left=78 -> espacio libre exacto [47..73]).\n"
            "const macroPts = [\n"
            "  { x: 210, y: 180 },\n"
            "  { x: 210, y: 192 },\n"
            "  { x: 60, y: 192 },\n"
            "  { x: 60, y: 390 },\n"
            "  { x: 210, y: 390 },\n"
            "  { x: 210, y: 400 },\n"
            "];\n"
            "const totalLanes = 20;\n"
            "let minSpineX = Infinity, maxSpineX = -Infinity;\n"
            "let minGutterX = Infinity, maxGutterX = -Infinity;\n"
            "for (let i = 0; i < totalLanes; i++) {\n"
            "  const pts = stitchCrossFileEdgeOntoMacroCorridor('srcFn', 'tgtFn', macroPts, true, i, totalLanes, boxes, 'srcFile', 'tgtFile');\n"
            "  for (const p of pts) {\n"
            "    if (p.y > 200 && p.y < 380 && p.x < 95) {\n"
            "      minSpineX = Math.min(minSpineX, p.x);\n"
            "      maxSpineX = Math.max(maxSpineX, p.x);\n"
            "    }\n"
            "    if (p.x >= 100 && p.x <= 139) {\n"
            "      minGutterX = Math.min(minGutterX, p.x);\n"
            "      maxGutterX = Math.max(maxGutterX, p.x);\n"
            "    }\n"
            "  }\n"
            "}\n"
            "console.log(JSON.stringify({ minSpineX, maxSpineX, minGutterX, maxGutterX }));\n"
        )
        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        res = json.loads(proc.stdout)

        # Ninguno de los 20 carriles invade leftNeighbor (right=42) ni rightNeighbor (left=78).
        self.assertGreaterEqual(res["minSpineX"], 46.5)
        self.assertLessEqual(res["maxSpineX"], 73.5)
        # El gutter interno de srcFile (left=100..136) queda estrictamente dentro de [108..128].
        self.assertGreaterEqual(res["minGutterX"], 108.5)
        self.assertLessEqual(res["maxGutterX"], 127.5)

    def test_creation_cross_edge_cytoscape_selectors_and_ui_labels(self) -> None:
        """Verifica en Cytoscape.js real que `.creation-cross-edge` atenúa a 0.48 y restaura al 100% con todas las clases activas."""
        self.assertIn("Orden: Creación (1→N)", self.js)
        self.assertIn("Orden: ↓ Ejecución / Creación (1→N)", self.html)

        script = HARNESS_PREAMBLE + (
            "const cy = cytoscape({\n"
            "  headless: true,\n"
            "  styleEnabled: true,\n"
            "  style: buildStylesheet(),\n"
            "  elements: [\n"
            "    { data: { id: 'a', type: 'function', role: 'entry', label: 'a()' } },\n"
            "    { data: { id: 'b', type: 'function', role: 'transform', label: 'b()' } },\n"
            "    { data: { id: 'e1', source: 'a', target: 'b', kind: 'call', edgeType: 'direct_call', confidence: 'confirmed' } },\n"
            "  ],\n"
            "});\n"
            "const e = cy.getElementById('e1');\n"
            "const measure = (classes, select = false) => {\n"
            "  e.classes(classes);\n"
            "  if (select) e.select(); else e.unselect();\n"
            "  return {\n"
            "    opacity: parseFloat(e.style('opacity')),\n"
            "    width: parseFloat(e.style('width')),\n"
            "    textOpacity: parseFloat(e.style('text-opacity')),\n"
            "  };\n"
            "};\n"
            "console.log(JSON.stringify({\n"
            "  resting: measure('creation-cross-edge'),\n"
            "  dimmed: measure('creation-cross-edge dimmed'),\n"
            "  muted: measure('creation-cross-edge edge-muted'),\n"
            "  revealIn: measure('creation-cross-edge edge-reveal-in'),\n"
            "  revealOut: measure('creation-cross-edge edge-reveal-out'),\n"
            "  revealInternal: measure('creation-cross-edge edge-reveal-internal'),\n"
            "  flowActive: measure('creation-cross-edge flow-active-edge'),\n"
            "  traceCaller: measure('creation-cross-edge trace-caller'),\n"
            "  traceCallee: measure('creation-cross-edge trace-callee'),\n"
            "  traceBranch: measure('creation-cross-edge trace-branch-active'),\n"
            "  selected: measure('creation-cross-edge', true),\n"
            "}));\n"
            "cy.destroy();\n"
        )
        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        res = json.loads(proc.stdout)

        self.assertAlmostEqual(res["resting"]["opacity"], 0.48, places=2)
        self.assertAlmostEqual(res["resting"]["width"], 1.5, places=2)
        self.assertAlmostEqual(res["dimmed"]["opacity"], 0.15, places=2)
        self.assertAlmostEqual(res["muted"]["opacity"], 0.10, places=2)

        # Todas las clases reales de interacción restauran opacity=1 y grosor completo.
        self.assertAlmostEqual(res["revealIn"]["opacity"], 1.0, places=2)
        self.assertAlmostEqual(res["revealIn"]["width"], 2.8, places=2)
        self.assertAlmostEqual(res["revealOut"]["opacity"], 1.0, places=2)
        self.assertAlmostEqual(res["revealOut"]["width"], 2.8, places=2)
        self.assertAlmostEqual(res["revealInternal"]["opacity"], 1.0, places=2)
        self.assertAlmostEqual(res["revealInternal"]["width"], 2.4, places=2)
        self.assertAlmostEqual(res["flowActive"]["opacity"], 1.0, places=2)
        self.assertAlmostEqual(res["flowActive"]["width"], 3.2, places=2)
        self.assertAlmostEqual(res["traceCaller"]["opacity"], 1.0, places=2)
        self.assertAlmostEqual(res["traceCaller"]["width"], 3.0, places=2)
        self.assertAlmostEqual(res["traceCallee"]["opacity"], 1.0, places=2)
        self.assertAlmostEqual(res["traceCallee"]["width"], 3.0, places=2)
        self.assertAlmostEqual(res["traceBranch"]["opacity"], 1.0, places=2)
        self.assertAlmostEqual(res["traceBranch"]["width"], 4.0, places=2)
        self.assertAlmostEqual(res["selected"]["opacity"], 1.0, places=2)
        self.assertAlmostEqual(res["selected"]["width"], 2.4, places=2)


if __name__ == "__main__":
    unittest.main()
