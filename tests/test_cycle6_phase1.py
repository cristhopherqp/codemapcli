"""Pruebas de Fase 6.1 (Ciclo 6): trazado ortogonal y visibilidad de aristas en Nivel 3+ (Intra-función)."""

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
    "const state = { activeLevel: 4, expandedFunctions: new Set(), groupingMode: 'folders', layoutOrderMode: 'execution' };\n"
    "eval([\n"
    "  matchConst('ELK_LAYOUT_OPTIONS'),\n"
    "  matchConst('CREATION_FILE_ELK_OPTIONS'),\n"
    "  matchConst('CREATION_CONTAINER_ELK_OPTIONS'),\n"
    "  matchConst('CREATION_ROW_STAGGER_PX'),\n"
    "  matchConst('CREATION_MACRO_EDGE_PREFIX'),\n"
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
    "].join('\\n'));\n"
    "function parseManualPx(str, pos) {\n"
    "  if (typeof str !== 'string') return null;\n"
    "  const parts = str.trim().split(/\\s+/);\n"
    "  if (parts.length !== 2) return null;\n"
    "  const dx = parseFloat(parts[0]);\n"
    "  const dy = parseFloat(parts[1]);\n"
    "  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;\n"
    "  return { x: pos.x + dx, y: pos.y + dy };\n"
    "}\n"
    "function verifyCytoscapeRoutedEdge(cyEdge) {\n"
    "  const srcNode = cyEdge.source();\n"
    "  const tgtNode = cyEdge.target();\n"
    "  const srcEnd = parseManualPx(cyEdge.data('srcEndpoint'), srcNode.position());\n"
    "  const tgtEnd = parseManualPx(cyEdge.data('tgtEndpoint'), tgtNode.position());\n"
    "  if (!srcEnd || !tgtEnd) return { ok: false, reason: 'missing_manual_endpoint' };\n"
    "  const dx = tgtEnd.x - srcEnd.x;\n"
    "  const dy = tgtEnd.y - srcEnd.y;\n"
    "  const len = Math.hypot(dx, dy);\n"
    "  if (!Number.isFinite(len) || len < 2) return { ok: false, reason: 'degenerate_span' };\n"
    "  const ws = cyEdge.data('segWeights') || [];\n"
    "  const ds = cyEdge.data('segDistances') || [];\n"
    "  if (!Array.isArray(ws) || ws.length === 0 || ws.length !== ds.length) {\n"
    "    return { ok: false, reason: 'empty_segments' };\n"
    "  }\n"
    "  const nx = -dy / len;\n"
    "  const ny = dx / len;\n"
    "  const segPts = [];\n"
    "  for (let i = 0; i < ws.length; i++) {\n"
    "    const w = ws[i], d = ds[i];\n"
    "    if (!Number.isFinite(w) || !Number.isFinite(d)) return { ok: false, reason: 'nan_weight_or_dist' };\n"
    "    segPts.push({ x: srcEnd.x + w * dx + d * nx, y: srcEnd.y + w * dy + d * ny });\n"
    "  }\n"
    "  if (Math.hypot(segPts[0].x - srcEnd.x, segPts[0].y - srcEnd.y) < 0.9) {\n"
    "    return { ok: false, reason: 'src_endpoint_collision_badLine' };\n"
    "  }\n"
    "  const lastSeg = segPts[segPts.length - 1];\n"
    "  if (Math.hypot(lastSeg.x - tgtEnd.x, lastSeg.y - tgtEnd.y) < 0.9) {\n"
    "    return { ok: false, reason: 'tgt_endpoint_collision_badLine' };\n"
    "  }\n"
    "  if (cyEdge.style('edge-distances') !== 'endpoints') {\n"
    "    return { ok: false, reason: 'wrong_edge_distances_' + cyEdge.style('edge-distances') };\n"
    "  }\n"
    "  return { ok: true, srcEnd, tgtEnd, segPts };\n"
    "}\n"
)


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


