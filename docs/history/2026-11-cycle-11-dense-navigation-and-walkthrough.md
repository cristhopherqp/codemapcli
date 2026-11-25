# Ciclo 11 — Navegación en Grafos Densos y Mejoras del Recorrido Visual (Noviembre 2026)

## Resumen del Lote Completado

Se implementaron y verificaron en un solo bloque coherente las 3 mejoras orientadas a grafos densos (`Nivel 3+`) y ergonomía del *Recorrido Visual Estático*, preservando la invariante de cero intrusión en repositorios analizados, compatibilidad con `WalkthroughTrace` v1 y sin introducir bundler.

### 1. Zoom mínimo ampliado (`2 %–400 %`), ajuste dinámico antes de `fit()` e indicador inline editable
- **Límites ampliados (`codemap/viewer/app.js`):**
  - Se redujo el piso base de `#cy` de `0.15` a `MAIN_MIN_ZOOM = 0.02` (`2 %`) y se amplió `MAIN_MAX_ZOOM = 4` (`400 %`), junto con `FW_MIN_ZOOM = 0.05` / `FW_MAX_ZOOM = 4` en ventanas flotantes.
  - Se añadió `fitCyWithDynamicMinZoom(cy, eles, padding, baseMinZoom)` para calcular el `neededZoom` real según el bounding box del grafo y bajar dinámicamente `cy.minZoom()` (hasta `DYNAMIC_MIN_ZOOM_FLOOR = 0.005`) antes de ejecutar `cy.fit()`, garantizando encuadre completo en `Nivel 3+` incluso en proyectos muy densos y restaurando el piso base al volver a niveles compactos.
- **Indicador de zoom inline editable (`index.html`, `styles.css`, `app.js`):**
  - Hacer clic en `#zoom-indicator` despliega `#zoom-input` seleccionado para escribir cualquier porcentaje (`2–400`, aceptando `%` opcional), aplicando `Enter` centrado en el viewport actual (`setZoomPercentCentered`) y cancelando con `Esc` sin propagar al manejador global de `Escape` (evitando cerrar modales, ventanas flotantes o el Recorrido Visual).
  - Sincronizado bidireccionalmente con rueda del mouse, botones `−`/`+`, `F` y `Ctrl+0`.

### 2. Cámara de seguimiento activable (`🎥 Seguir`) en el Recorrido Visual
- **HUD estrictamente en una fila (`index.html`, `styles.css`, `walkthrough.js`):**
  - Se incorporó el toggle compacto `#btn-wt-follow` (`🎥 Seguir`, `aria-pressed`) dentro de `.wt-hud-row` (`flex-wrap: nowrap; white-space: nowrap;`) y se acortó `#btn-wt-mode-pulse` a `Pulso`.
- **Seguimiento suave con amortiguación exponencial (*lerp*):**
  - `WalkthroughCanvasRenderer` interpola `cy.pan()` en cada frame `requestAnimationFrame` mediante `computeCameraFollowPanStep()` independiente del frame rate (`dtSec` acotado a `50 ms`), siguiendo la cabeza de la luz animada sobre la polilínea ortogonal durante el viaje y centrando el nodo/paso activo en pausa o avance manual, **preservando intacto `cy.zoom()`**.
  - Funciona tanto en el lienzo principal (`scope: "main"`, `#cy`) como en modo aislado en ventana flotante (`scope: "window"`, `win.cy`), actualizando la tarjeta de acción y los puentes SVG.
  - **Cesión inteligente al paneo manual sin falsos positivos por rueda:** el paneo programático corre protegido bajo `programmaticPanDepth` y `notifyManualPan()` solo apaga `🎥 Seguir` ante arrastres manuales reales (`attachPanControls` con `didMove` o arrastre izquierdo/táctil sobre el fondo vacío), permitiendo acercar/alejar libremente con rueda sin perder el seguimiento.
  - Se ajustó además `computeFloatingWindowPosition()` para abrir ventanas flotantes por debajo de `#walkthrough-hud` (`top >= 58px`) cuando el recorrido está activo.

