"""Pruebas del Ciclo 10: Fixes críticos de Nivel 3/2/1, APIs externas, Inspector, HUD y Recorrido en ventana flotante."""

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
VENDOR_DIR = VIEWER_DIR / "vendor"
APP_JS = VIEWER_DIR / "app.js"
WALKTHROUGH_JS = VIEWER_DIR / "walkthrough.js"
VOCAB_JS = VIEWER_DIR / "vocab.js"
INDEX_HTML = VIEWER_DIR / "index.html"
STYLES_CSS = VIEWER_DIR / "styles.css"
README_MD = REPO_ROOT / "README.md"
VOCAB_DICT_JSON = REPO_ROOT / "codemap" / "vocab_dictionary.json"


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


def _node_by_id(graph: dict, node_id: str) -> dict:
    return next(n for n in graph["nodes"] if n["id"] == node_id)


class TestCycle10ExternalCallsAndStdlib(unittest.TestCase):
    def test_js_ts_node_builtins_require_variants_constructors_and_multiline_vocab(self) -> None:
        files = {
            "other.ts": '''
                export class CustomResolver {
                  resolve(x: string) {
                    return x;
                  }
                }
            ''',
            "loader.ts": '''
                import path from "node:path";
                import fs from "fs";
                const { join, resolve: resPath } = require("path");
                const fsp = require("fs").promises;
                const { readFile: readAsync } = require("fs").promises;

                export async function loadConfig(validatedPath: string, rawObj: any) {
                  const resolvedPath = path.resolve(validatedPath);
                  const nested = join(path.dirname(resolvedPath), "cfg.json");
                  const aliasResolved = resPath(nested);
                  const url = new URL("https://example.com");
                  const err = new TypeError("invalid");
                  const cwd = process.cwd();
                  const text1 = await fsp.readFile(aliasResolved, "utf8");
                  const text2 = await readAsync(aliasResolved, "utf8");
                  const parts = rawObj?.trim().split(",");
                  const secondResolve = path.resolve(parts[0]);
                  const ok = fs.existsSync(secondResolve) ? JSON.parse(text1) : text2;
                  return [ok, url, err, cwd];
                }
            ''',
        }
        graph = _build_temp_graph(files)
        fn = _node_by_id(graph, "loader.ts::loadConfig")
        ext_by_id = {e["api_id"]: e for e in fn["external_calls"]}

        for expected_id in (
            "node:path.resolve",
            "node:path.join",
            "node:path.dirname",
            "node:fs.existsSync",
            "node:fs.promises.readFile",
            "js:URL",
            "js:TypeError",
            "js:process.cwd",
            "js:String.prototype.trim",
            "js:String.prototype.split",
            "js:JSON.parse",
        ):
            self.assertIn(
                expected_id,
                ext_by_id,
                f"Faltó detectar {expected_id} en external_calls; detectados={sorted(ext_by_id)}",
            )

        # Clasificación Node stdlib con URL oficial de nodejs.org y tracking multi-línea.
        resolve_entry = ext_by_id["node:path.resolve"]
        self.assertEqual(resolve_entry["kind"], "stdlib")
        self.assertIn("nodejs.org/api/path.html", resolve_entry["docs_url"])
        self.assertGreaterEqual(len(resolve_entry["lines"]), 3)  # líneas 8, 10 y 17

        # El exportador IA compacto no incluye la lista `lines`.
        ai_graph = build_ai_graph(graph)
        ai_fn = _node_by_id(ai_graph, "loader.ts::loadConfig")
        for ext in ai_fn.get("external_calls", []):
            self.assertNotIn("lines", ext)

        # vocab.js debe mostrar Ficha Viva para `node:path.resolve` en CUALQUIERA de sus líneas (p.ej. la 17).
        last_line = resolve_entry["lines"][-1]
        node_script = (
            f"const vocab = require({json.dumps(str(VOCAB_JS))});\n"
            f"const dict = require({json.dumps(str(VOCAB_DICT_JSON))});\n"
            f"const fnNode = {json.dumps(fn)};\n"
            f"const items = vocab.collectLineVocabItems(fnNode, {last_line}, {last_line}, dict, {{ known: {{}} }});\n"
            "const hit = items.find((i) => i.id === 'node:path.resolve');\n"
            "if (!hit) throw new Error('No apareció node:path.resolve en la línea repetida');\n"
            "if (!hit.input || !hit.output) throw new Error('Falta contrato Entrada/Salida en node:path.resolve');\n"
            "console.log('MULTILINE_VOCAB_OK');\n"
        )
        proc = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("MULTILINE_VOCAB_OK", proc.stdout)

    def test_python_dotted_import_and_multiline_external_calls(self) -> None:
        files = {
            "worker.py": '''
                import os.path
                import json

                def build_paths(a, b):
                    p1 = os.path.join(a, b)
                    cwd = os.getcwd()
                    raw = json.dumps({"p": p1, "cwd": cwd})
                    p2 = os.path.join(cwd, "out.json")
                    return raw, p2
            ''',
        }
        graph = _build_temp_graph(files)
        fn = _node_by_id(graph, "worker.py::build_paths")
        ext_by_id = {e["api_id"]: e for e in fn["external_calls"]}

        self.assertIn("py:os.path.join", ext_by_id)
        self.assertIn("py:os.getcwd", ext_by_id)
        self.assertIn("py:json.dumps", ext_by_id)
        self.assertEqual(len(ext_by_id["py:os.path.join"]["lines"]), 2)