class TestCycle6Phase1Level3FlowEdges(unittest.TestCase):
    def test_inline_level3_plus_execution_and_creation_zero_badline_and_lca_ownership(self) -> None:
        """Verifica en examples/multi y python_parser.py que Nivel 3+ enruta 100% de aristas de flujo sin badLine."""
        graphs = {
            "examples_multi": _build_graph_for(REPO_ROOT / "examples" / "multi", False),
            "python_parser": _build_graph_for(REPO_ROOT / "codemap" / "parsers" / "python_parser.py", True),
        }

        script = HARNESS_PREAMBLE + (
            "const graphs = JSON.parse(fs.readFileSync(0, 'utf8'));\n"
            "(async () => {\n"
            "  const elk = new ELK();\n"
            "  const report = {};\n"
            "  for (const [gName, graph] of Object.entries(graphs)) {\n"
            "    report[gName] = {};\n"
            "    for (const mode of ['execution', 'creation']) {\n"
            "      state.layoutOrderMode = mode;\n"
            "      const visibleNodes = [];\n"
            "      const visibleNodeIds = new Set();\n"
            "      for (const n of graph.nodes) {\n"
            "        if (!['module', 'file', 'function'].includes(n.type)) continue;\n"
            "        const hasFlow = n.type === 'function' && Array.isArray(n.internal_flow) && n.internal_flow.length > 0;\n"
            "        visibleNodeIds.add(n.id);\n"
            "        visibleNodes.push({\n"
            "          data: {\n"
            "            id: n.id,\n"
            "            parent: n.parent || undefined,\n"
            "            type: n.type,\n"
            "            role: n.role || n.type,\n"
            "            label: n.label,\n"
            "            line: n.line || 0,\n"
            "            expandedFn: hasFlow ? 'true' : 'false',\n"
            "            collapsed: 'false',\n"
            "            archLayer: typeof n.arch_layer === 'number' ? n.arch_layer : undefined,\n"
            "          },\n"
            "        });\n"
            "        if (hasFlow) {\n"
            "          appendInternalFlowElements(n, visibleNodes, visibleNodeIds);\n"
            "        }\n"
            "      }\n"
            "      const visibleEdges = graph.edges\n"
            "        .filter((e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target) && e.source !== e.target)\n"
            "        .map((e, i) => ({\n"
            "          data: { id: 'c_' + i, source: e.source, target: e.target, label: e.event || '', kind: 'call', confidence: e.confidence || 'confirmed' },\n"
            "        }));\n"
            "      appendInternalFlowEdges(visibleNodes, visibleEdges, visibleNodeIds);\n"
            "\n"
            "      let elkGraph, creationMeta = null;\n"
            "      if (mode === 'creation') {\n"
            "        const built = buildCreationElkInput(visibleNodes, visibleEdges);\n"
            "        elkGraph = built.elkGraph;\n"
            "        creationMeta = built.creationMeta;\n"
            "      } else {\n"
            "        elkGraph = buildElkInput(visibleNodes, visibleEdges, { forceExecution: true });\n"
            "      }\n"
            "\n"
            "      // Verificar propiedad LCA en elkGraph antes del layout.\n"
            "      const parentById = new Map(visibleNodes.map((n) => [n.data.id, n.data.parent || 'root']));\n"
            "      const elkEdgeOwner = new Map();\n"
            "      const indexOwners = (node) => {\n"
            "        for (const e of node.edges || []) elkEdgeOwner.set(e.id, node.id);\n"
            "        for (const c of node.children || []) indexOwners(c);\n"
            "      };\n"
            "      indexOwners(elkGraph);\n"
            "      const lcaMismatches = [];\n"
            "      for (const e of visibleEdges) {\n"
            "        if (e.data.kind !== 'flow' || e.data.source === e.data.target) continue;\n"
            "        const pS = parentById.get(e.data.source);\n"
            "        const pT = parentById.get(e.data.target);\n"
            "        if (pS && pS === pT) {\n"
            "          const actualOwner = elkEdgeOwner.get(e.data.id);\n"
            "          if (actualOwner !== pS) {\n"
            "            lcaMismatches.push({ id: e.data.id, expected: pS, actual: actualOwner });\n"
            "          }\n"
            "        }\n"
            "      }\n"
            "\n"
            "      const layouted = await elk.layout(elkGraph);\n"
            "      const elkPos = new Map();\n"
            "      const offsets = new Map([['root', { x: 0, y: 0 }]]);\n"
            "      collectAbsolutePositions(layouted, 0, 0, elkPos, offsets);\n"
            "      let staggerMeta = null;\n"
            "      if (mode === 'creation') {\n"
            "        const dataById = new Map(visibleNodes.map((n) => [n.data.id, n.data]));\n"
            "        const shifted = applyCreationRowStagger(layouted, elkPos, new Set(), dataById, CREATION_ROW_STAGGER_PX);\n"
            "        staggerMeta = shifted.staggerMeta || null;\n"
            "      }\n"
            "\n"
            "      const cy = cytoscape({\n"
            "        headless: true,\n"
            "        styleEnabled: true,\n"
            "        layout: { name: 'preset' },\n"
            "        style: buildStylesheet(),\n"
            "        elements: [...visibleNodes, ...visibleEdges],\n"
            "      });\n"
            "      cy.batch(() => {\n"
            "        cy.nodes().forEach((n) => {\n"
            "          if (!n.isParent()) {\n"
            "            const p = elkPos.get(n.id());\n"
            "            if (p) n.position(p);\n"
            "          }\n"
            "        });\n"
            "      });\n"
            "      cy.batch(() => {\n"
            "        applyElkEdgeRoutes(cy, layouted, elkPos, offsets, new Set(), 'downward', staggerMeta, creationMeta);\n"
            "      });\n"
            "\n"
            "      // 1. Verificar alineación exacta entre tamaño ELK y tamaño exterior Cytoscape en nodos flow hoja.\n"
            "      const sizeDrifts = [];\n"
            "      cy.nodes('[type = \"flow\"]').forEach((n) => {\n"
            "        if (n.isParent() || n.data('flowContainer') === 'true') return;\n"
            "        const expectedW = n.data('elkWidth');\n"
            "        const expectedH = n.data('elkHeight');\n"
            "        if (Math.abs(n.outerWidth() - expectedW) > 1.0 || Math.abs(n.outerHeight() - expectedH) > 1.0) {\n"
            "          sizeDrifts.push({ id: n.id(), role: n.data('role'), kind: n.data('flowKind'), elk: [expectedW, expectedH], cy: [n.outerWidth(), n.outerHeight()] });\n"
            "        }\n"
            "      });\n"
            "\n"
            "      // 2. Verificar 0 badLine, contraste y z-compound-depth en todas las aristas de flujo y compound-incident.\n"
            "      let totalFlowEdges = 0;\n"
            "      let routedFlowEdges = 0;\n"
            "      let compoundFlowEdges = 0;\n"
            "      let compoundFlowRouted = 0;\n"
            "      const invalidEdges = [];\n"
            "      const styleErrors = [];\n"
            "      cy.edges().forEach((e) => {\n"
            "        const isFlow = e.data('kind') === 'flow';\n"
            "        const src = e.source(), tgt = e.target();\n"
            "        const isLoop = e.isLoop();\n"
            "        const isContainment = src.ancestors().anySame(tgt) || tgt.ancestors().anySame(src);\n"
            "        const touchesParent = src.isParent() || tgt.isParent();\n"
            "        if (isFlow && !isLoop && !isContainment) {\n"
            "          totalFlowEdges++;\n"
            "          if (e.hasClass('elk-routed')) routedFlowEdges++;\n"
            "          if (touchesParent) {\n"
            "            compoundFlowEdges++;\n"
            "            if (e.hasClass('elk-routed')) compoundFlowRouted++;\n"
            "          }\n"
            "          if (e.style('z-compound-depth') !== 'top') {\n"
            "            styleErrors.push({ id: e.id(), reason: 'flow_z_depth_' + e.style('z-compound-depth') });\n"
            "          }\n"
            "          if (e.data('flowEdgeKind') === 'flow' && e.style('line-color') !== 'rgb(148,163,184)') {\n"
            "            styleErrors.push({ id: e.id(), reason: 'flow_color_' + e.style('line-color') });\n"
            "          }\n"
            "        }\n"
            "        if (touchesParent && !e.hasClass('compound-incident')) {\n"
            "          styleErrors.push({ id: e.id(), reason: 'missing_compound_incident_class' });\n"
            "        }\n"
            "        if (e.hasClass('elk-routed')) {\n"
            "          const chk = verifyCytoscapeRoutedEdge(e);\n"
            "          if (!chk.ok) invalidEdges.push({ id: e.id(), kind: e.data('kind'), reason: chk.reason });\n"
            "        }\n"
            "      });\n"
            "\n"
            "      // 3. Verificar ortogonalidad de las secciones ELK post-stagger de todas las aristas de flujo.\n"
            "      const allElkEdges = [];\n"
            "      collectAllLayoutedEdges(layouted, allElkEdges);\n"
            "      const flowIds = new Set(visibleEdges.filter((e) => e.data.kind === 'flow').map((e) => e.data.id));\n"
            "      const nonOrthoFlow = [];\n"
            "      for (const e of allElkEdges) {\n"
            "        if (!flowIds.has(e.id)) continue;\n"
            "        const sec = e.sections && e.sections[0];\n"
            "        if (!sec) continue;\n"
            "        const off = offsets.get(e.container || 'root') || { x: 0, y: 0 };\n"
            "        const pts = adjustElkSectionPoints(sec, e.container || 'root', off, e.sources[0], e.targets[0], staggerMeta);\n"
            "        for (let i = 0; i < pts.length - 1; i++) {\n"
            "          if (Math.abs(pts[i + 1].x - pts[i].x) > 0.05 && Math.abs(pts[i + 1].y - pts[i].y) > 0.05) {\n"
            "            nonOrthoFlow.push({ id: e.id, p1: pts[i], p2: pts[i + 1] });\n"
            "          }\n"
            "        }\n"
            "      }\n"
            "\n"
            "      report[gName][mode] = {\n"
            "        totalFlowEdges,\n"
            "        routedFlowEdges,\n"
            "        compoundFlowEdges,\n"
            "        compoundFlowRouted,\n"
            "        lcaMismatches,\n"
            "        sizeDrifts,\n"
            "        invalidEdges,\n"
            "        styleErrors,\n"
            "        nonOrthoFlow,\n"
            "      };\n"
            "      cy.destroy();\n"
            "    }\n"
            "  }\n"
            "  console.log(JSON.stringify(report));\n"
            "})();\n"
        )

        proc = subprocess.run(
            ["node", "-e", script],
            input=json.dumps(graphs),
            capture_output=True,
            text=True,
            check=True,
        )
        report = json.loads(proc.stdout)

        for g_name in ("examples_multi", "python_parser"):
            for mode in ("execution", "creation"):
                entry = report[g_name][mode]
                self.assertGreater(entry["totalFlowEdges"], 0, f"{g_name}/{mode} debe tener aristas de flujo")
                self.assertEqual(
                    entry["routedFlowEdges"],
                    entry["totalFlowEdges"],
                    f"{g_name}/{mode}: faltaron aristas de flujo enrutadas: {entry}",
                )
                self.assertEqual(
                    entry["compoundFlowRouted"],
                    entry["compoundFlowEdges"],
                    f"{g_name}/{mode}: aristas con flowContainer perdieron elk-routed: {entry}",
                )
                self.assertEqual(entry["lcaMismatches"], [], f"{g_name}/{mode} LCA mismatches: {entry['lcaMismatches']}")
                self.assertEqual(entry["sizeDrifts"], [], f"{g_name}/{mode} size drifts: {entry['sizeDrifts']}")
                self.assertEqual(entry["invalidEdges"], [], f"{g_name}/{mode} badLine risks: {entry['invalidEdges']}")
                self.assertEqual(entry["styleErrors"], [], f"{g_name}/{mode} style errors: {entry['styleErrors']}")
                self.assertEqual(entry["nonOrthoFlow"], [], f"{g_name}/{mode} non-ortho flow: {entry['nonOrthoFlow']}")

        # python_parser tiene bucles for (flowContainer): confirmar que realmente ejercitamos compoundFlowEdges > 0.
        self.assertGreater(report["python_parser"]["execution"]["compoundFlowEdges"], 0)
        self.assertGreater(report["python_parser"]["creation"]["compoundFlowEdges"], 0)

    def test_floating_function_flow_windows_preserve_all_routes_without_badline(self) -> None:
        """Verifica ventanas flotantes de flujo de función (Solo flujo / Flujo y código) con if, merge y bucles."""
        graph = _build_graph_for(REPO_ROOT / "codemap" / "parsers" / "python_parser.py", True)
        rich_fns = [
            n
            for n in graph["nodes"]
            if n.get("type") == "function"
            and len(n.get("internal_flow") or []) >= 6
            and any(s.get("is_container") for s in n.get("internal_flow") or [])
        ]
        self.assertGreater(len(rich_fns), 0, "Debe haber funciones con flujo complejo y flowContainer en python_parser.py")

        script = HARNESS_PREAMBLE + (
            "const fns = JSON.parse(fs.readFileSync(0, 'utf8'));\n"
            "(async () => {\n"
            "  const elk = new ELK();\n"
            "  const results = [];\n"
            "  for (const fnNode of fns) {\n"
            "    const nodes = [];\n"
            "    const edges = [];\n"
            "    const visibleIds = new Set();\n"
            "    appendInternalFlowElements(fnNode, nodes, visibleIds);\n"
            "    for (const item of nodes) {\n"
            "      if (item.data.parent === fnNode.id) item.data.parent = undefined;\n"
            "    }\n"
            "    appendInternalFlowEdges(nodes, edges, visibleIds);\n"
            "    const elkGraph = buildElkInput(nodes, edges, { forceExecution: true });\n"
            "    elkGraph.layoutOptions = {\n"
            "      'elk.algorithm': 'layered',\n"
            "      'elk.direction': 'DOWN',\n"
            "      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',\n"
            "      'elk.edgeRouting': 'ORTHOGONAL',\n"
            "      'elk.layered.spacing.nodeNodeBetweenLayers': '44',\n"
            "      'elk.spacing.nodeNode': '28',\n"
            "      'elk.spacing.edgeNode': '18',\n"
            "      'elk.spacing.edgeEdge': '14',\n"
            "      'elk.padding': '[top=22,left=22,bottom=22,right=22]',\n"
            "    };\n"
            "    const layouted = await elk.layout(elkGraph);\n"
            "    const elkPos = new Map();\n"
            "    const offsets = new Map([['root', { x: 0, y: 0 }]]);\n"
            "    collectAbsolutePositions(layouted, 0, 0, elkPos, offsets);\n"
            "    const cy = cytoscape({\n"
            "      headless: true,\n"
            "      styleEnabled: true,\n"
            "      layout: { name: 'preset' },\n"
            "      style: buildStylesheet(),\n"
            "      elements: [...nodes, ...edges],\n"
            "    });\n"
            "    cy.batch(() => {\n"
            "      cy.nodes().forEach((n) => {\n"
            "        if (!n.isParent()) { const p = elkPos.get(n.id()); if (p) n.position(p); }\n"
            "      });\n"
            "    });\n"
            "    cy.batch(() => {\n"
            "      applyElkEdgeRoutes(cy, layouted, elkPos, offsets, null, 'downward', null, null);\n"
            "    });\n"
            "    let total = 0, routed = 0, invalid = [];\n"
            "    cy.edges().forEach((e) => {\n"
            "      const src = e.source(), tgt = e.target();\n"
            "      if (e.isLoop() || src.ancestors().anySame(tgt) || tgt.ancestors().anySame(src)) return;\n"
            "      total++;\n"
            "      if (e.hasClass('elk-routed')) {\n"
            "        routed++;\n"
            "        const chk = verifyCytoscapeRoutedEdge(e);\n"
            "        if (!chk.ok) invalid.push({ id: e.id(), reason: chk.reason });\n"
            "      }\n"
            "    });\n"
            "    results.push({ fnId: fnNode.id, total, routed, invalid });\n"
            "    cy.destroy();\n"
            "  }\n"
            "  console.log(JSON.stringify(results));\n"
            "})();\n"
        )

        proc = subprocess.run(
            ["node", "-e", script],
            input=json.dumps(rich_fns[:5]),
            capture_output=True,
            text=True,
            check=True,
        )
        results = json.loads(proc.stdout)
        for item in results:
            self.assertGreater(item["total"], 0)
            self.assertEqual(item["routed"], item["total"], f"Ventana flotante {item['fnId']}: {item}")
            self.assertEqual(item["invalid"], [], f"Ventana flotante {item['fnId']} badLine: {item}")


if __name__ == "__main__":
    unittest.main()
