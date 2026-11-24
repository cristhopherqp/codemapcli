"""Pruebas de Fases 6.3 y 6.4 (Ciclo 6): ClassInfo, __init__ visible, grilla 3x2, Liberar fijados y controles flotantes."""

from __future__ import annotations

import json
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

from codemap.discovery import discover_files
from codemap.exporter import build_ai_graph, build_ai_markdown
from codemap.graph_builder import build_graph
from codemap.parsers import parse_file
from codemap.paths import normalize_path

REPO_ROOT = Path(__file__).resolve().parent.parent
VIEWER_DIR = REPO_ROOT / "codemap" / "viewer"


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


class TestCycle6Phase3ClassInfoAndInitVisibility(unittest.TestCase):
    def test_python_class_info_docstring_inheritance_and_default_init_visibility(self) -> None:
        files = {
            "service.py": '''
                """Módulo de servicios de negocio."""

                from abc import ABC, abstractmethod
                from dataclasses import dataclass
                from typing import Generic, TypeVar

                T = TypeVar("T")

                @dataclass
                class BaseRepo(ABC, Generic[T]):
                    """Repositorio base abstracto para persistencia."""

                    def __init__(self, dsn: str):
                        """Inicializa la conexión del repositorio."""
                        self.dsn = dsn

                    def fetch(self, item_id: str):
                        return self._load_raw(item_id)

                    def _load_raw(self, item_id: str):
                        return item_id

                    def __repr__(self) -> str:
                        return f"BaseRepo({self.dsn})"
            ''',
        }

        graph_default = _build_temp_graph(files, include_private=False)
        nodes = {n["id"]: n for n in graph_default["nodes"]}

        # File expone `classes` con docstring, bases, is_abstract y rango de líneas sin duplicar en métodos.
        file_node = nodes["service.py"]
        self.assertIn("classes", file_node)
        cls = file_node["classes"]["BaseRepo"]
        self.assertEqual(cls["qualname"], "BaseRepo")
        self.assertEqual(cls["short_name"], "BaseRepo")
        self.assertEqual(cls["bases"], ["ABC", "Generic[T]"])
        self.assertTrue(cls["is_abstract"])
        self.assertIn("Repositorio base abstracto", cls["docstring"])
        self.assertGreater(cls["line"], 0)
        self.assertGreaterEqual(cls["end_line"], cls["line"])

        # `__init__` visible por defecto con `is_constructor=True` y `class_name="BaseRepo"`.
        self.assertIn("service.py::BaseRepo.__init__", nodes)
        init_node = nodes["service.py::BaseRepo.__init__"]
        self.assertEqual(init_node["class_name"], "BaseRepo")
        self.assertTrue(init_node["is_constructor"])
        self.assertNotIn("classes", init_node)

        # Método normal tiene `class_name` pero NO `is_constructor`.
        fetch_node = nodes["service.py::BaseRepo.fetch"]
        self.assertEqual(fetch_node["class_name"], "BaseRepo")
        self.assertNotIn("is_constructor", fetch_node)

        # `_load_raw` y `__repr__` siguen ocultos sin `--include-private`.
        self.assertNotIn("service.py::BaseRepo._load_raw", nodes)
        self.assertNotIn("service.py::BaseRepo.__repr__", nodes)

        # Con `--include-private`, `_load_raw` y `__repr__` sí aparecen.
        graph_priv = _build_temp_graph(files, include_private=True)
        priv_ids = {n["id"] for n in graph_priv["nodes"]}
        self.assertIn("service.py::BaseRepo._load_raw", priv_ids)
        self.assertIn("service.py::BaseRepo.__repr__", priv_ids)

        # Exportador IA conserva `classes`, `class_name`, `is_constructor` y resume la clase en Markdown.
        ai_graph = build_ai_graph(graph_default)
        ai_nodes = {n["id"]: n for n in ai_graph["nodes"]}
        self.assertIn("BaseRepo", ai_nodes["service.py"]["classes"])
        self.assertTrue(ai_nodes["service.py::BaseRepo.__init__"]["is_constructor"])
        self.assertEqual(ai_nodes["service.py::BaseRepo.fetch"]["class_name"], "BaseRepo")
        self.assertNotIn("is_constructor", ai_nodes["service.py::BaseRepo.fetch"])

        ai_md = build_ai_markdown(graph_default)
        self.assertIn("abstract class BaseRepo(ABC, Generic[T])", ai_md)
        self.assertIn("[clase]", ai_md)

    def test_js_and_ts_class_declarations_expressions_heritage_and_jsdoc_without_file_steal(self) -> None:
        files = {
            "errors.js": """
                /**
                 * Error de configuración estructurado.
                 */
                export class ConfigError extends Error {
                  constructor(message) {
                    super(message);
                  }
                }

                /**
                 * Caja dinámica declarada como expresión de clase.
                 */
                const DynamicBox = class extends ConfigError {
                  open() {
                    return true;
                  }
                };
            """,
            "store.ts": """
                /** @file Módulo principal de almacenamiento tipado. */

                /**
                 * Almacén reactivo abstracto con limpieza explícita.
                 */
                export abstract class BaseStore<T> extends EventTarget implements IStore<T>, Disposable {
                  constructor(initial: T) {
                    super();
                  }

                  save(item: T): void {
                    return;
                  }
                }
            """,
        }

        graph = _build_temp_graph(files, include_private=False)
        nodes = {n["id"]: n for n in graph["nodes"]}

        # En errors.js, el JSDoc pegado a `export class ConfigError` pertenece a la clase, NO al archivo.
        err_file = nodes["errors.js"]
        self.assertEqual(err_file["docstring"], "")
        self.assertIn("ConfigError", err_file["classes"])
        self.assertIn("DynamicBox", err_file["classes"])
        self.assertEqual(err_file["classes"]["ConfigError"]["bases"], ["Error"])
        self.assertIn("Error de configuración estructurado", err_file["classes"]["ConfigError"]["docstring"])
        self.assertEqual(err_file["classes"]["DynamicBox"]["bases"], ["ConfigError"])
        self.assertIn("Caja dinámica", err_file["classes"]["DynamicBox"]["docstring"])
        self.assertTrue(nodes["errors.js::ConfigError.constructor"]["is_constructor"])
        self.assertEqual(nodes["errors.js::DynamicBox.open"]["class_name"], "DynamicBox")

        # En store.ts, `@file` es del archivo y el JSDoc de la clase abstracta se preserva con extends + implements.
        ts_file = nodes["store.ts"]
        self.assertIn("Módulo principal de almacenamiento", ts_file["docstring"])
        ts_cls = ts_file["classes"]["BaseStore"]
        self.assertTrue(ts_cls["is_abstract"])
        self.assertEqual(ts_cls["bases"], ["EventTarget"])
        self.assertEqual(ts_cls["implements"], ["IStore<T>", "Disposable"])
        self.assertIn("Almacén reactivo abstracto", ts_cls["docstring"])
        self.assertTrue(nodes["store.ts::BaseStore.constructor"]["is_constructor"])
        self.assertEqual(nodes["store.ts::BaseStore.save"]["class_name"], "BaseStore")


