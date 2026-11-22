# Ciclo 3 — Ergonomía del Visor, Inspección de Archivos, Orden de Creación y Endurecimiento de Seguridad

**Fecha:** 2026-11-22  
**Estado:** ✅ Completado y validado (48/48 pruebas unitarias OK, `node --check` OK y verificación interactiva en navegador con 0 errores de consola en Fases 2 y 3)

---

## Fase 1 — Seguridad, Fiabilidad Backend y Extracción de Docstrings de Archivo

- **Endurecimiento del servidor local (`codemap/server.py`):**
  - Middleware `local_origin_middleware` que valida `Host` y `Origin` tanto en peticiones HTTP como en el upgrade `/ws`, aceptando únicamente `127.0.0.1`, `localhost` y `[::1]` en el puerto asignado al servidor (`403` ante hosts/orígenes externos, `null` o puertos incorrectos).
  - Lock asíncrono `APP_NOTES_LOCK`, ejecución de escrituras en hilo (`asyncio.to_thread`), broadcast `notes_updated` a todas las pestañas WebSocket tras `POST /notes.json` y mensajes `save_notes`, y captura controlada de errores en `rebuild_and_broadcast()`.
- **Escrituras atómicas y sanitización (`codemap/paths.py`, `storage.py`, `notes_storage.py`, `known_apis_storage.py`, `watcher.py`):**
  - `atomic_write_text()` con archivo temporal en el mismo directorio, `fsync` y reemplazo atómico `os.replace`.
  - `_finite_float()` en `notes_storage.py` (rechaza `bool`, `NaN` e `Infinity`), lock reentrante `_NOTES_LOCK` y soporte en `VALID_LAYOUT_LEVELS` para claves independientes `creation_*` y `creation_layers_*`.
  - `sanitize_docs_url()` en `known_apis_storage.py` restringido a `http://` y `https://` con `netloc` válido + `_KNOWN_APIS_LOCK`.
  - Validación estricta SHA-256 hex y confinamiento de directorios en `clean_orphan_projects()` (`storage.py`) contra *path traversal*.
  - Retención fuerte de tareas `asyncio` con `_on_rebuild_done()` en `DebouncedRebuildHandler` (`watcher.py`).
- **Extracción de docstrings de archivo (`models.py`, `python_parser.py`, `js_parser.py`, `graph_builder.py`, `exporter.py`):**
  - Nuevo campo `FileAnalysis.docstring`.
  - `extract_module_docstring()` en Python (omite shebang/comentarios previos, normaliza `\r\n` y limpia sangría con `inspect.cleandoc()`).
  - `extract_file_docstring()` en JS/TS/JSX/TSX (extrae JSDoc `/** ... */` y cabeceras `/* ... */`, ignora shebang y pragmas linter, y evita robar o duplicar el JSDoc pegado a la primera función/clase).
  - Expuesto en `build_file_nodes()`, preservado en `build_ai_graph()` y renderizado en `build_ai_markdown()`.

---

## Fase 2 — Ergonomía del Visor, Paneo Global, Tooltip 1 s, Inspector de Archivo y Leyenda

- **Limpieza residual UI (Ítem 6):** Eliminadas referencias huérfanas de `#btn-topbar-inspector` en `app.js` y reglas muertas `.toolbar-right` / `.inspector-toggle-btn` en `styles.css`.
- **Leyenda en barra lateral (Ítem 7):** `#btn-toggle-legend` trasladado a `.sidebar-footer` en `#left-sidebar` (`🗺️` colapsado / `🗺️ Leyenda` expandido). `toggleLegend()` oculta por completo `#graph-legend` cuando está colapsada sin destruir los `<span>` internos y preserva intacto el contenido al desplegarse.
- **Paneo global y en ventanas flotantes (Ítem 1):** `attachPanControls()` reutilizable con `detach()` aplicado a `#cy` y a cada `win.cy` (`win.panCleanup` en `closeFloatingWindow()`). Habilita **Clic derecho** (`button === 2` suprimiendo `contextmenu` en el lienzo), **Clic central** (`button === 1`) y **`Espacio` + Clic izquierdo** (`button === 0`). `setSpacePanMode()` se propaga a todas las ventanas flotantes y `subCy.on("tap", "node")` respeta `state.suppressNextTap`.
- **Tooltip `#node-tooltip` tras `1000 ms` (Ítem 2 — Frontend):** Implementado `bindNodeDocstringTooltip()` en `#cy` y ventanas flotantes para `function` y `file` con docstring, con cancelación inmediata al salir del nodo/lienzo, hacer clic, arrastrar, hacer zoom/pan o pasar por una arista.
- **Inspector de Archivo + seguridad URL cliente (Ítem 3 + Auditoría):** Al seleccionar `type === "file"`, `#details-content.node-type-file` renderiza en orden vertical estricto:
  1. `Docstring "<nombre>"` (`#detail-docstring-block`).
  2. Recuadro `#detail-file-functions-block` con lista numerada secuencial (`1. ...`, `2. ...`) ordenada por `line` ascendente y clicable (`navigateToNode()`).
  3. Nota Personal (`#detail-note-block` / `#detail-note-input`) debajo.
  - Añadidos `isSafeHttpUrl()` para `docsLink.href` y `encodeFileUriPath()` en `buildVsCodeHref()`.