class TestCycle10DragAndLocalRouting(unittest.TestCase):
    def test_zero_px_click_preserves_elk_routes_and_local_reroute_clean_across_levels_1_2_3(self) -> None:
        files = {
            "mod_a/entry.py": '''
                from mod_b.service import process_data, format_data
                from mod_c.store import save_data

                def start(raw):
                    d = process_data(raw)
                    f = format_data(d)
                    return save_data(f)
            ''',
            "mod_b/service.py": '''
                from mod_c.store import load_defaults

                def process_data(raw):
                    cfg = load_defaults()
                    return raw + cfg

                def format_data(val):
                    return str(val)
            ''',
            "mod_c/store.py": '''
                def load_defaults():
                    return "ok"

                def save_data(payload):
                    return len(payload)
            ''',
        }
        graph = _build_temp_graph(files)
        node_script = (
            "const fs = require('fs');\n"
            f"const cytoscape = require({json.dumps(str(VENDOR_DIR / 'cytoscape.min.js'))});\n"
            f"const ELK = require({json.dumps(str(VENDOR_DIR / 'elk.bundled.js'))});\n"
            f"const appSrc = fs.readFileSync({json.dumps(str(APP_JS))}, 'utf8');\n"
            """
function extractFn(name) {
  const re = new RegExp(`(?:async\\\\s+)?function\\\\s+${name}\\\\s*\\\\(`);
  const m = re.exec(appSrc);
  if (!m) throw new Error('No se encontró ' + name);
  let i = appSrc.indexOf('{', m.index);
  let depth = 0;
  for (; i < appSrc.length; i += 1) {
    if (appSrc[i] === '{') depth += 1;
    else if (appSrc[i] === '}') {
      depth -= 1;
      if (depth === 0) return appSrc.slice(m.index, i + 1);
    }
  }
  throw new Error('Llaves desbalanceadas en ' + name);
}
const matchConst = (name) => {
  const m = new RegExp(`const\\\\s+${name}\\\\s*=\\\\s*[\\\\s\\\\S]*?;`).exec(appSrc);
  if (!m) throw new Error('No se encontró const ' + name);
  return m[0].replace(/^const /, 'var ');
};
var _activeDragState = null;
var _pendingDragFreeNodes = new Map();
var _dragFreeFlushScheduled = false;
var postedCount = 0;
global.fetch = async (_url, opts) => {
  postedCount += 1;
  const body = JSON.parse(opts.body);
  for (const [k, v] of Object.entries(body.nodes || {})) state.notes.nodes[k] = v;
  return { ok: true, json: async () => state.notes };
};
const state = {
  rawGraph: null,
  activeLevel: 3,
  expandedFunctions: new Set(),
  collapsedContainers: new Set(),
  groupingMode: 'folders',
  layoutOrderMode: 'execution',
  hideUtilities: false,
  showVariables: false,
  utilityNodeIds: new Set(),
  isolateActiveContext: false,
  activeFlowId: null,
  traceMode: false,
  isolatedFileId: null,
  nhops: { active: false, anchorIds: [], forwardDepth: 1, backwardDepth: 1 },
  notes: { nodes: {}, orphans: [], line_notes: {} },
  nodesById: new Map(),
  childrenByParent: new Map(),
  floatingWindows: new Map(),
  selectedNodeId: null,
  cy: null,
};
function getActiveFlowStepMaps() { return { flow: null, nodeOrder: new Map(), edgeOrder: new Map() }; }
function updatePinButton() {}
function updateReleasePinnedButton() {}
function countDescendantFunctions() { return 0; }
function countHiddenUtilityCallees() { return 0; }
function computeSubgraphFilter() { return null; }
eval([
  matchConst('ELK_LAYOUT_OPTIONS'),
  matchConst('CREATION_FILE_ELK_OPTIONS'),
  matchConst('CREATION_CONTAINER_ELK_OPTIONS'),
  matchConst('CREATION_ROW_STAGGER_PX'),
  matchConst('CREATION_MACRO_EDGE_PREFIX'),
  matchConst('LEGACY_PIN_FALLBACK_KEY'),
  matchConst('DRAG_MOVE_THRESHOLD_PX'),
  extractFn('getCurrentLayoutContextKey'),
  extractFn('getPinnedPositionForContext'),
  extractFn('isPinnedInCurrentContext'),
  extractFn('getNoteEntry'),
  extractFn('buildDisplayLabel'),
  extractFn('buildStylesheet'),
  extractFn('estimateWrappedTextMetrics'),
  extractFn('estimateFlowStepSize'),
  extractFn('appendInternalFlowElements'),
  extractFn('appendInternalFlowEdges'),
  extractFn('estimateNodeSize'),
  extractFn('estimateCompoundHeaderWidth'),
  extractFn('computeElkSubtreeWidth'),
  extractFn('assignCreationBands'),
  extractFn('computeCreationPartition'),
  extractFn('computeIntraTierFoundationDepths'),
  extractFn('buildCreationElkInput'),
  extractFn('buildPostStaggerBoxes'),
  extractFn('stitchCrossFileEdgeOntoMacroCorridor'),
  extractFn('buildElkInput'),
  extractFn('collectAbsolutePositions'),
  extractFn('collectAllLayoutedEdges'),
  extractFn('shiftElkSubtreeY'),
  extractFn('applyCreationRowStagger'),
  extractFn('computeStaggeredChannelShiftY'),
  extractFn('adjustElkSectionPoints'),
  extractFn('convertElkPointsToCytoscapeSegments'),
  extractFn('applyElkEdgeRoutes'),
  extractFn('filterOutermostDraggedNodes'),
  extractFn('collectScopeAndExternalEdges'),
  extractFn('computeDynamicTaxiDirection'),
  extractFn('captureDragStartPositions'),
  extractFn('computeMaxDragDisplacement'),
  extractFn('handleNodeGrab'),
  extractFn('handleNodeDrag'),
  extractFn('handleNodeFree'),
  extractFn('rerouteExternalEdgesLocally'),
  extractFn('applyScopedPinsToLayout'),
  extractFn('refreshCyNodeMetadata'),
  extractFn('handleNodeDragFreeBatch'),
].join('\\n'));

function reconstructPolyline(cyEdge) {
  const parsePx = (s, pos) => {
    const p = String(s || '').trim().split(/\\s+/);
    if (p.length !== 2) return null;
    return { x: pos.x + parseFloat(p[0]), y: pos.y + parseFloat(p[1]) };
  };
  const sEnd = parsePx(cyEdge.data('srcEndpoint'), cyEdge.source().position());
  const tEnd = parsePx(cyEdge.data('tgtEndpoint'), cyEdge.target().position());
  if (!sEnd || !tEnd) return null;
  const dx = tEnd.x - sEnd.x, dy = tEnd.y - sEnd.y, len = Math.hypot(dx, dy);
  if (len < 2) return null;
  const ws = cyEdge.data('segWeights') || [], ds = cyEdge.data('segDistances') || [];
  if (!ws.length || ws.length !== ds.length) return null;
  const nx = -dy / len, ny = dx / len;
  const pts = [sEnd];
  for (let i = 0; i < ws.length; i += 1) {
    pts.push({ x: sEnd.x + ws[i] * dx + ds[i] * nx, y: sEnd.y + ws[i] * dy + ds[i] * ny });
  }
  pts.push(tEnd);
  return pts;
}

function assertOrthogonal(pts, label) {
  if (!pts || pts.length < 2) throw new Error('Polilínea inválida en ' + label);
  for (let i = 0; i < pts.length - 1; i += 1) {
    const dx = Math.abs(pts[i + 1].x - pts[i].x);
    const dy = Math.abs(pts[i + 1].y - pts[i].y);
    if (dx > 1.5 && dy > 1.5) {
      throw new Error(`Segmento diagonal (${dx.toFixed(1)}, ${dy.toFixed(1)}) en ${label}`);
    }
  }
}

const graph = JSON.parse(fs.readFileSync(0, 'utf8'));
(async () => {
  const elk = new ELK();
  state.rawGraph = graph;
  state.nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

  // 1. Nivel 3: comprobar que un clic de 0 px (grab -> free) y micro-temblor de 1 px NO degradan `.elk-routed` ni fijan.
  const nodesL3 = graph.nodes.map((n) => ({
    data: {
      id: n.id,
      parent: n.parent || undefined,
      label: n.label,
      type: n.type,
      role: n.role || n.type,
      line: n.line || 0,
    },
  }));
  const edgesL3 = graph.edges.map((e) => ({
    data: { id: e.id, source: e.source, target: e.target, kind: 'call', confidence: e.confidence, edgeType: e.edge_type },
  }));

  const cy = cytoscape({ headless: true, style: buildStylesheet(), elements: [...nodesL3, ...edgesL3] });
  state.cy = cy;
  const elkIn = buildElkInput(nodesL3, edgesL3);
  const layouted = await elk.layout(elkIn);
  const elkPos = new Map();
  const cOff = new Map([['root', { x: 0, y: 0 }]]);
  collectAbsolutePositions(layouted, 0, 0, elkPos, cOff);
  cy.nodes().forEach((n) => { if (!n.isParent() && elkPos.has(n.id())) n.position(elkPos.get(n.id())); });
  applyElkEdgeRoutes(cy, layouted, elkPos, cOff, null, 'downward', null, null);

  const startFn = cy.getElementById('mod_a/entry.py::start');
  const beforeRoutes = new Map();
  startFn.connectedEdges().forEach((e) => {
    if (!e.hasClass('elk-routed')) throw new Error('Arista inicial sin .elk-routed: ' + e.id());
    beforeRoutes.set(e.id(), {
      srcEndpoint: e.data('srcEndpoint'),
      tgtEndpoint: e.data('tgtEndpoint'),
      segWeights: JSON.stringify(e.data('segWeights')),
      segDistances: JSON.stringify(e.data('segDistances')),
    });
  });

  // Clic 0 px: grab -> free (sin drag)
  handleNodeGrab(startFn);
  handleNodeFree(startFn);
  await Promise.resolve();
  startFn.connectedEdges().forEach((e) => {
    const prev = beforeRoutes.get(e.id());
    if (!e.hasClass('elk-routed')) throw new Error('Clic 0px perdió .elk-routed en ' + e.id());
    if (e.data('srcEndpoint') !== prev.srcEndpoint || JSON.stringify(e.data('segWeights')) !== prev.segWeights) {
      throw new Error('Clic 0px alteró ruta en ' + e.id());
    }
  });
  if (postedCount !== 0) throw new Error('Clic 0px no debe guardar pin');

  // Micro-temblor de 1.2 px: grab -> drag -> dragfree
  const origPos = { ...startFn.position() };
  handleNodeGrab(startFn);
  startFn.position({ x: origPos.x + 1.2, y: origPos.y + 0.5 });
  handleNodeDrag();
  await handleNodeDragFreeBatch([startFn]);
  startFn.connectedEdges().forEach((e) => {
    if (!e.hasClass('elk-routed')) throw new Error('Micro-temblor perdió .elk-routed en ' + e.id());
  });
  if (postedCount !== 0) throw new Error('Micro-temblor no debe fijar el nodo');
  if (Math.hypot(startFn.position().x - origPos.x, startFn.position().y - origPos.y) > 0.1) {
    throw new Error('Micro-temblor no restauró posición exacta');
  }

  // 2. Arrastre real en Nivel 3 (> umbral): debe re-enrutar ortogonalmente y distribuir puertos en fan-out.
  handleNodeGrab(startFn);
  startFn.position({ x: origPos.x + 180, y: origPos.y + 40 });
  handleNodeDrag();
  await handleNodeDragFreeBatch([startFn]);
  if (postedCount !== 1) throw new Error('Arrastre real debió fijar nodo');
  const outEdges = startFn.outgoers('edge');
  const srcEndpoints = new Set();
  outEdges.forEach((e) => {
    if (!e.hasClass('elk-routed')) throw new Error('Arista saliente sin .elk-routed tras mover: ' + e.id());
    assertOrthogonal(reconstructPolyline(e), 'L3:' + e.id());
    srcEndpoints.add(e.data('srcEndpoint'));
  });
  if (outEdges.length >= 2 && srcEndpoints.size < 2) {
    throw new Error('Puertos de salida no distribuidos en fan-out: ' + JSON.stringify([...srcEndpoints]));
  }

  // 3. Nivel 2 (Archivos colapsados) y Nivel 1 (Módulos colapsados): rerouteExternalEdgesLocally ortogonal.
  for (const lvl of [2, 1]) {
    const cyLvl = cytoscape({
      headless: true,
      layout: { name: 'preset' },
      style: buildStylesheet(),
      elements: [
        { data: { id: 'A', label: 'A', type: lvl === 2 ? 'file' : 'module', collapsed: 'true' }, position: { x: 100, y: 100 } },
        { data: { id: 'B', label: 'B', type: lvl === 2 ? 'file' : 'module', collapsed: 'true' }, position: { x: 100, y: 260 } },
        { data: { id: 'C', label: 'C', type: lvl === 2 ? 'file' : 'module', collapsed: 'true' }, position: { x: 100, y: 420 } },
        { data: { id: 'e1', source: 'A', target: 'C', kind: 'call' } },
        { data: { id: 'e2', source: 'A', target: 'B', kind: 'call' } },
        { data: { id: 'e3', source: 'B', target: 'C', kind: 'call' } },
      ],
    });
    const routed = rerouteExternalEdgesLocally(cyLvl, cyLvl.edges());
    if (routed !== 3) throw new Error(`Nivel ${lvl}: esperadas 3 aristas enrutadas, obtenidas ${routed}`);
    cyLvl.edges().forEach((e) => {
      if (!e.hasClass('elk-routed')) throw new Error(`Nivel ${lvl}: arista sin .elk-routed: ${e.id()}`);
      assertOrthogonal(reconstructPolyline(e), `L${lvl}:${e.id()}`);
    });
    // Verificar que A->C rodea a B (no atraviesa el centro de B en x=100, y=260).
    const polyAC = reconstructPolyline(cyLvl.getElementById('e1'));
    const bNode = cyLvl.getElementById('B');
    const bPos = bNode.position();
    const bHw = bNode.outerWidth() / 2 - 4;
    const bHh = bNode.outerHeight() / 2 - 4;
    for (let i = 0; i < polyAC.length - 1; i += 1) {
      const p1 = polyAC[i], p2 = polyAC[i + 1];
      if (Math.abs(p1.x - p2.x) <= 1.5) {
        const x = p1.x, top = Math.min(p1.y, p2.y), bot = Math.max(p1.y, p2.y);
        if (x > bPos.x - bHw && x < bPos.x + bHw && bot > bPos.y - bHh && top < bPos.y + bHh) {
          throw new Error(`Nivel ${lvl}: arista A->C atravesó la caja hermana B`);
        }
      }
    }
    cyLvl.destroy();
  }

  // 4. Confirmar que buildStylesheet() NO tiene overrides de curve-style en :selected ni clases de resaltado.
  const sheet = buildStylesheet();
  for (const rule of sheet) {
    if (/:selected|edge-reveal|flow-active-edge|flow-focus-active|flow-bg-muted/.test(rule.selector)) {
      if (rule.style && ('curve-style' in rule.style || 'taxi-direction' in rule.style)) {
        throw new Error('Regla prohibida sobrescribe curve-style/taxi-direction: ' + rule.selector);
      }
    }
  }

  cy.destroy();
  console.log('CYCLE10_DRAG_ROUTING_OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
"""
        )
        proc = subprocess.run(
            ["node", "-e", node_script],
            input=json.dumps(graph),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, f"Falló prueba headless:\nSTDOUT:{proc.stdout}\nSTDERR:{proc.stderr}")
        self.assertIn("CYCLE10_DRAG_ROUTING_OK", proc.stdout)


