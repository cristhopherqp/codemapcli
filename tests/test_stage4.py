"""Pruebas de la Etapa 4: capas topológicas automáticas (Tarjan SCC), N-hops y particionamiento ELK."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

from codemap.discovery import discover_files
from codemap.exporter import build_ai_graph, serialize_ai_graph
from codemap.graph_builder import (
    ARCHITECTURAL_LAYERS,
    LARGE_PROJECT_FUNCTIONS,
    build_graph,
)
from codemap.parsers import parse_file
from codemap.paths import normalize_path

REPO_ROOT = Path(__file__).resolve().parent.parent
VIEWER_DIR = REPO_ROOT / "codemap" / "viewer"


def _write_tree(root: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(content).lstrip("\n"), encoding="utf-8")


def _build_project_graph(root: Path) -> dict:
    files = discover_files(root)
    analyses = [a for p in files if (a := parse_file(p)) is not None]
    target = normalize_path(root)
    return build_graph(
        analyses,
        target_path=target,
        root_dir=target,
        is_single_file=False,
        include_private=False,
    )


def _node_map(graph: dict) -> dict[str, dict]:
    return {n["id"]: n for n in graph["nodes"]}


class TestStage4ArchitecturalLayersAndNHops(unittest.TestCase):
    def test_linear_four_tier_architecture_assigns_layers_0_to_3(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_tree(
                root,
                {
                    "ui/entry.py": """
                    from core.orchestrator import coordinate

                    def main():
                        return coordinate()

                    if __name__ == "__main__":
                        main()
                    """,
                    "core/orchestrator.py": """
                    from services.orders import process_order

                    def coordinate():
                        return process_order()
                    """,
                    "services/orders.py": """
                    from utils.fmt import clean_text

                    def process_order():
                        return clean_text("order")
                    """,
                    "utils/fmt.py": """
                    def clean_text(raw: str) -> str:
                        return raw.strip()
                    """,
                },
            )
            graph = _build_project_graph(root)
            nodes = _node_map(graph)

            self.assertEqual(graph["meta"]["large_project_threshold"], LARGE_PROJECT_FUNCTIONS)
            self.assertEqual(len(graph["meta"]["architectural_layers"]), len(ARCHITECTURAL_LAYERS))

            # Archivos estratificados 0 -> 1 -> 2 -> 3
            self.assertEqual(nodes["ui/entry.py"]["arch_layer"], 0)
            self.assertEqual(nodes["core/orchestrator.py"]["arch_layer"], 1)
            self.assertEqual(nodes["services/orders.py"]["arch_layer"], 2)
            self.assertEqual(nodes["utils/fmt.py"]["arch_layer"], 3)

            # Funciones estratificadas 0 -> 1 -> 2 -> 3
            self.assertEqual(nodes["ui/entry.py::main"]["arch_layer"], 0)
            self.assertEqual(nodes["core/orchestrator.py::coordinate"]["arch_layer"], 1)
            self.assertEqual(nodes["services/orders.py::process_order"]["arch_layer"], 2)
            self.assertEqual(nodes["utils/fmt.py::clean_text"]["arch_layer"], 3)

    def test_cycles_and_reactive_pubsub_condense_cleanly_via_tarjan_scc(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_tree(
                root,
                {
                    "js/app.js": """
                    import { subscribeState, updateCount } from './state.js';
                    import { ping } from './cycleA.js';

                    export function renderView() {
                      return 1;
                    }

                    export function initApp() {
                      subscribeState(renderView);
                      updateCount();
                      ping();
                    }
                    initApp();
                    """,
                    "js/state.js": """
                    const listeners = [];
                    export function subscribeState(cb) {
                      listeners.push(cb);
                    }
                    export function notifyState() {
                      listeners.forEach((cb) => cb());
                    }
                    export function updateCount() {
                      notifyState();
                    }
                    """,
                    "js/cycleA.js": """
                    import { pong } from './cycleB.js';
                    import { formatOut } from './util.js';

                    export function ping() {
                      pong();
                      return formatOut('a');
                    }
                    """,
                    "js/cycleB.js": """
                    import { ping } from './cycleA.js';

                    export function pong() {
                      return ping();
                    }
                    """,
                    "js/util.js": """
                    export function formatOut(v) {
                      return String(v);
                    }
                    """,
                },
            )
            graph = _build_project_graph(root)
            nodes = _node_map(graph)

            # `app.js` sigue en capa 0 pese al disparo reactivo `state.js -> app.js::renderView`.
            self.assertEqual(nodes["js/app.js"]["arch_layer"], 0)
            self.assertEqual(nodes["js/state.js"]["arch_layer"], 2)
            # Ciclo mutuo `cycleA <-> cycleB` se condensa en la misma capa intermedia (1), encima de `util.js` (3).
            self.assertEqual(nodes["js/cycleA.js"]["arch_layer"], nodes["js/cycleB.js"]["arch_layer"])
            self.assertLess(nodes["js/cycleA.js"]["arch_layer"], nodes["js/util.js"]["arch_layer"])
            self.assertEqual(nodes["js/util.js"]["arch_layer"], 3)

    def test_examples_multi_layers_and_exporter_preserves_layer_zero(self) -> None:
        multi_dir = REPO_ROOT / "examples" / "multi"
        graph = _build_project_graph(multi_dir)
        nodes = _node_map(graph)

        for node in graph["nodes"]:
            if node["type"] in ("file", "function"):
                self.assertIn("arch_layer", node)
                self.assertIn(node["arch_layer"], (0, 1, 2, 3))

        self.assertEqual(nodes["backend/app.py"]["arch_layer"], 0)
        self.assertEqual(nodes["frontend/src/main.ts"]["arch_layer"], 0)
        self.assertEqual(nodes["frontend/src/server.js"]["arch_layer"], 0)
        self.assertEqual(nodes["backend/services/users.py"]["arch_layer"], 2)
        self.assertEqual(nodes["frontend/src/store.tsx"]["arch_layer"], 2)
        self.assertEqual(nodes["backend/utils.py"]["arch_layer"], 3)
        self.assertEqual(nodes["frontend/src/format.js"]["arch_layer"], 3)

        # `exporter.py` debe conservar `arch_layer: 0` (no podarlo como si fuera `False`).
        ai_graph = build_ai_graph(graph, include_flow=False)
        ai_nodes = {n["id"]: n for n in ai_graph["nodes"]}
        self.assertEqual(ai_nodes["backend/app.py"]["arch_layer"], 0)
        self.assertEqual(ai_nodes["backend/app.py::main"]["arch_layer"], 0)
        self.assertEqual(ai_nodes["backend/utils.py"]["arch_layer"], 3)
        self.assertIn('"arch_layer":0', serialize_ai_graph(graph, include_flow=False))

    def test_viewer_exposes_stage4_nhops_and_layers_controls(self) -> None:
        html = (VIEWER_DIR / "index.html").read_text(encoding="utf-8")
        js = (VIEWER_DIR / "app.js").read_text(encoding="utf-8")

        for dom_id in (
            "btn-group-folders",
            "btn-group-layers",
            "nhops-hud",
            "btn-nhops-add-back",
            "btn-nhops-add-fwd",
            "btn-nhops-1",
            "btn-nhops-2",
            "btn-nhops-show-all",
            "btn-explore-nhops",
        ):
            self.assertIn(f'id="{dom_id}"', html)

        for symbol in (
            "computeNHopsSubgraph",
            "buildLayerModeElements",
            "setGroupingMode",
            '"elk.partitioning.activate": "true"',
            '"elk.partitioning.partition"',
        ):
            self.assertIn(symbol, js)

    @unittest.skipUnless(shutil.which("node"), "Node.js no disponible en PATH")
    def test_elk_partitioning_orders_architectural_layers_monotonically(self) -> None:
        script = r"""
