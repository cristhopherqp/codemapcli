"""Pruebas del Ciclo 9 (Fases 9.1 y 9.2): Fichas Vivas de Vocabulario Técnico y Notas por Línea."""

from __future__ import annotations

import json
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

from codemap.discovery import discover_files
from codemap.exporter import build_ai_graph
from codemap.graph_builder import build_graph
from codemap.notes_storage import load_notes, reconcile_notes, update_notes
from codemap.parsers import parse_file
from codemap.paths import normalize_path
from codemap.server import create_app
from codemap.vocab import load_vocab_dictionary

REPO_ROOT = Path(__file__).resolve().parent.parent
VIEWER_DIR = REPO_ROOT / "codemap" / "viewer"
VOCAB_JS = VIEWER_DIR / "vocab.js"
WALKTHROUGH_JS = VIEWER_DIR / "walkthrough.js"
APP_JS = VIEWER_DIR / "app.js"
INDEX_HTML = VIEWER_DIR / "index.html"
PYPROJECT_TOML = REPO_ROOT / "pyproject.toml"


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


class TestCycle9DictionaryAndPackaging(unittest.TestCase):
    def test_pyproject_includes_json_package_data(self) -> None:
        text = PYPROJECT_TOML.read_text(encoding="utf-8")
        self.assertIn("[tool.setuptools.package-data]", text)
        self.assertIn('"*.json"', text)

    def test_vocab_dictionary_schema_and_coverage(self) -> None:
        data = load_vocab_dictionary()
        self.assertEqual(data.get("version"), 1)
        entries = data.get("entries", {})
        self.assertIsInstance(entries, dict)
        self.assertGreaterEqual(len(entries), 70)

        categories = set()
        for key, entry in entries.items():
            self.assertEqual(entry.get("id"), key)
            for req_field in ("symbol", "title", "category", "input", "transform", "output"):
                self.assertTrue(
                    isinstance(entry.get(req_field), str) and entry[req_field].strip(),
                    f"Falta campo '{req_field}' en {key}",
                )
            docs_url = entry.get("docs_url", "")
            if docs_url:
                self.assertTrue(
                    docs_url.startswith(("https://", "http://")),
                    f"URL insegura en {key}: {docs_url}",
                )
            categories.add(entry["category"])

        self.assertTrue({"syntax", "method", "posix", "control"}.issubset(categories))
        for must_have in (
            "syntax:js:optional_chaining",
            "syntax:js:nullish_coalescing",
            "syntax:py:list_comp",
            "syntax:py:walrus",
            "js:Array.prototype.map",
            "py:dict.get",
            "py:builtins.enumerate",
            "posix:ENOENT",
            "ctrl:nul",
            "ctrl:crlf",
        ):
            self.assertIn(must_have, entries)


