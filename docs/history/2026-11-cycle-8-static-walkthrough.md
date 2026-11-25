# Ciclo 8 — Recorrido Visual Estático ("Chispa"), Call Stack Simulado y Sincronización con Código

**Fecha:** 2026-11-24  
**Estado:** ✅ Completado y validado (81/81 pruebas unitarias y headless OK, `node --check` OK en `walkthrough.js` y `app.js`, y verificación interactiva en navegador sobre `examples/multi` con 0 errores de consola y 0 peticiones fallidas)

---

## Motivación

Un grafo estático muestra todas las dependencias a la vez, pero entender el viaje secuencial del control (qué se invoca primero, qué se apila en el Call Stack, qué rama se sigue en un `if`/`try-catch` y en qué línea exacta retorna el control antes de seguir a la siguiente sentencia) resulta mucho más natural mediante una animación paso a paso sin ejecutar el código objetivo. Al mismo tiempo, el contrato de eventos debía nacer desacoplado del generador estático para poder reproducir trazas dinámicas reales (`codemap trace`) en una iteración futura sin reescribir el reproductor.

---

## Cambios Implementados

### Fase 8.1 — `call_lines` en backend y generador `WalkthroughTrace` v1 (`graph_builder.py`, `walkthrough.js`)
- **Backend (`codemap/graph_builder.py`):** `aggregate_edges()` añade `call_lines: list[int]` (líneas únicas ordenadas de cada invocación) en todas las aristas agregadas de `graph.json` para mapear llamadas repetidas hacia la misma función a su paso exacto, manteniendo `_compact_edge()` de `exporter.py` intacto y compacto.
- **Contrato desacoplado `WalkthroughTrace` (`schema_version: 1`) en `codemap/viewer/walkthrough.js`:**
  - Script estándar compatible con navegador (`window.CodeMapWalkthrough`) y Node (`module.exports`) sin bundler.
  - Cada evento sigue el esquema estándar `{ seq, kind, from, to, fn_id, step_id, edge_id, line, end_line, label, action_kind, branch_key, branch_kind, branch_options, flashed_edges, step_over, has_return_value, stack_frame, call_stack }` reservando explícitamente `timestamp_us: null`, `locals_diff: null` y `exception_info: null` para trazas dinámicas futuras; `normalizeTrace()` admite trazas externas derivando `call_stack` automáticamente si viene omitido.
- **`StaticWalkthroughGenerator`:**
  - **Modo Pulso (Nivel 3):** recorrido DFS con eventos pareados `call` (apila frame) y `return` (desapila frame), ordenados por `call_lines`, con protección anti-ciclos por pila activa y topes `MAX_DEPTH = 12` / `MAX_EVENTS = 500`.
  - **Modo Paso a Paso (Nivel 3+):** recorrido instrucción por instrucción sobre `internal_flow`, entrando en pasos interiores de contenedores (`loop`/`event`), con soporte para **`Profundizar en hijas`** (*Step Into* vs *Step Over*).
  - **Ramas `if` / `switch` / `try-catch`:** elige por defecto el camino principal (*happy path*, evitando guardas con `raise`/`throw` y siguiendo el cuerpo `try`), adjunta `flashed_edges` (destello carmesí en ramas de guarda/excepción evaluadas) y `branch_options`, y regenera determinísticamente la secuencia al aplicar `branch_overrides`.

