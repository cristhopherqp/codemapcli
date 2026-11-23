# Ciclo 4 — Enrutamiento Ortogonal en ↑ Creación, Apertura por Clic Central y Modos de Código en Ventana Flotante

**Fecha:** 2026-11-22  
**Estado:** ✅ Completado y validado (55/55 pruebas unitarias OK, `node --check` OK y verificación interactiva en navegador con 0 errores de consola/página)

---

## Fase 1 — Rangos de Línea (`line` / `end_line`), Endpoint `GET /source` y Confinamiento de `tsconfig.json`

- **Rangos exactos de funciones y pasos de flujo (`codemap/models.py`, `parsers/common.py`, `parsers/python_parser.py`, `parsers/js_parser.py`, `graph_builder.py`):**
  - Añadidos `FunctionInfo.end_line`, `FlowStep.line` y `FlowStep.end_line` junto al helper `end_line_of(node)` en `common.py` (maneja correctamente `end_point.column == 0`).
  - Instrumentados todos los emisores de flujo interno en Python y JS/TS/JSX/TSX (entrada/firma, hooks, bloques compactados de asignaciones/DOM `[first..last]`, cabeceras de decisión `if`/`elif`/`match`/`switch`, bucles/callbacks y bloques `try`/`except`/`catch`).
  - Expuestos `"end_line"` en nodos `function` y `"line"` / `"end_line"` en `internal_flow` dentro de `graph_builder.py`, sin engordar `exporter.py` (el export JSON para IA mantiene `11,730 B` / `-78.8%` en `examples/multi`).
- **Endpoint de solo lectura `GET /source?node_id=<id>` (`codemap/server.py`):**
  - Resuelve exclusivamente nodos `function` y `file` existentes en `APP_GRAPH`, valida confinamiento estricto al objetivo analizado (`_is_within_project_target()` contra *path traversal* y symlinks externos), ejecuta la lectura en hilo (`asyncio.to_thread`), normaliza `\r\n` y queda protegido por `local_origin_middleware` (`127.0.0.1`, `localhost`, `[::1]` en el puerto asignado).
- **Confinamiento de `"extends"` en `tsconfig.json` / `jsconfig.json` (`codemap/resolver.py`):**
  - Restringida la resolución de cadenas `"extends"` relativas estrictamente dentro de `root_dir` (`resolved.is_relative_to(root_dir)`), evitando escapes fuera del repositorio analizado.

---

## Fase 2 — Enrutamiento Ortogonal en `↑ Creación`, Clic Central y Modos `Solo flujo` / `Solo código` / `Flujo y código`

- **Preservación de rutas ortogonales ELKjs en `↑ Creación` (`codemap/viewer/app.js`):**
  - Reforzado el espaciado entre canales en `ELK_LAYOUT_OPTIONS` (`edgeEdge: "14"`, `edgeEdgeBetweenLayers: "14"`) y en modo `UP` dentro de `buildElkInput()` (`edgeEdge: "16"`, `edgeEdgeBetweenLayers: "16"`, `edgeNodeBetweenLayers: "24"`, `nodeNodeBetweenLayers: "54"`).
  - Extendido `applyCreationRowStagger()` para devolver en `shiftedNodeIds.staggerMeta` los deltas `nodeDeltaY`, `containerBaseShiftY` y `containerRowBreaks` (manteniendo compatibilidad total con el `Set` retornado).
  - Añadidos `computeStaggeredChannelShiftY()` y `adjustElkSectionPoints()` para trasladar limpiamente `startPoint`, `bendPoints` intermedios (desplazamiento por canales de fila en `Y`) y `endPoint`, preservando la clase `.elk-routed` (`segments` ortogonales de 90°) en lugar de caer a `taxi` para nodos escalonados no fijados (solo nodos fijados por el usuario en `pinnedNodeIds` ceden a `taxi`).
- **Apertura de ventanas flotantes con botón central del mouse (`codemap/viewer/app.js`, `index.html`):**
  - Añadido `hitTestCyNodeAtClientPoint(cyInst, clientX, clientY)` priorizando el nodo hoja más profundo (`!isParent`, mayor profundidad de ancestros, menor área).
  - Actualizado `attachPanControls()` con bloqueo de `auxclick` (con limpieza en `detach()`), umbral de arrastre de `4 px` y callback `onMiddleClick` disparado estrictamente al soltar `button === 1` sin desplazamiento (nunca al perder foco).
  - Conectado en el lienzo principal (`#cy`) y en ventanas flotantes (`win.cy`, abriendo ventanas hijas anidadas con `parentWindowId`), manteniendo intacto el paneo al arrastrar con la rueda.
- **Modos `Solo flujo`, `Solo código` y `Flujo y código` en ventanas flotantes de función (`codemap/viewer/app.js`, `styles.css`, `index.html`):**
  - Selector segmentado `.fw-mode-switcher` en `.fw-header` y panel `.fw-code-pane` en `.fw-body` (oculto por defecto en `Solo flujo`).
  - Carga perezosa bajo demanda vía `GET /source?node_id=...` con caché en la ventana, refresco automático ante actualizaciones en vivo (`reconcileFloatingWindowsOnLiveUpdate`), botón `Copiar` (`✓ Copiado`) y resaltado sintáctico seguro 100% DOM (`textContent` / `replaceChildren()`, cero `innerHTML`).
  - En **Flujo y código** (`.fw-body.mode-split`), la ventana se ensancha ergonómicamente (restaurando su ancho al salir) mostrando grafo y código 50/50 con sincronización bidireccional paso ↔ línea de código (`highlightFloatingCodeForStep` / `findBestFlowStepForLine`).
- **Documentación y cierre:** Actualizados `#help-modal`, `README.md` y limpiados todos los ítems resueltos en `BACKLOG.md`.

---

## Validación Final

- Nuevas suites: `tests/test_cycle4_phase1.py` (4 casos: rangos Python, rangos JS/TS, `GET /source` + seguridad, confinamiento `tsconfig extends`) y `tests/test_cycle4_phase2.py` (3 casos: ejecución real headless de `elk.bundled.js` + `cytoscape.min.js` sobre `examples/multi` en `↑ Creación` verificando 100% `.elk-routed`, 0 segmentos no ortogonales y 0 cruces de nodos; contratos de clic central/hit-testing; resaltado DOM sin `innerHTML` y sincronización paso ↔ línea).
- `.venv\Scripts\python.exe -m unittest discover -s tests -v`: **55/55 pruebas OK**.
- `node --check codemap/viewer/app.js`: **exit 0**.
- Verificación interactiva en navegador sobre `examples/multi` con **0 errores de consola y 0 errores de página**, confirmando: canales ortogonales limpios en Nivel 3 + `Orden: ↑ Creación`, arrastre con rueda (paneo sin abrir ventana), clic central en archivo (`users.py`) y clic central anidado en función (`build_report()`), carga `GET /source` (`L22–L30`), copia al portapapeles (`✓ Copiado`), vista dividida 50/50 `Flujo y código` con sincronización bidireccional paso ↔ línea, restauración de ancho al volver a `Solo flujo` y ayuda `#help-modal` actualizada.