class TestCycle9AstVocabExtraction(unittest.TestCase):
    def test_python_vocab_extraction_and_zero_false_positives_in_comments_or_nested(self) -> None:
        files = {
            "sample.py": '''
                import errno

                def my_dec(fn):
                    return fn

                @my_dec
                async def process(items, **opts):
                    # ENOENT := lambda [x for x in y] "\\0" "\\r\\n"
                    plain = "hello world without escapes"
                    squares = [x * x for x in items]
                    mapping = {k: v for k, v in opts.items()}
                    head = squares[:2]
                    if (n := len(head)) > 0:
                        msg = f"count={n}"
                    label = "ok" if n else "empty"
                    fn_cb = lambda z: z + 1
                    with open("a.txt") as fh:
                        try:
                            raw = "line\\r\\n"
                            nul = "\\0"
                            code = errno.ENOENT
                            await helper(*head, **mapping)
                        except OSError:
                            pass
                    def inner():
                        # Comprensión solo dentro de función anidada
                        return {i for i in range(3)}
                    return msg, label, fn_cb, raw, nul, code

                async def helper(*args, **kwargs):
                    yield 1
            ''',
        }
        graph = _build_temp_graph(files)
        proc = _node_by_id(graph, "sample.py::process")
        vmap = proc.get("vocab_by_line", {})
        self.assertIsInstance(vmap, dict)

        # Ninguna detección en línea del comentario (# ENOENT := lambda ...) ni en la cadena plana.
        all_ids = {vid for vids in vmap.values() for vid in vids}
        self.assertNotIn("syntax:py:set_comp", all_ids)  # Pertenece a `inner`, no debe contaminar `process`.

        # Verificar que la línea del comentario no produjo nada.
        comment_line = next(
            idx for idx, line in enumerate(textwrap.dedent(files["sample.py"]).lstrip("\n").splitlines(), start=1)
            if "# ENOENT :=" in line
        )
        plain_line = next(
            idx for idx, line in enumerate(textwrap.dedent(files["sample.py"]).lstrip("\n").splitlines(), start=1)
            if "hello world without escapes" in line
        )
        self.assertNotIn(str(comment_line), vmap)
        self.assertNotIn(str(plain_line), vmap)

        expected_ids = {
            "syntax:py:decorator",
            "syntax:py:async_await",
            "syntax:py:list_comp",
            "syntax:py:dict_comp",
            "syntax:py:slicing",
            "syntax:py:walrus",
            "syntax:py:fstring",
            "syntax:py:ternary",
            "syntax:py:lambda",
            "syntax:py:with_context",
            "syntax:py:try_except",
            "syntax:py:unpack_args",
            "syntax:py:unpack_kwargs",
            "posix:ENOENT",
            "ctrl:crlf",
            "ctrl:nul",
        }
        for vid in expected_ids:
            self.assertIn(vid, all_ids, f"Faltó detectar {vid} en Python; detectados={sorted(all_ids)}")

        helper = _node_by_id(graph, "sample.py::helper")
        helper_ids = {vid for vids in helper.get("vocab_by_line", {}).values() for vid in vids}
        self.assertIn("syntax:py:yield", helper_ids)
        self.assertIn("syntax:py:async_await", helper_ids)

        # El exportador compacto IA poda `vocab_by_line`.
        ai_graph = build_ai_graph(graph)
        ai_proc = _node_by_id(ai_graph, "sample.py::process")
        self.assertNotIn("vocab_by_line", ai_proc)

    def test_js_ts_vocab_extraction_and_zero_false_positives_in_comments(self) -> None:
        files = {
            "client.ts": '''
                export async function fetchData(cfg: any, ...rest: string[]) {
                  // ?. ?? ??= ... ENOENT \\0 \\n
                  const { host, port } = cfg;
                  const [first] = rest;
                  const url = cfg?.endpoint ?? "https://example.com";
                  let retries: number | undefined;
                  retries ??= 3;
                  const copy = [...rest];
                  const msg = `host=${host}:${port}`;
                  const tag = first ? "yes" : "no";
                  const mapper = (x: string) => x.trim();
                  const forced = (host as string);
                  for (const item of copy) {
                    if (item === "ECONNREFUSED") {
                      await Promise.resolve(item + "\\n");
                    }
                  }
                  return { url, retries, msg, tag, mapper, forced };
                }
            ''',
        }
        graph = _build_temp_graph(files)
        fn = _node_by_id(graph, "client.ts::fetchData")
        vmap = fn.get("vocab_by_line", {})
        all_ids = {vid for vids in vmap.values() for vid in vids}

        comment_line = next(
            idx for idx, line in enumerate(textwrap.dedent(files["client.ts"]).lstrip("\n").splitlines(), start=1)
            if "// ?. ??" in line
        )
        self.assertNotIn(str(comment_line), vmap)

        expected_ids = {
            "syntax:js:async_await",
            "syntax:js:rest_params",
            "syntax:js:object_destructuring",
            "syntax:js:array_destructuring",
            "syntax:js:optional_chaining",
            "syntax:js:nullish_coalescing",
            "syntax:js:nullish_assign",
            "syntax:js:spread",
            "syntax:js:template_literal",
            "syntax:js:ternary",
            "syntax:js:arrow_function",
            "syntax:js:type_assertion",
            "syntax:js:for_of",
            "posix:ECONNREFUSED",
            "ctrl:lf",
        }
        for vid in expected_ids:
            self.assertIn(vid, all_ids, f"Faltó detectar {vid} en TS; detectados={sorted(all_ids)}")