### Fase 8.2 — Motor `<canvas>` "Chispa" sobre polilíneas ortogonales (`walkthrough.js`, `index.html`, `styles.css`)
- **Capa `<canvas>` superpuesta sin mutar Cytoscape ni ELKjs:** `<canvas id="walkthrough-canvas" class="walkthrough-canvas">` sobre `#canvas-area` (`pointer-events: none`, escalado `devicePixelRatio`), más espejo dinámico `.fw-walkthrough-canvas` sobre `.fw-cy-container` en ventanas flotantes abiertas.
- **Extracción de polilínea ortogonal exacta (`extractEdgePolyline`):** lee `cyEdge.sourceEndpoint()`, `cyEdge.segmentPoints()` y `cyEdge.targetEndpoint()` en navegador, con reconstrucción matemática exacta desde `segWeights`/`segDistances` + `srcEndpoint`/`tgtEndpoint` como respaldo determinista (y para pruebas headless); invierte automáticamente la polilínea en eventos `return`.
- **Interpolación por longitud de arco y animación (`WalkthroughCanvasRenderer`):** `samplePolylineAt()` interpola a velocidad uniforme sobre ángulos exactos de 90° re-proyectando con `cy.pan()` y `cy.zoom()` vivos en cada frame de `requestAnimationFrame`, dibujando estela cometa (8 muestras), núcleo luminoso, halo radial en destino, ida+vuelta en `Step Over`, destellos carmesí de `380 ms` en `flashed_edges` y semántica cromática (`call` cian `#22d3ee`, `return` esmeralda `#34d399` / ámbar `#fbbf24`, `step` azul cielo `#7dd3fc`, `throw`/`catch`/`branch_flash` carmesí `#f43f5e`).

### Fase 8.3 — HUD de reproducción, Call Stack simulado y sincronización con código (`index.html`, `styles.css`, `app.js`, `walkthrough.js`)
- **Accesos y atajos:** botón **`⚡ Recorrido Visual (W)`** en la barra lateral izquierda, botón **`⚡ Recorrer`** en el panel de Hilo de Ejecución activo, atajos `W`, `←`/`→` y cierre con `Esc`.
- **HUD flotante compacto (`#walkthrough-hud`, `z-index: 860` por encima de ventanas flotantes):** controles `←`, `▶ / ⏸`, `→`, contador `seq / total`, velocidad `0.5× / 1× / 2× / 4×`, conmutador **`Pulso (N3)`** / **`Paso a Paso (N3+)`**, toggle **`Profundizar en hijas`**, botón cerrar y fila dinámica `#wt-branch-bar` con píldoras clicables de bifurcación.
- **Call Stack simulado (`#walkthrough-stack-panel`) y código sincronizado (`GET /source`):** pila de frames clicables en el Inspector (tope activo arriba), vista de código en vivo centrada en `[line..end_line]` con resaltado sintáctico y botón **`↗ Flujo y código`** que abre/sincroniza la ventana flotante dividida de la función activa.
- **Tarjeta flotante de acción (`#walkthrough-action-card`):** acompaña al nodo/paso activo (re-anclada en `pan`/`zoom`/`resize`) mostrando icono/insignia de acción, línea y resumen de 1 frase.

---

## Validación Final

- Nueva suite: [test_cycle8_walkthrough.py](file:///e:/all_projects/guided_ia_proj/codemap/tests/test_cycle8_walkthrough.py) (5 pruebas unitarias y headless verificando `call_lines`, contrato v1, DFS Pulso con anti-ciclos/`MAX_EVENTS`/`normalizeTrace`, Paso a Paso con `Step Into`/`Step Over`/bucles/`flashed_edges`/`branch_overrides`, polilíneas ortogonales e inversión `return` en Cytoscape 3.30.2 y contratos HTML/CSS/JS).
- `.venv\Scripts\python.exe -m unittest discover -s tests -v`: **81/81 pruebas OK** (`30.32s`).
- `node --check codemap/viewer/walkthrough.js` y `node --check codemap/viewer/app.js`: **exit 0**.
- Verificación interactiva en navegador con **0 errores de consola** y **0 peticiones HTTP fallidas** sobre `examples/multi`: Modo Pulso N3 (`1/14`, apilado/desapilado `1 → 2 → 1 frames`, `←`/`→`, reproducción `2×`), Modo Paso a Paso N3+ (`1/36` en *Step Into* vs `1/11` en *Step Over*, sincronización viva de líneas vía `GET /source`), ventana flotante `Flujo y código` sincronizada con espejo `.fw-walkthrough-canvas`, y cierre limpio de HUD/pila/tarjeta.