const ELK = require('./codemap/viewer/vendor/elk.bundled.js');
(async () => {
  const elk = new ELK();
  const res = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.partitioning.activate': 'true',
    },
    children: [
      { id: 'layer::0', layoutOptions: { 'elk.partitioning.partition': '0' }, children: [{ id: 'n0', width: 120, height: 40 }] },
      { id: 'layer::1', layoutOptions: { 'elk.partitioning.partition': '1' }, children: [{ id: 'n1', width: 120, height: 40 }] },
      { id: 'layer::2', layoutOptions: { 'elk.partitioning.partition': '2' }, children: [{ id: 'n2', width: 120, height: 40 }] },
      { id: 'layer::3', layoutOptions: { 'elk.partitioning.partition': '3' }, children: [{ id: 'n3', width: 120, height: 40 }] },
    ],
    edges: [
      { id: 'e1', sources: ['n0'], targets: ['n1'] },
      { id: 'e2', sources: ['n1'], targets: ['n2'] },
      { id: 'e3', sources: ['n2'], targets: ['n3'] },
      { id: 'e4', sources: ['n3'], targets: ['n0'] },
    ],
  });
  const byId = Object.fromEntries(res.children.map((c) => [c.id, c.y]));
  console.log(JSON.stringify(byId));
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
        ys = json.loads(proc.stdout.strip())
        self.assertLess(ys["layer::0"], ys["layer::1"])
        self.assertLess(ys["layer::1"], ys["layer::2"])
        self.assertLess(ys["layer::2"], ys["layer::3"])


if __name__ == "__main__":
    unittest.main()