class TestCycle9LineNotesAndServerApi(unittest.IsolatedAsyncioTestCase):
    def test_line_notes_persistence_reconcile_and_legacy_compatibility(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake_home = Path(tmp) / "home"
            fake_home.mkdir()
            project = Path(tmp) / "proj"
            project.mkdir()
            (project / "app.py").write_text("def run():\n    return 1\n", encoding="utf-8")

            with patch("codemap.paths.Path.home", return_value=fake_home):
                target = normalize_path(project)
                initial = load_notes(target)
                self.assertEqual(initial.get("line_notes"), {})

                graph = {
                    "nodes": [
                        {"id": "app.py", "type": "file"},
                        {"id": "app.py::run", "type": "function", "parent": "app.py"},
                    ],
                    "edges": [],
                }
                updated = update_notes(
                    target,
                    {
                        "line_notes": {
                            "app.py::2": {
                                "file_id": "app.py",
                                "line": 2,
                                "note": "Retorna 1 como valor centinela",
                                "line_hash": "deadbeef",
                            },
                            "deleted.py::5": {
                                "file_id": "deleted.py",
                                "line": 5,
                                "note": "Archivo que dejará de existir",
                                "line_hash": "12345678",
                            },
                        }
                    },
                    graph,
                )
                self.assertIn("app.py::2", updated["line_notes"])
                self.assertIn("deleted.py::5", updated["line_notes"])

                # Conciliar contra el grafo vigente: conserva `app.py::2` y poda `deleted.py::5`.
                reconciled = reconcile_notes(target, graph)
                self.assertIn("app.py::2", reconciled["line_notes"])
                self.assertEqual(
                    reconciled["line_notes"]["app.py::2"]["note"],
                    "Retorna 1 como valor centinela",
                )
                self.assertNotIn("deleted.py::5", reconciled["line_notes"])

                # Eliminar la nota con `null`.
                after_del = update_notes(target, {"line_notes": {"app.py::2": None}}, graph)
                self.assertEqual(after_del["line_notes"], {})

    async def test_server_vocab_dictionary_line_notes_and_known_vocab(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake_home = Path(tmp) / "home"
            fake_home.mkdir()
            project = Path(tmp) / "proj"
            project.mkdir()
            (project / "mod.py").write_text(
                "def compute(xs):\n    return [x * 2 for x in xs]\n",
                encoding="utf-8",
            )
            analyses = [a for p in discover_files(project) if (a := parse_file(p)) is not None]
            target = normalize_path(project)
            graph = build_graph(
                analyses,
                target_path=target,
                root_dir=target,
                is_single_file=False,
                include_private=False,
            )

            with patch("codemap.paths.Path.home", return_value=fake_home):
                app = create_app(target, graph)
                async with TestClient(TestServer(app)) as client:
                    # 1. GET /vocab-dictionary
                    res_dict = await client.get("/vocab-dictionary")
                    self.assertEqual(res_dict.status, 200)
                    payload = await res_dict.json()
                    self.assertIn("syntax:py:list_comp", payload.get("entries", {}))

                    # 2. POST /notes.json con `line_notes`
                    res_note = await client.post(
                        "/notes.json",
                        json={
                            "line_notes": {
                                "mod.py::2": {
                                    "file_id": "mod.py",
                                    "line": 2,
                                    "note": "Duplica cada elemento",
                                    "line_hash": "abcd1234",
                                }
                            }
                        },
                    )
                    self.assertEqual(res_note.status, 200)
                    notes_data = await res_note.json()
                    self.assertEqual(
                        notes_data["line_notes"]["mod.py::2"]["note"],
                        "Duplica cada elemento",
                    )

                    # 3. POST /known-apis marcando y desmarcando concepto de sintaxis
                    res_mark = await client.post(
                        "/known-apis",
                        json={
                            "action": "mark",
                            "api": {
                                "api_id": "syntax:py:list_comp",
                                "symbol": "[x for x in ...]",
                                "module": "Sintaxis",
                                "kind": "syntax",
                                "docs_url": "https://docs.python.org/3/tutorial/datastructures.html#list-comprehensions",
                            },
                        },
                    )
                    self.assertEqual(res_mark.status, 200)
                    known_data = await res_mark.json()
                    self.assertIn("syntax:py:list_comp", known_data["known"])
                    self.assertEqual(known_data["known"]["syntax:py:list_comp"]["kind"], "syntax")

                    res_unmark = await client.post(
                        "/known-apis",
                        json={"action": "unmark", "api_id": "syntax:py:list_comp"},
                    )
                    self.assertEqual(res_unmark.status, 200)
                    known_after = await res_unmark.json()
                    self.assertNotIn("syntax:py:list_comp", known_after["known"])

                    # El directorio del proyecto analizado sigue 100 % limpio (cero intrusión).
                    self.assertEqual(sorted(p.name for p in project.iterdir()), ["mod.py"])


class TestCycle9FrontendVocabAndSecurity(unittest.TestCase):
    def test_vocab_js_has_zero_innerhtml_and_html_wiring_present(self) -> None:
        vocab_src = VOCAB_JS.read_text(encoding="utf-8")
        self.assertNotIn("innerHTML", vocab_src)
        self.assertNotIn("outerHTML", vocab_src)
        self.assertNotIn("insertAdjacentHTML", vocab_src)

        html = INDEX_HTML.read_text(encoding="utf-8")
        self.assertIn('<script src="./vocab.js"></script>', html)
        self.assertIn('id="wt-vocab-dock"', html)
        self.assertIn('id="filter-apis-all"', html)
        self.assertIn('id="filter-apis-only"', html)
        self.assertIn('id="filter-apis-vocab"', html)

    def test_js_syntax_check_all_viewer_scripts(self) -> None:
        for script_path in (VOCAB_JS, WALKTHROUGH_JS, APP_JS):
            proc = subprocess.run(
                ["node", "--check", str(script_path)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, f"node --check falló en {script_path}: {proc.stderr}")

    def test_vocab_js_filtering_enrichment_and_url_security(self) -> None:
        vocab_dict_path = REPO_ROOT / "codemap" / "vocab_dictionary.json"
        script = (
            f"const vocab = require({json.dumps(str(VOCAB_JS))});\n"
            f"const dict = require({json.dumps(str(vocab_dict_path))});\n"
            """
const fnNode = {
  id: "demo.py::run",
  type: "function",
  parent: "demo.py",
  vocab_by_line: {
    "10": ["syntax:py:list_comp", "posix:ENOENT"],
    "12": ["ctrl:nul"],
  },
  external_calls: [
    { api_id: "py:dict.get", symbol: "dict.get", module: "builtins", kind: "method", line: 10 },
    { api_id: "pkg:custom.op", symbol: "custom.op", module: "custom", kind: "package", line: 10 },
  ],
};

// Sin aprendidos: deben aparecer list_comp, ENOENT, dict.get (enriquecido con contrato) y custom.op.
const allPending = vocab.collectLineVocabItems(fnNode, 10, 10, dict, { known: {} });
const ids = allPending.map((x) => x.id);
if (!ids.includes("syntax:py:list_comp")) throw new Error("Falta list_comp");
if (!ids.includes("posix:ENOENT")) throw new Error("Falta ENOENT");
if (!ids.includes("py:dict.get")) throw new Error("Falta py:dict.get");
if (!ids.includes("pkg:custom.op")) throw new Error("Falta pkg:custom.op");

const dictGet = allPending.find((x) => x.id === "py:dict.get");
if (!dictGet.input || !dictGet.output) throw new Error("py:dict.get no fue enriquecido desde vocab_dictionary");

// Al marcar list_comp y py:dict.get como aprendidos, desaparecen del glosario progresivo.
const afterKnown = vocab.collectLineVocabItems(fnNode, 10, 10, dict, {
  known: {
    "syntax:py:list_comp": { api_id: "syntax:py:list_comp" },
    "py:dict.get": { api_id: "py:dict.get" },
  },
});
const remainingIds = afterKnown.map((x) => x.id);
if (remainingIds.includes("syntax:py:list_comp") || remainingIds.includes("py:dict.get")) {
  throw new Error("Conceptos ya aprendidos no fueron filtrados: " + JSON.stringify(remainingIds));
}
if (!remainingIds.includes("posix:ENOENT") || !remainingIds.includes("pkg:custom.op")) {
  throw new Error("Se perdieron conceptos pendientes");
}

// Clasificación de categorías y seguridad de URLs.
if (!vocab.isVocabConcept("syntax:py:list_comp", "syntax")) throw new Error("syntax debe ser vocab");
if (!vocab.isVocabConcept("posix:ENOENT", "posix")) throw new Error("posix debe ser vocab");
if (!vocab.isVocabConcept("ctrl:nul", "control")) throw new Error("ctrl debe ser vocab");
if (vocab.isVocabConcept("py:dict.get", "method")) throw new Error("method no debe ser vocab-only");

if (!vocab.isSafeHttpUrl("https://docs.python.org/3/")) throw new Error("https debe ser válido");
if (vocab.isSafeHttpUrl("javascript:alert(1)")) throw new Error("javascript: debe rechazarse");
if (vocab.isSafeHttpUrl("data:text/html,<h1>x</h1>")) throw new Error("data: debe rechazarse");

// Agregación a nivel de proyecto y hash de línea determinista.
const projMap = vocab.collectProjectVocabItems({ nodes: [fnNode] }, dict);
if (projMap.size !== 3) throw new Error("Esperados 3 conceptos en proyecto, obtenidos " + projMap.size);
const h1 = vocab.computeLineHash("  return [x for x in xs]  ");
const h2 = vocab.computeLineHash("return [x for x in xs]");
if (h1 !== h2 || h1.length !== 8) throw new Error("Hash de línea inválido: " + h1);

// Helpers de line_notes.
const notes = { line_notes: { "demo.py::10": { file_id: "demo.py", line: 10, note: "Clave aquí" } } };
const found = vocab.getLineNote(notes, "demo.py", 10);
if (!found || found.note !== "Clave aquí") throw new Error("getLineNote falló");
if (vocab.getLineNote(notes, "demo.py", 11) !== null) throw new Error("getLineNote debe devolver null");

console.log("VOCAB_OK");
"""
        )
        proc = subprocess.run(
            ["node", "-e", script],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, f"Node vocab test falló:\nSTDOUT:{proc.stdout}\nSTDERR:{proc.stderr}")
        self.assertIn("VOCAB_OK", proc.stdout)


if __name__ == "__main__":
    unittest.main()