class TestCycle10WalkthroughUxAndAudit(unittest.TestCase):
    def test_zero_chispa_references_and_hud_inspector_contracts(self) -> None:
        for path in (README_MD, INDEX_HTML, APP_JS, WALKTHROUGH_JS, VOCAB_JS, STYLES_CSS):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("chispa", text.lower(), f"Aún existe 'chispa' en {path.name}")

        html = INDEX_HTML.read_text(encoding="utf-8")
        css = STYLES_CSS.read_text(encoding="utf-8")
        app_src = APP_JS.read_text(encoding="utf-8")

        self.assertIn('id="details-panel-resizer"', html)
        self.assertIn('id="btn-wt-wrap-code"', html)
        self.assertIn('id="wt-scope-pill"', html)
        self.assertIn("flex-wrap: nowrap;", css)
        self.assertIn(".wt-code-preview-box.wrap-enabled .wt-code-text", css)
        self.assertIn("overflow-wrap: anywhere;", css)
        self.assertIn(".details-panel-resizer", css)
        self.assertIn("fw-walkthrough-btn", app_src)
        self.assertIn('"elk.spacing.edgeEdge": "22"', app_src)
        self.assertIn('"elk.layered.spacing.edgeEdgeBetweenLayers": "22"', app_src)

    def test_isolated_floating_window_walkthrough_does_not_mutate_main_canvas_and_stops_on_close(self) -> None:
        files = {
            "calc.py": '''
                def helper(v):
                    return v + 1

                def pipeline(x):
                    if x > 0:
                        y = helper(x)
                        return y
                    return 0
            ''',
        }
        graph = _build_temp_graph(files)
        node_script = (
            f"const wt = require({json.dumps(str(WALKTHROUGH_JS))});\n"
            f"const graph = {json.dumps(graph)};\n"
            """
// Mock mínimo de DOM/window para probar controlador en ámbito `window`.
const domEls = new Map();
const makeEl = (id) => ({
  id,
  className: '',
  textContent: '',
  title: '',
  value: '1',
  dataset: {},
  style: {},
  childElementCount: 0,
  classList: {
    _set: new Set(),
    add(...xs) { xs.forEach((x) => this._set.add(x)); },
    remove(...xs) { xs.forEach((x) => this._set.delete(x)); },
    toggle(x, force) {
      const on = force === undefined ? !this._set.has(x) : Boolean(force);
      if (on) this._set.add(x); else this._set.delete(x);
    },
    contains(x) { return this._set.has(x); },
  },
  setAttribute() {},
  appendChild() {},
  replaceChildren() {},
  addEventListener() {},
  getContext() { return { save(){}, restore(){}, setTransform(){}, clearRect(){} }; },
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300 }; },
  clientWidth: 400,
  clientHeight: 300,
});
global.document = {
  getElementById: (id) => {
    if (!domEls.has(id)) domEls.set(id, makeEl(id));
    return domEls.get(id);
  },
  createElement: (tag) => makeEl(tag),
  createDocumentFragment: () => ({ appendChild() {} }),
};
global.window = {
  devicePixelRatio: 1,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  setTimeout,
  clearTimeout,
};
global.fetch = async () => ({ ok: false });

let prepareCalledWith = null;
const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
const fakeWin = { id: 'fw-1', targetId: 'calc.py::pipeline', destroyed: false, viewMode: 'flow', cy: null, cyContainer: makeEl('fw-cy') };

const ctrl = wt.createController({
  getCy: () => null,
  getRawGraph: () => graph,
  getNodesById: () => nodesById,
  getActiveFlowId: () => null,
  getFloatingWindows: () => [fakeWin],
  getFloatingWindowById: (id) => (id === 'fw-1' ? fakeWin : null),
  prepareCanvasForTrace: async (_trace, opts) => {
    prepareCalledWith = opts;
  },
});

(async () => {
  const ok = await ctrl.start({
    scope: 'window',
    windowId: 'fw-1',
    rootId: 'calc.py::pipeline',
    granularity: 'step',
    stepInto: false,
  });
  if (!ok) throw new Error('start(scope=window) devolvió false');
  if (!prepareCalledWith || prepareCalledWith.scope !== 'window' || prepareCalledWith.windowId !== 'fw-1') {
    throw new Error('prepareCanvasForTrace no recibió scope=window: ' + JSON.stringify(prepareCalledWith));
  }
  const st = ctrl.getState();
  if (st.scope !== 'window' || st.windowId !== 'fw-1' || st.granularity !== 'step' || st.stepInto !== false) {
    throw new Error('Estado de ventana incorrecto: ' + JSON.stringify(st));
  }
  const events = ctrl.getTrace().events;
  if (!events.length || events.some((ev) => ev.fn_id !== 'calc.py::pipeline')) {
    throw new Error('El recorrido aislado no debe entrar a otras funciones fuera de la ventana');
  }
  // Al cerrar la ventana flotante, el recorrido debe detenerse limpiamente.
  ctrl.onFloatingWindowClosed('fw-1');
  if (ctrl.isActive()) throw new Error('Walkthrough siguió activo tras cerrar la ventana flotante');
  console.log('ISOLATED_WINDOW_WT_OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
"""
        )
        proc = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, f"Falló prueba window walkthrough:\n{proc.stderr}")
        self.assertIn("ISOLATED_WINDOW_WT_OK", proc.stdout)


if __name__ == "__main__":
    unittest.main()
