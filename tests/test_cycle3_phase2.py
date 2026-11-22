"""Pruebas unitarias de la Fase 2 (Ciclo 3): ergonomía del visor, paneo global, tooltip 1s, Inspector y limpieza UI."""

from __future__ import annotations

import json
import re
import subprocess
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VIEWER_DIR = REPO_ROOT / "codemap" / "viewer"


class TestCycle3Phase2ViewerAndSecurity(unittest.TestCase):
    def setUp(self) -> None:
        self.html = (VIEWER_DIR / "index.html").read_text(encoding="utf-8")
        self.css = (VIEWER_DIR / "styles.css").read_text(encoding="utf-8")
        self.js = (VIEWER_DIR / "app.js").read_text(encoding="utf-8")

    def test_residual_topbar_inspector_references_removed(self) -> None:
        self.assertNotIn("btn-topbar-inspector", self.html)
        self.assertNotIn("btn-topbar-inspector", self.js)
        self.assertNotIn(".toolbar-right", self.css)
        self.assertNotIn(".inspector-toggle-btn", self.css)

    def test_legend_toggle_moved_to_sidebar_footer_and_legend_content_preserved(self) -> None:
        # `#btn-toggle-legend` vive dentro de `.sidebar-footer` en `#left-sidebar`.
        sidebar_match = re.search(
            r'<aside id="left-sidebar"[\s\S]*?</aside>',
            self.html,
        )
        self.assertIsNotNone(sidebar_match)
        sidebar_html = sidebar_match.group(0)
        self.assertIn('class="sidebar-footer"', sidebar_html)
        self.assertIn('id="btn-toggle-legend"', sidebar_html)
        self.assertIn("🗺️", sidebar_html)
        self.assertIn("Leyenda", sidebar_html)

        # `#graph-legend` ya no contiene `#btn-toggle-legend`, pero conserva intacto su contenido desplegado.
        legend_match = re.search(
            r'<aside id="graph-legend"[\s\S]*?</aside>',
            self.html,
        )
        self.assertIsNotNone(legend_match)
        legend_html = legend_match.group(0)
        self.assertNotIn('id="btn-toggle-legend"', legend_html)
        self.assertIn("Nodos", legend_html)
        self.assertIn("Aristas", legend_html)
        self.assertIn("Flujo", legend_html)

        # `toggleLegend()` no sobrescribe `toggleBtn.textContent` (destruiría los spans internos).
        fn_match = re.search(r"function toggleLegend\([\s\S]*?\n\}", self.js)
        self.assertIsNotNone(fn_match)
        self.assertNotIn("toggleBtn.textContent", fn_match.group(0))
        self.assertIn('legend.classList.toggle("hidden", shouldCollapse)', fn_match.group(0))

    def test_global_and_floating_pan_controls_and_cleanup(self) -> None:
        self.assertIn("function attachPanControls(", self.js)
        self.assertIn("event.button === 2", self.js)
        self.assertIn("event.button === 1", self.js)
        self.assertIn("event.button === 0 && state.spacePanning", self.js)
        self.assertIn('"contextmenu"', self.js)
        self.assertIn("win.panCleanup = attachPanControls(", self.js)
        self.assertIn("win.panCleanup()", self.js)

        # `setSpacePanMode` se propaga a ventanas flotantes.
        space_match = re.search(r"function setSpacePanMode\([\s\S]*?\n\}", self.js)
        self.assertIsNotNone(space_match)
        self.assertIn("state.floatingWindows.values()", space_match.group(0))

        # `subCy.on("tap", "node", ...)` respeta `state.suppressNextTap`.
        sub_tap_match = re.search(r'subCy\.on\("tap", "node",[\s\S]*?\}\);', self.js)
        self.assertIsNotNone(sub_tap_match)
        self.assertIn("state.suppressNextTap", sub_tap_match.group(0))

    def test_node_docstring_tooltip_and_file_inspector_structure(self) -> None:
        # Tooltip flotante 1000 ms en HTML, CSS y JS (grafo principal + ventanas flotantes).
        self.assertIn('id="node-tooltip"', self.html)
        self.assertIn(".node-tooltip", self.css)
        self.assertIn("const NODE_TOOLTIP_DELAY_MS = 1000;", self.js)
        self.assertIn("function bindNodeDocstringTooltip(", self.js)
        self.assertIn("win.tooltipCleanup = bindNodeDocstringTooltip(subCy, win.bodyEl);", self.js)
        self.assertIn("win.tooltipCleanup()", self.js)

        # Inspector de archivo: bloque de funciones + orden CSS (Docstring -> Funciones -> Nota personal).
        self.assertIn('id="detail-file-functions-block"', self.html)
        self.assertIn('id="detail-file-functions-list"', self.html)
        self.assertIn('id="detail-docstring-title"', self.html)
        self.assertIn('id="detail-note-block"', self.html)
        self.assertIn(".details-content.node-type-file #detail-docstring-block {\n  order: 3;\n}", self.css)
        self.assertIn(".details-content.node-type-file #detail-file-functions-block {\n  order: 4;\n}", self.css)
        self.assertIn(".details-content.node-type-file #detail-note-block {\n  order: 5;\n}", self.css)
        self.assertIn('Docstring "${node.label}"', self.js)
        self.assertIn("function updateFileFunctionsBlock(", self.js)

    def test_client_url_security_helpers_in_node(self) -> None:
        # Verifica sintaxis JS y ejecuta los helpers reales `isSafeHttpUrl` y `encodeFileUriPath` en Node.
        check = subprocess.run(
            ["node", "--check", str(VIEWER_DIR / "app.js")],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(check.returncode, 0, check.stderr)

        script = textwrap_script = (
            "const fs = require('fs');\n"
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
            "eval(extract('isSafeHttpUrl') + '\\n' + extract('encodeFileUriPath'));\n"
            "const out = {\n"
            "  safeHttps: isSafeHttpUrl('https://docs.python.org/3/'),\n"
            "  safeHttp: isSafeHttpUrl('http://localhost:8080/a'),\n"
            "  evilJs: isSafeHttpUrl('javascript:alert(1)'),\n"
            "  evilData: isSafeHttpUrl('data:text/html,hi'),\n"
            "  evilFile: isSafeHttpUrl('file:///C:/win.ini'),\n"
            "  winPath: encodeFileUriPath('C:\\\\dev\\\\proyecto #2\\\\100% file?.py'),\n"
            "  unixPath: encodeFileUriPath('/home/dev/my proj/app#1.js'),\n"
            "};\n"
            "console.log(JSON.stringify(out));\n"
        )
        proc = subprocess.run(
            ["node", "-e", textwrap_script],
            capture_output=True,
            text=True,
            check=True,
        )
        res = json.loads(proc.stdout)
        self.assertTrue(res["safeHttps"])
        self.assertTrue(res["safeHttp"])
        self.assertFalse(res["evilJs"])
        self.assertFalse(res["evilData"])
        self.assertFalse(res["evilFile"])
        self.assertEqual(res["winPath"], "C:/dev/proyecto%20%232/100%25%20file%3F.py")
        self.assertEqual(res["unixPath"], "/home/dev/my%20proj/app%231.js")


if __name__ == "__main__":
    unittest.main()
