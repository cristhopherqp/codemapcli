"""Pruebas del Ciclo 11: zoom mínimo ampliado/editable, cámara 🎥 Seguir y expansión selectiva +1."""

from __future__ import annotations

import json
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

from codemap.discovery import discover_files
from codemap.graph_builder import build_graph
from codemap.parsers import parse_file
from codemap.paths import normalize_path


REPO_ROOT = Path(__file__).resolve().parents[1]
VIEWER_DIR = REPO_ROOT / "codemap" / "viewer"
APP_JS = VIEWER_DIR / "app.js"
WALKTHROUGH_JS = VIEWER_DIR / "walkthrough.js"
INDEX_HTML = VIEWER_DIR / "index.html"
STYLES_CSS = VIEWER_DIR / "styles.css"


def _build_temp_graph(files: dict[str, str], *, include_private: bool = False) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for rel_path, content in files.items():
            full_path = root / rel_path
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text(textwrap.dedent(content).lstrip("\n"), encoding="utf-8")
        analyses = [a for p in discover_files(root) if (a := parse_file(p)) is not None]
        norm = normalize_path(root)
        return build_graph(
            analyses,
            target_path=norm,
            root_dir=norm,
            is_single_file=False,
            include_private=include_private,
        )


class TestCycle11NavigationAndWalkthrough(unittest.TestCase):
    """Verifica las 3 mejoras del Ciclo 11 en pruebas estáticas y headless Node.js."""

    def test_html_and_css_expose_editable_zoom_and_single_row_follow_button(self) -> None:
        html = INDEX_HTML.read_text(encoding="utf-8")
        css = STYLES_CSS.read_text(encoding="utf-8")

        self.assertIn('id="zoom-indicator"', html)
        self.assertIn('id="zoom-input"', html)
        self.assertIn('id="btn-wt-follow"', html)
        self.assertIn("🎥 Seguir", html)
        self.assertNotIn(">Pulso (N3)<", html)
        self.assertIn(">Pulso<", html)

        self.assertIn(".zoom-input", css)
        self.assertIn(".wt-follow-btn.active", css)
        self.assertIn("flex-wrap: nowrap;", css)
        self.assertIn("white-space: nowrap;", css)

    def test_expanded_zoom_dynamic_min_zoom_and_inline_percent_parser_headless(self) -> None:
        app_src = APP_JS.read_text(encoding="utf-8")
        self.assertIn("const MAIN_MIN_ZOOM = 0.02;", app_src)
        self.assertIn("const MAIN_MAX_ZOOM = 4;", app_src)
        self.assertIn("const FW_MAX_ZOOM = 4;", app_src)

        node_script = (
            f"const fs = require('fs');\n"
            f"const src = fs.readFileSync({json.dumps(str(APP_JS))}, 'utf8');\n"
            """
function extractFn(name) {
  const marker = 'function ' + name + '(';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('No se encontró ' + name);
  const sigEnd = src.indexOf(') {', start);
  if (sigEnd === -1) throw new Error('No se encontró cuerpo de ' + name);
  const bodyStart = sigEnd + 2;
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('Llaves desbalanceadas en ' + name);
}

const MAIN_MIN_ZOOM = 0.02;
const MAIN_MAX_ZOOM = 4;
const DYNAMIC_MIN_ZOOM_FLOOR = 0.005;

eval(extractFn('fitCyWithDynamicMinZoom'));
eval(extractFn('parseZoomPercentInput'));
eval(extractFn('formatZoomPercent'));

// 1. Grafo denso gigante (80000 x 60000 en viewport 1000 x 700 -> neededZoom ≈ 0.0103 < 0.02)
let currentMinZoom = 0.02;
let fittedPadding = null;
const giantCy = {
  container: () => ({ clientWidth: 1000, clientHeight: 700 }),
  elements: () => ({ length: 200, boundingBox: () => ({ w: 80000, h: 60000 }) }),
  minZoom: (v) => { if (v !== undefined) currentMinZoom = v; return currentMinZoom; },
  fit: (_eles, pad) => { fittedPadding = pad; },
};
fitCyWithDynamicMinZoom(giantCy, undefined, 40, MAIN_MIN_ZOOM);
if (!(currentMinZoom < 0.02 && currentMinZoom >= DYNAMIC_MIN_ZOOM_FLOOR)) {
  throw new Error('minZoom dinámico no bajó correctamente: ' + currentMinZoom);
}
if (fittedPadding !== 40) throw new Error('fit() no recibió padding 40');

// 2. Grafo pequeño normal: debe restaurar el piso base 0.02
const normalCy = {
  container: () => ({ clientWidth: 1000, clientHeight: 700 }),
  elements: () => ({ length: 5, boundingBox: () => ({ w: 600, h: 400 }) }),
  minZoom: (v) => { if (v !== undefined) currentMinZoom = v; return currentMinZoom; },
  fit: () => {},
};
fitCyWithDynamicMinZoom(normalCy, undefined, 40, MAIN_MIN_ZOOM);
if (Math.abs(currentMinZoom - 0.02) > 1e-9) {
  throw new Error('minZoom no restauró a 0.02: ' + currentMinZoom);
}

// 3. Parseo y acotado del input de porcentaje (2-400%)
const cases = [
  ['75', 75],
  [' 125% ', 125],
  ['2', 2],
  ['400%', 400],
  ['1', 2],
  ['999', 400],
  ['0', null],
  ['-15', null],
  ['abc', null],
  ['', null],
];
for (const [raw, expected] of cases) {
  const got = parseZoomPercentInput(raw, 2, 400);
  if (got !== expected) {
    throw new Error(`parseZoomPercentInput(${JSON.stringify(raw)}) = ${got}, esperado ${expected}`);
  }
}

if (formatZoomPercent(0.02) !== '2%') throw new Error('formatZoomPercent(0.02) falló');
if (formatZoomPercent(0.008) !== '0.8%') throw new Error('formatZoomPercent(0.008) falló');
if (formatZoomPercent(4) !== '400%') throw new Error('formatZoomPercent(4) falló');
console.log('ZOOM_HEADLESS_OK');
"""
        )
        proc = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, f"Falló prueba de zoom:\n{proc.stderr}")
        self.assertIn("ZOOM_HEADLESS_OK", proc.stdout)

    def test_follow_camera_lerp_preserves_zoom_and_yields_on_manual_pan_main_and_window(self) -> None:
        files = {
            "app.py": '''
                def leaf(v):
                    return v + 1

                def run(x):
                    if x > 0:
                        return leaf(x)
                    return 0
            ''',
        }
        graph = _build_temp_graph(files)

        node_script = (
            f"const wt = require({json.dumps(str(WALKTHROUGH_JS))});\n"
            f"const graph = {json.dumps(graph)};\n"
            """
// 1. Validar math pura de computeCameraFollowPanStep (converge al centro sin cambiar zoom)
const zoom = 1.37;
let pan = { x: 0, y: 0 };
const focus = { x: 400, y: 300 };
const vp = { width: 1000, height: 600 };
for (let i = 0; i < 60; i += 1) {
  const step = wt.computeCameraFollowPanStep(pan, focus, vp, zoom, 0.016, 10);
  pan = { x: step.x, y: step.y };
}
const expectedX = vp.width / 2 - focus.x * zoom;
const expectedY = vp.height / 2 - focus.y * zoom;
if (Math.hypot(pan.x - expectedX, pan.y - expectedY) > 1.0) {
  throw new Error(`Lerp no convergió: got (${pan.x}, ${pan.y}), expected (${expectedX}, ${expectedY})`);
}

// 2. Validar WalkthroughCanvasRenderer + Controller en lienzo principal y ventana flotante
const domEls = new Map();
const makeEl = (id) => ({
  id,
  className: '',
  textContent: '',
  title: '',
  value: '1',
  dataset: {},
  style: {},
  attrs: {},
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
  setAttribute(k, v) { this.attrs[k] = v; },
  appendChild() {},
  replaceChildren() {},
  addEventListener() {},
  getContext() {
    return {
      save(){}, restore(){}, setTransform(){}, clearRect(){}, beginPath(){},
      moveTo(){}, lineTo(){}, stroke(){}, arc(){}, fill(){}, strokeRect(){},
      createRadialGradient(){ return { addColorStop(){} }; },
    };
  },
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
  clientWidth: 800,
  clientHeight: 600,
});
global.document = {
  getElementById: (id) => {
    if (!domEls.has(id)) domEls.set(id, makeEl(id));
    return domEls.get(id);
  },
  createElement: (tag) => makeEl(tag),
  createDocumentFragment: () => ({ appendChild() {} }),
};
let rafCb = null;
global.window = {
  devicePixelRatio: 1,
  requestAnimationFrame: (cb) => { rafCb = cb; return 1; },
  cancelAnimationFrame: () => { rafCb = null; },
  setTimeout,
  clearTimeout,
};
global.fetch = async () => ({ ok: false });

function makeMockCy(initialZoom, nodePositions) {
  let z = initialZoom;
  let p = { x: 0, y: 0 };
  let panWrites = 0;
  let zoomWrites = 0;
  return {
    zoom(v) { if (v !== undefined) { z = v; zoomWrites += 1; } return z; },
    pan(v) { if (v !== undefined) { p = { x: v.x, y: v.y }; panWrites += 1; } return p; },
    getStats: () => ({ pan: p, zoom: z, panWrites, zoomWrites }),
    edges: () => [],
    getElementById: (id) => {
      const pos = nodePositions[id];
      if (!pos) return { length: 0 };
      return {
        length: 1,
        isNode: () => true,
        position: () => pos,
        boundingBox: () => ({ x1: pos.x - 40, x2: pos.x + 40, y1: pos.y - 20, y2: pos.y + 20, w: 80, h: 40 }),
        renderedBoundingBox: () => ({ x1: pos.x * z + p.x - 40, x2: pos.x * z + p.x + 40, y1: pos.y * z + p.y - 20, y2: pos.y * z + p.y + 20, w: 80, h: 40 }),
      };
    },
  };
}

const mainCy = makeMockCy(1.45, {
  'app.py::run': { x: 650, y: 420 },
  'app.py::leaf': { x: 920, y: 610 },
});
const winCy = makeMockCy(0.85, {
  'app.py::run': { x: 320, y: 240 },
});
const fakeWin = {
  id: 'fw-1',
  targetId: 'app.py::run',
  destroyed: false,
  viewMode: 'flow',
  cy: winCy,
  cyContainer: makeEl('fw-cy'),
};
const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
let bridgePans = 0;

const ctrl = wt.createController({
  getCy: () => mainCy,
  getRawGraph: () => graph,
  getNodesById: () => nodesById,
  getActiveLevel: () => 3,
  getFloatingWindows: () => [fakeWin],
  getFloatingWindowById: (id) => (id === 'fw-1' ? fakeWin : null),
  onFloatingCameraPan: () => { bridgePans += 1; },
});

(async () => {
  await ctrl.start({ scope: 'main', rootId: 'app.py::run', granularity: 'pulse', followCamera: true });
  if (!ctrl.getState().followCamera) throw new Error('followCamera debería iniciar activo');
  if (document.getElementById('btn-wt-follow').attrs['aria-pressed'] !== 'true') {
    throw new Error('btn-wt-follow aria-pressed debería ser true');
  }
  // Simular frames rAF en el lienzo principal.
  const baseNow = performance.now();
  for (let i = 1; i <= 10; i += 1) {
    if (rafCb) rafCb(baseNow + i * 25);
  }
  const mainStats = mainCy.getStats();
  if (mainStats.panWrites === 0) throw new Error('Cámara en mainCy no aplicó pan suave');
  if (mainStats.zoomWrites !== 0 || mainStats.zoom !== 1.45) {
    throw new Error('Cámara alteró el zoom del usuario: ' + JSON.stringify(mainStats));
  }
  // Paneo manual en otro cy (winCy) NO debe apagar seguimiento en mainCy.
  if (ctrl.notifyManualPan(winCy) !== false || !ctrl.getState().followCamera) {
    throw new Error('Paneo manual en cy ajeno desactivó erróneamente followCamera');
  }
  // Paneo manual en mainCy SÍ debe ceder el control y apagar 🎥 Seguir.
  if (ctrl.notifyManualPan(mainCy) !== true || ctrl.getState().followCamera) {
    throw new Error('Paneo manual en mainCy no desactivó followCamera');
  }
  if (document.getElementById('btn-wt-follow').attrs['aria-pressed'] !== 'false') {
    throw new Error('btn-wt-follow aria-pressed no pasó a false tras paneo manual');
  }
  ctrl.stop();

  // 3. Probar seguimiento en modo aislado scope='window' (solo panea winCy, nunca mainCy).
  const mainPanBefore = { ...mainCy.getStats().pan };
  await ctrl.start({
    scope: 'window',
    windowId: 'fw-1',
    rootId: 'app.py::run',
    granularity: 'step',
    stepInto: false,
    followCamera: true,
  });
  const winNow = performance.now();
  for (let i = 1; i <= 8; i += 1) {
    if (rafCb) rafCb(winNow + i * 25);
  }
  const winStats = winCy.getStats();
  if (winStats.panWrites === 0 || winStats.zoomWrites !== 0 || winStats.zoom !== 0.85) {
    throw new Error('Seguimiento en ventana flotante incorrecto: ' + JSON.stringify(winStats));
  }
  if (bridgePans === 0) throw new Error('onFloatingCameraPan no se disparó al panear ventana');
  const mainPanAfter = mainCy.getStats().pan;
  if (mainPanAfter.x !== mainPanBefore.x || mainPanAfter.y !== mainPanBefore.y) {
    throw new Error('Seguimiento en ventana flotante modificó mainCy.pan()');
  }
  if (ctrl.notifyManualPan(winCy) !== true || ctrl.getState().followCamera) {
    throw new Error('Paneo manual en winCy no desactivó followCamera');
  }
  ctrl.stop();
  console.log('FOLLOW_CAMERA_OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
"""
        )
        proc = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, f"Falló prueba de cámara de seguimiento:\n{proc.stderr}")
        self.assertIn("FOLLOW_CAMERA_OK", proc.stdout)

    def test_selective_plus_one_expansion_all_levels_folders_layers_and_exact_restore(self) -> None:
        files = {
            "pkg_a/a1.py": '''
                from pkg_a.a2 import transform
                def entry(x):
                    if x > 0:
                        return transform(x)
                    return 0
            ''',
            "pkg_a/a2.py": '''
                from pkg_b.b1 import save
                def transform(v):
                    res = v * 2
                    return save(res)
            ''',
            "pkg_b/b1.py": '''
                def save(val):
                    if val > 10:
                        return val
                    return 10

                def manual_fn(z):
                    if z:
                        return z
                    return 1
            ''',
        }
        graph = _build_temp_graph(files)

        node_script = (
            f"const fs = require('fs');\n"
            f"const src = fs.readFileSync({json.dumps(str(APP_JS))}, 'utf8');\n"
            f"const graph = {json.dumps(graph)};\n"
            """
function extractFn(name) {
  const marker = 'function ' + name + '(';
  const asyncMarker = 'async function ' + name + '(';
  let start = src.indexOf(asyncMarker);
  if (start === -1) start = src.indexOf(marker);
  if (start === -1) throw new Error('No se encontró ' + name);
  const sigEnd = src.indexOf(') {', start);
  if (sigEnd === -1) throw new Error('No se encontró cuerpo de ' + name);
  const bodyStart = sigEnd + 2;
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('Llaves desbalanceadas en ' + name);
}

const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
const childrenByParent = new Map();
for (const n of graph.nodes) {
  const key = n.parent || null;
  if (!childrenByParent.has(key)) childrenByParent.set(key, []);
  childrenByParent.get(key).push(n);
}

let refreshCalls = 0;
const state = {
  rawGraph: graph,
  nodesById,
  childrenByParent,
  activeLevel: 1,
  groupingMode: 'folders',
  collapsedContainers: new Set(),
  expandedFunctions: new Set(),
  cy: {
    _z: 1.2,
    _p: { x: 10, y: 20 },
    zoom(v) { if (v !== undefined) this._z = v; return this._z; },
    pan(v) { if (v !== undefined) this._p = { x: v.x, y: v.y }; return this._p; },
  },
  walkthroughExpansion: {
    hasSnapshot: false,
    activeLevel: null,
    groupingMode: null,
    preCollapsed: new Set(),
    preExpanded: new Set(),
    tempOpenedContainers: new Set(),
    tempCollapsedContainers: new Set(),
    tempExpandedFunctions: new Set(),
    activeTargetKey: null,
  },
};

function countDescendantFunctions(id) {
  const node = nodesById.get(id);
  if (!node) return 0;
  if (node.type === 'function') return 1;
  let total = 0;
  for (const ch of childrenByParent.get(id) || []) total += countDescendantFunctions(ch.id);
  return total;
}
function getNodeArchLayer(node) {
  return Number.isFinite(node && node.arch_layer) ? node.arch_layer : 1;
}
async function refreshGraphView() { refreshCalls += 1; }
function updateZoomIndicator() {}

eval(extractFn('resolveFileIdForNode'));
eval(extractFn('resetWalkthroughExpansionSnapshot'));
eval(extractFn('captureWalkthroughExpansionSnapshot'));
eval(extractFn('clearWalkthroughTempDeltas'));
eval(extractFn('resolveOwnerFunctionIdForWalkthrough'));
eval(extractFn('resolveVisibleFallbackLayerId'));
eval(extractFn('computeWalkthroughSelectiveExpansionPlan'));
eval(extractFn('syncWalkthroughSelectiveExpansion'));
eval(extractFn('restoreWalkthroughExpansion'));

const fnEntry = 'pkg_a/a1.py::entry';
const fnTransform = 'pkg_a/a2.py::transform';
const fnSave = 'pkg_b/b1.py::save';
const fnManual = 'pkg_b/b1.py::manual_fn';

(async () => {
  // === NIVEL 1 (Carpetas): abrir SOLO módulo activo con sus archivos colapsados (+1 estricto) ===
  state.activeLevel = 1;
  state.groupingMode = 'folders';
  state.collapsedContainers = new Set(['pkg_a', 'pkg_b']);
  state.expandedFunctions = new Set();
  resetWalkthroughExpansionSnapshot();

  const r1 = await syncWalkthroughSelectiveExpansion({ fn_id: fnEntry }, { scope: 'main', granularity: 'step' });
  if (!r1.relayouted) throw new Error('Nivel 1 debía hacer relayout al abrir pkg_a');
  if (state.collapsedContainers.has('pkg_a')) throw new Error('pkg_a debía abrirse temporalmente');
  if (!state.collapsedContainers.has('pkg_b')) throw new Error('pkg_b hermano debía seguir colapsado');
  if (!state.collapsedContainers.has('pkg_a/a1.py') || !state.collapsedContainers.has('pkg_a/a2.py')) {
    throw new Error('En Nivel 1 los archivos dentro de pkg_a deben quedar colapsados (+1 estricto)');
  }
  // Avanzar dentro del mismo módulo pkg_a (a1 -> a2): 0 relayouts adicionales
  const r1Same = await syncWalkthroughSelectiveExpansion({ fn_id: fnTransform }, { scope: 'main', granularity: 'step' });
  if (r1Same.relayouted) throw new Error('Mismo módulo en N1 no debe disparar relayout');

  // Saltar a pkg_b: pkg_a debe volver a colapsarse y abrirse solo pkg_b con b1.py colapsado
  const r1Next = await syncWalkthroughSelectiveExpansion({ fn_id: fnSave }, { scope: 'main', granularity: 'step' });
  if (!r1Next.relayouted) throw new Error('Cambio de módulo en N1 debía disparar relayout');
  if (!state.collapsedContainers.has('pkg_a') || state.collapsedContainers.has('pkg_b')) {
    throw new Error('Al pasar a pkg_b, pkg_a debió colapsarse y pkg_b abrirse');
  }
  if (!state.collapsedContainers.has('pkg_b/b1.py')) {
    throw new Error('b1.py dentro de pkg_b debió quedar colapsado (+1 estricto)');
  }
  await restoreWalkthroughExpansion({ scope: 'main', keepSnapshot: false });
  if (
    state.collapsedContainers.size !== 2
    || !state.collapsedContainers.has('pkg_a')
    || !state.collapsedContainers.has('pkg_b')
  ) {
    throw new Error('Restauración en N1 no devolvió exactamente {pkg_a, pkg_b}: ' + JSON.stringify([...state.collapsedContainers]));
  }

  // === NIVEL 1 (Capas): abrir SOLO layer::k con archivos colapsados + fallback layer::k ===
  state.activeLevel = 1;
  state.groupingMode = 'layers';
  const entryLayer = getNodeArchLayer(nodesById.get('pkg_a/a1.py'));
  const entryLayerId = `layer::${entryLayer}`;
  state.collapsedContainers = new Set(['layer::0', 'layer::1', 'layer::2', 'layer::3']);
  resetWalkthroughExpansionSnapshot();
  if (resolveVisibleFallbackLayerId(fnEntry) !== entryLayerId) {
    throw new Error('resolveVisibleFallbackLayerId no devolvió ' + entryLayerId);
  }
  await syncWalkthroughSelectiveExpansion({ fn_id: fnEntry }, { scope: 'main', granularity: 'step' });
  if (state.collapsedContainers.has(entryLayerId)) throw new Error('Capa activa debió abrirse');
  if (!state.collapsedContainers.has('pkg_a/a1.py')) throw new Error('Archivo en capa abierta debió quedar colapsado (+1)');
  await restoreWalkthroughExpansion({ scope: 'main', keepSnapshot: false });
  if (!state.collapsedContainers.has(entryLayerId) || state.collapsedContainers.has('pkg_a/a1.py')) {
    throw new Error('Restauración en N1 capas falló');
  }

  // === NIVEL 2 (Archivos): abrir SOLO archivo activo para mostrar funciones ===
  state.activeLevel = 2;
  state.groupingMode = 'folders';
  state.collapsedContainers = new Set(['pkg_a/a1.py', 'pkg_a/a2.py', 'pkg_b/b1.py']);
  state.expandedFunctions = new Set();
  resetWalkthroughExpansionSnapshot();

  await syncWalkthroughSelectiveExpansion({ fn_id: fnEntry }, { scope: 'main', granularity: 'step' });
  if (state.collapsedContainers.has('pkg_a/a1.py')) throw new Error('a1.py debió abrirse en N2');
  if (!state.collapsedContainers.has('pkg_a/a2.py') || !state.collapsedContainers.has('pkg_b/b1.py')) {
    throw new Error('Archivos hermanos debieron permanecer colapsados en N2');
  }
  if (state.expandedFunctions.size !== 0) throw new Error('N2 no debe expandir flujos internos 3+');

  await syncWalkthroughSelectiveExpansion({ fn_id: fnTransform }, { scope: 'main', granularity: 'step' });
  if (!state.collapsedContainers.has('pkg_a/a1.py') || state.collapsedContainers.has('pkg_a/a2.py')) {
    throw new Error('N2 debió contraer a1.py y abrir a2.py');
  }
  await restoreWalkthroughExpansion({ scope: 'main', keepSnapshot: false });
  if (state.collapsedContainers.size !== 3) throw new Error('Restauración N2 falló');

  // === NIVEL 3 (Funciones): expandir SOLO función activa preservando expansiones manuales previas ===
  state.activeLevel = 3;
  state.groupingMode = 'folders';
  state.collapsedContainers = new Set();
  state.expandedFunctions = new Set([fnManual]);
  resetWalkthroughExpansionSnapshot();

  await syncWalkthroughSelectiveExpansion({ fn_id: fnEntry }, { scope: 'main', granularity: 'step' });
  if (!state.expandedFunctions.has(fnEntry) || !state.expandedFunctions.has(fnManual)) {
    throw new Error('N3 debió expandir fnEntry conservando fnManual');
  }
  if (state.expandedFunctions.has(fnTransform) || state.expandedFunctions.has(fnSave)) {
    throw new Error('N3 no debe expandir funciones hermanas');
  }

  await syncWalkthroughSelectiveExpansion({ fn_id: fnSave }, { scope: 'main', granularity: 'step' });
  if (state.expandedFunctions.has(fnEntry) || !state.expandedFunctions.has(fnSave) || !state.expandedFunctions.has(fnManual)) {
    throw new Error('N3 debió colapsar fnEntry, expandir fnSave y conservar fnManual');
  }

  await restoreWalkthroughExpansion({ scope: 'main', keepSnapshot: true });
  if (state.expandedFunctions.size !== 1 || !state.expandedFunctions.has(fnManual)) {
    throw new Error('Al volver a Pulso, debió quedar exactamente fnManual: ' + JSON.stringify([...state.expandedFunctions]));
  }

  // === NIVEL 3+ (Intra-función): no altera expansiones ni hace relayout ===
  state.activeLevel = 4;
  state.expandedFunctions = new Set([fnEntry, fnTransform, fnSave, fnManual]);
  resetWalkthroughExpansionSnapshot();
  const r4 = await syncWalkthroughSelectiveExpansion({ fn_id: fnEntry }, { scope: 'main', granularity: 'step' });
  if (r4.relayouted || state.expandedFunctions.size !== 4) {
    throw new Error('Nivel 3+ no debía alterar expansiones');
  }

  // === Ventana flotante: nunca muta el grafo principal ===
  state.activeLevel = 3;
  state.expandedFunctions = new Set();
  const rWin = await syncWalkthroughSelectiveExpansion({ fn_id: fnEntry }, { scope: 'window', granularity: 'step' });
  if (rWin.relayouted || state.expandedFunctions.size !== 0) {
    throw new Error('scope=window nunca debe tocar el lienzo principal');
  }

  console.log('SELECTIVE_PLUS_ONE_OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
"""
        )
        proc = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, f"Falló prueba de expansión +1:\n{proc.stderr}")
        self.assertIn("SELECTIVE_PLUS_ONE_OK", proc.stdout)

    def test_walkthrough_level_granularity_and_async_clock_pause_on_relayout(self) -> None:
        files = {
            "flow.py": '''
                def helper(v):
                    if v > 0:
                        return v + 1
                    return 0

                def main(x):
                    if x > 0:
                        y = helper(x)
                        return y
                    return -1
            ''',
        }
        graph = _build_temp_graph(files)

        node_script = (
            f"const wt = require({json.dumps(str(WALKTHROUGH_JS))});\n"
            f"const graph = {json.dumps(graph)};\n"
            """
const domEls = new Map();
const makeEl = (id) => ({
  id,
  className: '',
  textContent: '',
  title: '',
  value: '1',
  dataset: {},
  style: {},
  attrs: {},
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
  setAttribute(k, v) { this.attrs[k] = v; },
  appendChild() {},
  replaceChildren() {},
  addEventListener() {},
  getContext() { return { save(){}, restore(){}, setTransform(){}, clearRect(){} }; },
  getBoundingClientRect() { return { left: 0, top: 0, width: 500, height: 400 }; },
  clientWidth: 500,
  clientHeight: 400,
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

// 1. Probar resolveVisibleCyNodeId con fallback a layer::k
const layerCy = {
  getElementById: (id) => (id === 'layer::1' ? { length: 1, isNode: () => true } : { length: 0 }),
};
const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
const resolvedLayer = wt.resolveVisibleCyNodeId(layerCy, 'flow.py::main', nodesById, () => 'layer::1');
if (resolvedLayer !== 'layer::1') {
  throw new Error('resolveVisibleCyNodeId no usó fallback layer::1: ' + resolvedLayer);
}

// 2. Controlador con nivel dinámico y relayout asíncrono
let activeLevel = 2;
let syncCalls = [];
let restoreCalls = 0;
let stopCalls = 0;
const activeEventsSeen = [];

const ctrl = wt.createController({
  getCy: () => null,
  getRawGraph: () => graph,
  getNodesById: () => nodesById,
  getActiveLevel: () => activeLevel,
  syncActiveEventExpansion: async (ev, opts) => {
    syncCalls.push({ fn_id: ev.fn_id, granularity: opts.granularity, eff: opts.effectiveGranularity });
    await new Promise((r) => setTimeout(r, 25));
    return { relayouted: true };
  },
  restoreWalkthroughExpansion: async () => { restoreCalls += 1; },
  onWalkthroughStopped: async () => { stopCalls += 1; },
  onEventActive: (ev) => { activeEventsSeen.push(ev.seq); },
});

(async () => {
  // En Nivel 2 con Paso a Paso: granularidad efectiva debe ser 'pulse' (llamadas/retornos)
  await ctrl.start({ scope: 'main', rootId: 'flow.py::main', granularity: 'step' });
  const stN2 = ctrl.getState();
  if (stN2.granularity !== 'step' || stN2.effectiveGranularity !== 'pulse') {
    throw new Error('En N2 Paso a Paso debía usar effectiveGranularity=pulse: ' + JSON.stringify(stN2));
  }
  if (!document.getElementById('btn-wt-step-into').classList.contains('hidden')) {
    throw new Error('btn-wt-step-into debía ocultarse en N2');
  }
  if (!document.getElementById('wt-stack-mode-badge').textContent.includes('N2 (+1)')) {
    throw new Error('Badge de modo incorrecto en N2: ' + document.getElementById('wt-stack-mode-badge').textContent);
  }

  // Cambiar a Nivel 3 y notificar onLevelChanged: ahora Paso a Paso debe usar 'step' (intra-función)
  activeLevel = 3;
  await ctrl.onLevelChanged();
  const stN3 = ctrl.getState();
  if (stN3.effectiveGranularity !== 'step') {
    throw new Error('En N3 Paso a Paso debía usar effectiveGranularity=step: ' + JSON.stringify(stN3));
  }
  if (document.getElementById('btn-wt-step-into').classList.contains('hidden')) {
    throw new Error('btn-wt-step-into debía mostrarse en N3');
  }

  // Race guard: dos stepForward consecutivos antes de terminar el async de 25ms solo activan el último
  activeEventsSeen.length = 0;
  const p1 = ctrl.stepForward();
  const p2 = ctrl.stepForward();
  await Promise.all([p1, p2]);
  if (activeEventsSeen.length !== 1 || activeEventsSeen[0] !== ctrl.getCurrentEvent().seq) {
    throw new Error('Race guard falló en clics rápidos: ' + JSON.stringify(activeEventsSeen));
  }

  // Volver a Pulso debe invocar restoreWalkthroughExpansion
  await ctrl.setGranularity('pulse');
  if (restoreCalls < 1) throw new Error('setGranularity(pulse) no restauró expansiones temporales');

  // Cerrar recorrido debe invocar onWalkthroughStopped
  ctrl.stop();
  if (stopCalls < 1) throw new Error('stop() no invocó onWalkthroughStopped');

  console.log('ASYNC_GRANULARITY_OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
"""
        )
        proc = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, f"Falló prueba async/granularidad:\n{proc.stderr}")
        self.assertIn("ASYNC_GRANULARITY_OK", proc.stdout)


if __name__ == "__main__":
    unittest.main()