### 3. Expansión dinámica selectiva de `+1 nivel` en `Paso a Paso` (Niveles 1, 2 y 3)
- **Respeto del nivel actual e instantánea exacta (`app.js`, `walkthrough.js`):**
  - Se eliminó la subida forzada a `Nivel 3` y la expansión simultánea de 8 funciones en `prepareCanvasForTrace()`.
  - Se implementó el gestor `state.walkthroughExpansion` (`captureWalkthroughExpansionSnapshot`, `computeWalkthroughSelectiveExpansionPlan`, `syncWalkthroughSelectiveExpansion`, `restoreWalkthroughExpansion`):
    - **Nivel 1 (`Carpetas` y `Capas`):** expande temporalmente solo el módulo o `layer::k` activo y colapsa temporalmente sus archivos hijos para mostrar estrictamente **+1 nivel** (solo archivos; o funciones si es un archivo raíz sin módulo). Se añadió además proyección fallback `layer::k` en `resolveVisibleCyNodeId()`.
    - **Nivel 2 (`Archivos`):** expande temporalmente solo el archivo activo mostrando sus funciones, manteniendo archivos hermanos colapsados y 0 flujos 3+ abiertos.
    - **Nivel 3 (`Funciones`):** expande temporalmente solo la función activa para mostrar su flujo interno 3+, manteniendo funciones hermanas compactas y preservando funciones que el usuario ya había expandido manualmente antes de iniciar.
    - **Nivel 3+ (`Intra-función`) y Ventana Flotante (`scope: "window"`):** avanzan sin alterar expansiones del grafo principal.
  - En **Nivel 1 y Nivel 2**, `Paso a Paso` recorre eventos de llamada/retorno para que la luz viaje visiblemente entre archivos/funciones en cada paso, reservando el avance instrucción a instrucción (`internal_flow`) para **Nivel 3, Nivel 3+ y Ventana Flotante**.
  - Al cambiar de contenedor/función, `applyCurrentEvent()` pausa el reloj de reproducción con protección de carrera (`transitionToken`) durante el relayout incremental de ELK (compatible con `Orden: ↓ Ejecución` y `Orden: Creación (1→N)`). `refreshGraphView()` calcula primero el layout completo (`computeElkLayoutResult`) antes de vaciar Cytoscape y aplica de forma atómica el intercambio de nodos/aristas + compensación de cámara (`captureViewportAnchorBeforeSwap` / `applyViewportAnchorAfterSwap`) anclando el encabezado del nodo activo en el mismo píxel de pantalla (`0 px` de salto visual, sin alterar ninguna ruta ortogonal `.elk-routed` ni desactivar `🎥 Seguir`). Al regresar a **Pulso** o cerrar el recorrido, restaura el estado previo exacto.

### 4. Control continuo de velocidad (`0.1×–4×`) sin flechas en `#walkthrough-hud`
- Se reemplazó el `<select>` de presets (`0.5×–4×`) por un `<input id="wt-speed-select" type="text" inputmode="decimal">` compacto (`46px`, sin flechas nativas ni chevron) dentro de la fila única del HUD.
- Soporta ajuste continuo con la **rueda del mouse** (pasos de `0.1×`, o `0.5×` con `Shift`, bloqueando propagación para no hacer zoom accidental al lienzo) y **escritura manual** (`0.1–4`, aceptando coma o `x`/`×`, `Enter` confirma, `Esc` revierte sin cerrar el Recorrido Visual), y se ajustó `getStepDurationMs()` para respetar el piso real de `0.1×` (reemplazando el límite previo de `0.25×`).

## Verificación Ejecutada

- **Sintaxis JS:** `node --check` limpio en `codemap/viewer/app.js`, `codemap/viewer/walkthrough.js` y `codemap/viewer/vocab.js`.
- **Pruebas automatizadas:** nueva batería `tests/test_cycle11_navigation_and_walkthrough.py` (7 suites headless/unitarias) + batería completa (`unittest discover -s tests`), 102/102 pruebas en verde.
- **Verificación interactiva en navegador real (`examples/multi`, `1440×900`):**
  - **0 errores de consola** durante todo el flujo.
  - Verificados zoom `5%`, `350%`, cancelación segura con `Esc` y *Centrar (`F`)* en `Nivel 3+`.
  - Verificado `#walkthrough-hud` estrictamente en una sola fila horizontal (`height: 35–36px`), tanto en lienzo principal como en ventana flotante con píldora de ámbito visible, y ventanas flotantes abriendo limpiamente debajo del HUD (`top >= 58px`).
  - Verificados control continuo de velocidad (`1× → 0.9× → 0.8×` por rueda sin fugar zoom al lienzo, `0.1×`, `2.7×`, acotado en `4×` y `Esc` sin cerrar el HUD), intercambio atómico sin salto al expandir/contraer en Niveles 1–3 (`Ejecución` y `Creación (1→N)`), cámara `🎥 Seguir` manteniendo zoom intacto y cesión automática al panear manualmente.