---

## Fase 3 — Alto Contraste en Modo Foco (`T`), Orden `↑ Creación` con Escalonamiento y Cierre

- **Resaltado de alto contraste en Modo Foco (`T`) (Ítem 4):**
  - `edge.trace-caller` / `edge.trace-callee` limitan el cambio de color (cian/ámbar) a `direct_call` para preservar intactos los colores semánticos de `event_listener`, `callback_ref`, `reactive_*` y puentes HTML.
  - `edge.trace-branch-active` aplica halo exterior nativo (`underlay-color: "#f8fafc"`, `underlay-opacity: 0.42`, `underlay-padding: 5`, `width: 4`, `arrow-scale: 1.3`, `z-index: 40`) sin sobrescribir el color de la flecha, acompañado de borde y halo complementario en `node.trace-branch-active`.
- **Ordenación por orden de creación (`↓ Ejecución` / `↑ Creación`) (Ítem 5):**
  - Expuesto `line: rawNode.line || 0` en `buildVisibleElements()`, `buildLayerModeElements()` y `buildFloatingSubgraph()`.
  - Activado `"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES"` en `ELK_LAYOUT_OPTIONS` y ordenación de `children`/`rootChildren` por `line` ascendente en `buildElkInput()` (preservando el orden AST de pasos `type === "flow"`).
  - Botón toggle compacto `#btn-layout-order` (`Orden: ↓ Ejecución` / `Orden: ↑ Creación`) que alterna `elk.direction` (`DOWN` / `UP`), actualiza `taxi-direction` (`downward` / `upward` + regla `edge[taxiDir = "upward"]`) y aísla pines en `creation_*` / `creation_layers_*`.
  - `applyCreationRowStagger()` aplica escalonamiento vertical progresivo (`+14px` por índice de `line` ascendente) entre funciones hermanas no fijadas de la misma fila/capa dentro de cada contenedor, propaga hacia abajo la altura adicional para impedir solapamientos entre capas y desactiva `elk-routed` en aristas conectadas a nodos desplazados para usar enrutamiento `taxi` dinámico limpio.
- **Documentación y cierre:** Actualizados `#help-modal`, `README.md` y `BACKLOG.md`.

---

## Validación Final

- Nuevas suites: `tests/test_cycle3_phase1.py` (10 casos), `tests/test_cycle3_phase2.py` (5 casos) y `tests/test_cycle3_phase3.py` (3 casos, incluyendo ejecución headless real en `cytoscape.min.js` y `elk.bundled.js`).
- `.venv\Scripts\python.exe -m unittest discover -s tests -v`: **48/48 pruebas OK**.
- `node --check codemap/viewer/app.js`: **exit 0**.
- Verificación interactiva en navegador sobre `examples/multi` con **0 errores de consola** confirmando: paneo con clic derecho y `Espacio` (grafo + ventana flotante), tooltip 1 s, Inspector de archivo (`Docstring "users.py"` → lista numerada → nota), Leyenda en sidebar, alternancia `↓ Ejecución` / `↑ Creación` (con escalera `+14px` y Capas de Flujo) y halo de alto contraste en Modo Foco (`T`).
