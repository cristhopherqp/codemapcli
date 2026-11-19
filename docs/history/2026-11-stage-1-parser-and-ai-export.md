# Etapa 1 — Precisión del Parser/Grafo y Exportación Compacta para IA

**Fecha:** 2026-11-19  
**Estado:** ✅ Completada y validada (20/20 pruebas unitarias OK, `node --check codemap/viewer/app.js` OK)

---

## 1. Critical Fixes en `graph.json` (Parser & Graph Builder)

- **Truncamiento de `flow_label()` (`codemap/parsers/common.py`, `js_parser.py`, `python_parser.py`):**
  - Se añadió `FLOW_LABEL_MAX_CHARS = 120` y truncamiento con `…` en `flow_label()`, manteniendo el texto completo únicamente en `step.code`.
  - `header_text()` en ambos parsers limpia `{` / `:` antes de truncar para evitar cortes sucios en cabeceras largas.
- **Eliminación de falsos `is_event_handler: true` en helpers internos (`codemap/graph_builder.py`):**
  - Se dividió la clasificación de llamadas internas en `_classify_entries()` en **dos pasadas** (`direct_caller_targets` primero; evaluación de `EDGE_EVENT_LISTENER` después).
  - Helpers locales anidados (`fn.container is not None`) o funciones ya invocadas directamente (`EDGE_DIRECT_CALL`) —como `syncDOM` en `bindCompositeFilterControl` o `setDropHighlight` en `setupDropZone`— dejan de recibir `entry_kind: "event_handler"` y de contaminar `execution_flows`, preservando la detección de handlers reales (incluidos wrappers inline como `() => triggerPrint()`).
- **Clasificación Canvas 2D vs `Array.prototype` (`codemap/graph_builder.py`):**
  - Se añadieron `CANVAS_2D_RECEIVERS`, `CANVAS_2D_METHODS`, `HTML_CANVAS_METHODS` y los detectores `_is_canvas_context_receiver()` / `_is_canvas_element_receiver()` en `classify_js_external()`.
  - `ctx.fill()`, `ctx.beginPath()`, `canvas.getContext()`, `canvas.toDataURL()`, etc. se clasifican bajo `Canvas 2D` (`CanvasRenderingContext2D.*` / `HTMLCanvasElement.*`) en lugar de `js:Array.prototype.fill`, manteniendo intacta la clasificación de arreglos genuinos (`items.fill(0)`).
- **Eliminación de falsos `[sin ref]` (`unreferenced`) en callbacks de arranque top-level (`codemap/roles.py`, `codemap/parsers/js_parser.py`, `codemap/graph_builder.py`):**
  - Se añadió `is_startup_hook_call()` (`.listen`) en `roles.py` para clasificar callbacks como `server.listen(PORT, () => ...)` con `ENTRY_KIND_MAIN`, y soporte para `is_reactive_registrar()` en `collect_module_callbacks()` (`ENTRY_KIND_EVENT`).
  - `_classify_entries()` registra `module_callback_ids` (`fn.callback_via != ""`) para impedir que ningún callback sintetizado de nivel de módulo quede marcado como `unreferenced`.

---

## 2. Contexto en Callbacks Anónimos y Listeners (`⚡`) en Nivel 3+

- **Argumentos contextuales y paso disparador `⚡ Hook:` (`codemap/parsers/js_parser.py`, `codemap/parsers/python_parser.py`):**
  - `callback_name()` incorpora argumentos cortos no-función cuando no hay un string literal inicial (ej. `server.listen(PORT)@L94`, conservando `app.get[/users/:id]@L6` para rutas/eventos string).
  - `build_flow()` antepone un paso inicial `⚡ Hook: server.listen(PORT, <callback>)` (`role: "entry"`, `kind: "event"`) conectado a `in: <params>` para callbacks sintetizados (`is_callback=True`).
  - `compute_fingerprint()` permanece intacto; las notas existentes bajo IDs previos migran automáticamente vía `reconcile_notes()`.
- **Diferenciación `⚡` (eventos/suscripciones) vs `🔁` (bucles/iteradores) en Nivel 3+ (`codemap/models.py`, `js_parser.py`, `python_parser.py`, `viewer/`):**
  - Se extendió `FlowStep.kind` con `"event"`.
  - `_extract_dom_or_receiver_target()` en `js_parser.py` recupera selectores DOM de llamadas encadenadas (`document.getElementById('viewGalleryBtn')?.addEventListener('click', ...)` → `⚡ click · #viewGalleryBtn`; `querySelector('.filter-input')` → `⚡ change · .filter-input(ev)`).
  - Tanto `emit_callback_steps()` (JS) como `emit_lambda_steps()` (Python) usan `classify_callback_container()` para emitir `⚡` + `kind="event"` en listeners/suscripciones/hooks `.listen`, reservando `🔁` + `kind="loop"` para iteradores (`.map`, `.forEach`, `sorted`, bucles).
  - En el visor web (`app.js`, `styles.css`, `index.html`): estilos diferenciados en Cytoscape para `flowKind="event"`, etiqueta `DISPARADOR` / `.kind-event` en el Inspector y entrada `⚡ Evento / Listener` en la leyenda.

---

## 3. Exportación Compacta para IA (`codemap export` + Servidor + Visor)

- **Módulo dedicado `codemap/exporter.py`:**
  - `build_ai_graph()` y `serialize_ai_graph()`: JSON minificado (`separators=(",", ":")`), sin `internal_flow` por defecto (opcional con `--include-flow`), podando `file_path`, `fingerprint`, `docs_url`, `code == label` y claves neutras (`None`, `""`, `False`, `[]`).
  - `build_ai_markdown()`: resumen Markdown estructurado con métricas, puntos de entrada, diagrama Mermaid (`flowchart LR` por archivos o módulos si supera 25 archivos), hilos de ejecución y mapa de firmas/docstrings por archivo.
- **CLI y almacenamiento (`codemap/cli.py`, `codemap/storage.py`):**
  - Nuevo subcomando `codemap export <target> [--format json|md] [--include-flow] [--include-private] [--out <ruta>] [--stdout]`.
  - Sin `--out` ni `--stdout`, escribe en `~/.codemap/<hash>/graph.ai.<ext>` preservando cero intrusión; en `--stdout` fuerza codificación UTF-8 segura en Windows.
- **Integración Visor Web sin duplicación (`codemap/server.py`, `index.html`, `styles.css`, `app.js`):**
  - Nuevos endpoints `GET /export.ai.json` y `GET /export.ai.md` (`?include_flow=0|1`) con cabecera `X-CodeMap-Raw-Bytes`.
  - Modal `#export-modal` ampliado con casilla *"Incluir flujo interno (3+)"* y botones **"Exportar JSON para IA"**, **"Copiar Markdown"** (con fallback de portapapeles) y descarga `.md`.

---

## 4. Validación

- Nuevas pruebas en `tests/test_stage1.py` (8 casos de prueba cubriendo fixes 1–4, callbacks/listeners JS+Python, migración por fingerprint, serialización JSON/Markdown, CLI por subproceso usando `sys.executable` y endpoints `aiohttp`).
- Resultados:
  - `.venv\Scripts\python.exe -m unittest discover -s tests -v`: **20/20 OK**.
  - `node --check codemap/viewer/app.js`: **exit 0**.
  - `codemap export examples/multi --format json`: **11,215 B vs 50,452 B (-77.8%)**; sobre `codemap/`: **-87.5% en JSON IA** y **-96.1% en Markdown IA**.