class TestCycle6Phase4InspectorGridReleasePinnedAndFloatingControls(unittest.TestCase):
    def test_html_css_and_js_contracts_for_3x2_grid_resizer_wrap_and_zoom(self) -> None:
        html = (VIEWER_DIR / "index.html").read_text(encoding="utf-8")
        css = (VIEWER_DIR / "styles.css").read_text(encoding="utf-8")
        js = (VIEWER_DIR / "app.js").read_text(encoding="utf-8")

        # Cabecera con píldora contextual `btn-isolate-file` y contexto de clase.
        self.assertIn('class="details-header-top"', html)
        self.assertIn('id="btn-isolate-file"', html)
        self.assertIn('class="isolate-file-pill hidden"', html)
        self.assertIn('id="detail-class-context"', html)
        self.assertIn('id="detail-class-docstring-block"', html)
        self.assertIn('id="btn-release-pinned"', html)

        # Grilla estricta de 3 filas x 2 botones en `.details-actions` (6 elementos de acción, sin btn-isolate-file dentro).
        actions_start = html.index('<div class="details-actions">')
        actions_end = html.index("</div>", actions_start)
        actions_block = html[actions_start:actions_end]
        self.assertNotIn("btn-isolate-file", actions_block)
        for expected_id in (
            "btn-toggle-node",
            "btn-open-floating",
            "btn-pin-node",
            "btn-release-pinned",
            "btn-explore-nhops",
            "detail-vscode",
        ):
            self.assertIn(f'id="{expected_id}"', actions_block)

        # CSS: grilla 2 columnas, badges de clase, divisor `.fw-split-resizer`, wrap sin `min-width: max-content`, zoom var.
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr))", css)
        self.assertIn(".flow-badge-constructor", css)
        self.assertIn(".flow-badge-method", css)
        self.assertIn(".fw-split-resizer", css)
        self.assertIn(".fw-code-pane.wrap-enabled .fw-code-lines", css)
        self.assertIn("min-width: 0;", css)
        self.assertIn("--fw-code-font-size", css)

        # JS: funciones y sintaxis limpias.
        for fn_name in (
            "function formatClassDeclaration(",
            "function updateClassContext(",
            "function collectScopedPinnedNodeIds(",
            "function releaseScopedPinnedNodes(",
            "function applyFloatingSplitRatio(",
            "function bindFloatingSplitResizer(",
            "function loadFloatingCodePrefs(",
        ):
            self.assertIn(fn_name, js)

        check = subprocess.run(["node", "--check", str(VIEWER_DIR / "app.js")], capture_output=True, text=True, check=False)
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_selective_release_pinned_class_formatting_and_split_zoom_logic_in_node(self) -> None:
        script = (
            "const fs = require('fs');\n"
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
            "const state = { activeLevel: 3, expandedFunctions: new Set(), groupingMode: 'folders', layoutOrderMode: 'execution' };\n"
            "const storage = new Map();\n"
            "global.localStorage = {\n"
            "  getItem: (k) => (storage.has(k) ? storage.get(k) : null),\n"
            "  setItem: (k, v) => storage.set(k, String(v)),\n"
            "};\n"
            "var fwCodePrefs = { wrap: false, fontSize: 12, loaded: false };\n"
            "eval([\n"
            "  matchConst('LEGACY_PIN_FALLBACK_KEY'),\n"
            "  matchConst('FW_CODE_WRAP_STORAGE_KEY'),\n"
            "  matchConst('FW_CODE_FONT_SIZE_STORAGE_KEY'),\n"
            "  matchConst('FW_CODE_FONT_MIN'),\n"
            "  matchConst('FW_CODE_FONT_MAX'),\n"
            "  matchConst('FW_CODE_FONT_DEFAULT'),\n"
            "  matchConst('FW_SPLIT_MIN_PANE_PX'),\n"
            "  extractFn('getCurrentLayoutContextKey'),\n"
            "  extractFn('getPinnedPositionForContext'),\n"
            "  extractFn('formatClassDeclaration'),\n"
            "  extractFn('collectScopedPinnedNodeIds'),\n"
            "  extractFn('loadFloatingCodePrefs'),\n"
            "  extractFn('saveFloatingCodePrefs'),\n"
            "  extractFn('applyFloatingSplitRatio'),\n"
            "].join('\\n'));\n"
            "\n"
            "// 1. Formateo de declaraciones de clase Python y TS.\n"
            "const pyDecl = formatClassDeclaration({ qualname: 'ConfigError', bases: ['ValueError', 'Generic[T]'], is_abstract: false }, 'python');\n"
            "const tsDecl = formatClassDeclaration({ qualname: 'BaseStore', bases: ['EventTarget'], implements: ['IStore', 'Disposable'], is_abstract: true }, 'typescript');\n"
            "\n"
            "// 2. Liberar fijados estrictamente contextual (selección individual y multi-selección Shift/Ctrl).\n"
            "const cy = cytoscape({\n"
            "  headless: true,\n"
            "  elements: [\n"
            "    { data: { id: 'fileA', type: 'file' } },\n"
            "    { data: { id: 'fileA::fn1', parent: 'fileA', type: 'function' } },\n"
            "    { data: { id: 'fileA::fn2', parent: 'fileA', type: 'function' } },\n"
            "    { data: { id: 'fileB', type: 'file' } },\n"
            "    { data: { id: 'fileB::fn3', parent: 'fileB', type: 'function' } },\n"
            "    { data: { id: 'fileC::fn4', type: 'function' } },\n"
            "  ],\n"
            "});\n"
            "const nodesById = new Map([\n"
            "  ['fileA', { id: 'fileA', type: 'file' }],\n"
            "  ['fileA::fn1', { id: 'fileA::fn1', type: 'function', parent: 'fileA', internal_flow: [{ id: 'n1' }, { id: 'n2' }] }],\n"
            "  ['fileA::fn2', { id: 'fileA::fn2', type: 'function', parent: 'fileA', internal_flow: [] }],\n"
            "  ['fileB', { id: 'fileB', type: 'file' }],\n"
            "  ['fileB::fn3', { id: 'fileB::fn3', type: 'function', parent: 'fileB', internal_flow: [] }],\n"
            "  ['fileC::fn4', { id: 'fileC::fn4', type: 'function', internal_flow: [] }],\n"
            "]);\n"
            "const childrenByParent = new Map([\n"
            "  ['fileA', [{ id: 'fileA::fn1' }, { id: 'fileA::fn2' }]],\n"
            "  ['fileB', [{ id: 'fileB::fn3' }]],\n"
            "]);\n"
            "const notesNodes = {\n"
            "  'fileA': { pinned: true, pinned_positions: { functions: { x: 10, y: 20 } } },\n"
            "  'fileA::fn1': { pinned: true, pinned_positions: { functions: { x: 30, y: 40 }, creation_functions: { x: 99, y: 99 } } },\n"
            "  'fileA::fn1::n2': { pinned: true, pinned_positions: { functions: { x: 35, y: 45 } } },\n"
            "  'fileB::fn3': { pinned: true, pinned_positions: { functions: { x: 500, y: 600 } } },\n"
            "  'fileC::fn4': { pinned: true, pinned_positions: { functions: { x: 700, y: 800 } } },\n"
            "};\n"
            "\n"
            "// Caso A: Solo `fileA` seleccionado -> debe incluir fileA, fileA::fn1, fileA::fn1::n2, pero JAMÁS fileB::fn3 ni fileC::fn4.\n"
            "cy.getElementById('fileA').select();\n"
            "const scopedFileA = collectScopedPinnedNodeIds(cy, 'fileA', notesNodes, 'functions', nodesById, childrenByParent).sort();\n"
            "\n"
            "// Caso B: Multi-selección Shift/Ctrl (`fileA` + `fileC::fn4`) -> incluye ambos, sigue excluyendo `fileB::fn3`.\n"
            "cy.getElementById('fileC::fn4').select();\n"
            "const scopedMulti = collectScopedPinnedNodeIds(cy, 'fileA', notesNodes, 'functions', nodesById, childrenByParent).sort();\n"
            "\n"
            "// 3. Clamping de splitRatio (mínimo 180px por panel en ancho de 706px -> 700px disponibles).\n"
            "const fakeWin = {\n"
            "  destroyed: false,\n"
            "  viewMode: 'split',\n"
            "  splitRatio: 0.05,\n"
            "  bodyEl: { clientWidth: 706 },\n"
            "  splitResizerEl: { offsetWidth: 6 },\n"
            "  cyContainer: { style: {} },\n"
            "  codePaneEl: { style: {} },\n"
            "};\n"
            "applyFloatingSplitRatio(fakeWin);\n"
            "const clampedLowLeftPx = parseInt(fakeWin.cyContainer.style.width, 10);\n"
            "fakeWin.splitRatio = 0.95;\n"
            "applyFloatingSplitRatio(fakeWin);\n"
            "const clampedHighLeftPx = parseInt(fakeWin.cyContainer.style.width, 10);\n"
            "\n"
            "// 4. Persistencia de wrap y zoom acotado en localStorage.\n"
            "storage.set(FW_CODE_WRAP_STORAGE_KEY, 'true');\n"
            "storage.set(FW_CODE_FONT_SIZE_STORAGE_KEY, '99');\n"
            "fwCodePrefs.loaded = false;\n"
            "const prefs = loadFloatingCodePrefs();\n"
            "cy.destroy();\n"
            "\n"
            "console.log(JSON.stringify({ pyDecl, tsDecl, scopedFileA, scopedMulti, clampedLowLeftPx, clampedHighLeftPx, prefs }));\n"
        )

        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        res = json.loads(proc.stdout)

        self.assertEqual(res["pyDecl"], "class ConfigError(ValueError, Generic[T])")
        self.assertEqual(res["tsDecl"], "abstract class BaseStore extends EventTarget implements IStore, Disposable")
        self.assertEqual(res["scopedFileA"], ["fileA", "fileA::fn1", "fileA::fn1::n2"])
        self.assertEqual(res["scopedMulti"], ["fileA", "fileA::fn1", "fileA::fn1::n2", "fileC::fn4"])
        self.assertEqual(res["clampedLowLeftPx"], 180)
        self.assertEqual(res["clampedHighLeftPx"], 520)  # 700 - 180
        self.assertTrue(res["prefs"]["wrap"])
        self.assertEqual(res["prefs"]["fontSize"], 22)


if __name__ == "__main__":
    unittest.main()
