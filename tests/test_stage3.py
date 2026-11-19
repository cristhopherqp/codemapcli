"""Pruebas de la Etapa 3: enrutamiento ortogonal ELKjs -> Cytoscape, aislamiento y aristas bajo demanda."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VIEWER_DIR = REPO_ROOT / "codemap" / "viewer"


class TestStage3CanvasScalability(unittest.TestCase):
    def test_viewer_html_and_js_expose_stage3_controls_and_routing(self) -> None:
        html = (VIEWER_DIR / "index.html").read_text(encoding="utf-8")
        js = (VIEWER_DIR / "app.js").read_text(encoding="utf-8")

        for dom_id in (
            "btn-isolate-context",
            "btn-inspector-isolate-flow",
            "btn-trace-isolate",
            "btn-on-demand-edges",
        ):
            self.assertIn(f'id="{dom_id}"', html)

        for symbol in (
            '"elk.edgeRouting": "ORTHOGONAL"',
            "computeSubgraphFilter",
            "applyElkEdgeRoutes",
            "convertElkPointsToCytoscapeSegments",
            "applyOnDemandEdgeHighlight",
            "edge-reveal-in",
            "edge-reveal-out",
        ):
            self.assertIn(symbol, js)

    @unittest.skipUnless(shutil.which("node"), "Node.js no disponible en PATH")
    def test_elk_orthogonal_segments_inverse_matches_cytoscape_geometry(self) -> None:
        """Verifica con ELKjs real que `convertElkPointsToCytoscapeSegments` reconstruye
        exactamente cada punto de quiebre (con offset de contenedor incluido)."""
        script = r"""
const fs = require('fs');
const vm = require('vm');
const ELK = require('./codemap/viewer/vendor/elk.bundled.js');

const appSrc = fs.readFileSync('./codemap/viewer/app.js', 'utf8');
const fnMatch = appSrc.match(/function convertElkPointsToCytoscapeSegments[\s\S]*?\n\}\n/);
if (!fnMatch) {
  throw new Error('convertElkPointsToCytoscapeSegments not found');
}
const sandbox = { Math, Number };
vm.runInNewContext(fnMatch[0], sandbox);
const convert = sandbox.convertElkPointsToCytoscapeSegments;

(async () => {
  const elk = new ELK();
  const layouted = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.edgeNode': '20',
      'elk.spacing.edgeEdge': '12',
    },
    children: [
      { id: 'f1', children: [{ id: 'a', width: 120, height: 40 }, { id: 'b', width: 120, height: 40 }] },
      { id: 'f2', children: [{ id: 'c', width: 120, height: 40 }] },
    ],
    edges: [
      { id: 'e1', sources: ['a'], targets: ['b'] },
      { id: 'e2', sources: ['a'], targets: ['c'] },
      { id: 'e3', sources: ['b'], targets: ['c'] },
    ],
  });

  const pos = new Map();
  const offsets = new Map([['root', { x: 0, y: 0 }]]);
  function walk(node, ox, oy) {
    for (const ch of node.children || []) {
      const ax = ox + (ch.x || 0);
      const ay = oy + (ch.y || 0);
      if (ch.children && ch.children.length) {
        offsets.set(ch.id, { x: ax, y: ay });
        walk(ch, ax, ay);
      } else {
        pos.set(ch.id, { x: ax + ch.width / 2, y: ay + ch.height / 2 });
      }
    }
  }
  walk(layouted, 0, 0);

  const e2 = layouted.edges.find((e) => e.id === 'e2');
  const sec = e2.sections[0];
  const off = offsets.get(e2.container || 'root') || { x: 0, y: 0 };
  const pts = [sec.startPoint, ...(sec.bendPoints || []), sec.endPoint].map((p) => ({
    x: p.x + off.x,
    y: p.y + off.y,
  }));
  const src = pos.get('a');
  const tgt = pos.get('c');
  const res = convert(pts, src, tgt);

  // Reconstrucción exacta usando la fórmula de Cytoscape (`findMidptPtsEtc` / `findSegmentsPoints`).
  const dx = tgt.x - src.x;
  const dy = tgt.y - src.y;
  const len = Math.hypot(dx, dy);
  const normInv = { x: -dy / len, y: dx / len };

  const maxErr = res.weights.reduce((acc, w, idx) => {
    const d = res.distances[idx];
    const rx = src.x * (1 - w) + tgt.x * w + normInv.x * d;
    const ry = src.y * (1 - w) + tgt.y * w + normInv.y * d;
    const err = Math.hypot(rx - pts[idx].x, ry - pts[idx].y);
    return Math.max(acc, err);
  }, 0);

  console.log(JSON.stringify({ bendCount: sec.bendPoints.length, segCount: res.weights.length, maxErr }));
})();
"""
        proc = subprocess.run(
            ["node", "-e", script],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        data = json.loads(proc.stdout.strip())
        self.assertGreater(data["bendCount"], 0)
        self.assertGreaterEqual(data["segCount"], data["bendCount"])
        self.assertLess(data["maxErr"], 0.15)


if __name__ == "__main__":
    unittest.main()
