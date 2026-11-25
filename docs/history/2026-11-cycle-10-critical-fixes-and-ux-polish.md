# Ciclo 10 — Fixes Críticos de Nivel 3/2/1, APIs Externas, Inspector Redimensionable y Recorrido en Ventana Flotante

- **Fecha:** 2026-11-24
- **Alcance:** Tanda completa de bugs críticos, mejoras UX y auditoría general detectados tras probar los Ciclos 6–9 (`BACKLOG.md` — Ciclo 10; respetando la exclusión de `[HORIZONTE FUTURO] codemap trace`).
- **Principio verificado:** 100 % estático, cero intrusión sobre repositorios analizados y 0 errores de consola.

---

## Cambios implementados

### 1. Diagnóstico y Corrección de Bugs Críticos
- **Desorden de flechas al seleccionar en `Nivel 3: Funciones` (`codemap/viewer/app.js`):**
  - *Causa raíz:* Cytoscape dispara `grab` inmediatamente al pulsar `mousedown` (incluso en clics de `0 px` para seleccionar), y `handleNodeGrab()` retiraba `.elk-routed` y `srcEndpoint`/`tgtEndpoint` de inmediato; como en un clic de `0 px` Cytoscape emite `free` y nunca `dragfree`, las aristas quedaban degradadas permanentemente a `taxi`.
  - *Corrección:* `handleNodeGrab()` ahora únicamente captura posiciones iniciales (`_activeDragState`) sin tocar ninguna arista; solo tras superar `DRAG_MOVE_THRESHOLD_PX = 3 px` en `handleNodeDrag()` se sueltan las aristas externas. Se añadió `handleNodeFree()` para limpiar clics de `0 px` y una salvaguarda en `handleNodeDragFreeBatch()` que restaura micro-temblores `< 3 px` sin re-enrutar ni fijar el nodo. Se verificó también que `buildStylesheet()` no sobrescribe `curve-style` ni `taxi-direction` en `:selected` ni clases de resaltado.
- **Re-enrutamiento local ortogonal mejorado en `Nivel 1`, `Nivel 2` y `Nivel 3` (`rerouteExternalEdgesLocally` en `codemap/viewer/app.js`):**
  - Incorpora como obstáculos tanto cajas hoja como contenedores compuestos hermanos (`file`/`module`/`layer`/`expandedFn`) excluyendo ancestros/descendientes de origen y destino.
  - Distribuye puertos en **ambas caras** (fan-out en origen y fan-in en destino) ordenados espacialmente por la coordenada opuesta para eliminar cruces locales al salir/entrar de la caja movida.
  - Implementa registro de canales horizontales/verticales ocupados (`CHANNEL_SEP = 12 px`) y pasillos de rodeo de 5 segmentos con verificación de obstáculos en las patas de entrada y salida.
- **Extracción y resolución completa de librerías/APIs externas (`codemap/parsers/js_parser.py`, `codemap/parsers/python_parser.py`, `codemap/resolver.py`, `codemap/graph_builder.py`, `codemap/vocab_dictionary.json`, `codemap/viewer/vocab.js`):**
  - *Causas raíz encontradas:* (1) `is_js_local_alias()` marcaba `"node:"` como alias local y descartaba todo `import path from "node:path"`; (2) `IMPORT_QUERY` en `js_parser.py` omitía destructuring CommonJS con alias (`const { resolve: resPath } = require('path')`) y accesos a subpropiedades (`const fsp = require('fs').promises`, `const { readFile } = require('fs').promises`); (3) `JS_NATIVE_OBJECTS` / `JS_NATIVE_GLOBAL_FUNCTIONS` / `KNOWN_GLOBAL_OBJECTS` omitían `process`, `Buffer`, `TypeError`, `RangeError`, etc.; (4) `collect_external_calls()` guardaba solo la primera `line` de cada `api_id`, ocultando Fichas Vivas en invocaciones repetidas dentro de la misma función; (5) `import os.path` en Python no enlazaba el paquete raíz `os`.
  - *Corrección:* Añadido `normalize_node_builtin_module()` clasificando módulos Node (`node:*` y bare como `path`, `fs`, `fs/promises`) como `kind: "stdlib"` con enlaces oficiales a `nodejs.org/api/`, ampliado `IMPORT_QUERY` (JS/TS), `collect_imports` (Python) y globales nativos JS/Node, añadido soporte multi-línea `lines: [...]` en `external_calls` (podado del exportador IA y consumido por `vocab.js`) y agregadas fichas curadas (`node:path.resolve`, `node:path.join`, `node:fs.*`, `js:process.cwd`, `js:URL`) en `vocab_dictionary.json`.
- **Visor de código en Inspector sin recortes + `Ajustar líneas` + Inspector redimensionable (`codemap/viewer/index.html`, `styles.css`, `walkthrough.js`, `app.js`):**
  - Añadido toggle **`Ajustar líneas`** (`#btn-wt-wrap-code`, persistido en `localStorage`, activado por defecto) junto a **`↗ Flujo y código`** alternando entre `white-space: pre-wrap; overflow-wrap: anywhere` y scroll horizontal sin recortes, con scroll vertical (`max-height: 280–320px`) y auto-scroll a la línea activa.
  - Incorporado tirador arrastrable **`#details-panel-resizer`** en el borde izquierdo de `#details-panel` (rango `280–760px`, doble clic restaura `350px`, persistencia en `localStorage`, actualización en vivo de `state.cy.resize()`, puentes SVG y tarjeta del recorrido).

### 2. Mejoras UX y Auditoría General
- **Unificación de marca a "Recorrido Visual":** Eliminadas todas las ocurrencias de `"Chispa"` en `index.html`, `app.js`, `walkthrough.js`, `styles.css` y `README.md`.
- **Recorrido Visual aislado en ventana flotante (`scope: "window"`):** Botón **`⚡ Recorrer`** / **`⏹ Detener`** en `.fw-header` de ventanas flotantes de función (`win.isFunctionFlow`), animando únicamente `.fw-walkthrough-canvas` y el panel de código de esa ventana sin expandir ni mutar `#cy`, reubicando suavemente la ventana si `top < 54px` para no solaparse con `#walkthrough-hud`, y deteniendo el recorrido limpiamente si se cierra la ventana o se pulsa `Esc`.
- **HUD en una única fila horizontal (`#walkthrough-hud`):** `flex-wrap: nowrap; white-space: nowrap`, etiquetas compactas (`Paso a Paso`, `↳ Profundizar`, `✕`) y píldora contextual `#wt-scope-pill` en ámbito de ventana.
- **Separación de flechas y claridad en `Nivel 3+: Intra-función`:** Incrementado espaciado ELK (`edgeEdge: 22`, `edgeEdgeBetweenLayers: 22`, `edgeNode: 26–28`, `nodeNode: 40–48`, mayor `padding`) y añadida atenuación/resaltado selectivo (`.flow-bg-muted` / `.flow-focus-active`) y ocultado inteligente de etiquetas de flujo al alejar zoom (`< 0.62`) cuando hay `>= 2` funciones expandidas.
- **Auditoría de listeners y edge cases:** Añadido `window.blur` en todos los drags/resizers para evitar estados atascados al perder foco, `window.resize` sincronizado con `#details-panel` y `#walkthrough-action-card`, limpieza de `activeDragCleanup` previa, prioridad de `Esc` en recorridos de ventana y cierre seguro en `closeFloatingWindow()`.

---

## Verificación
- **Sintaxis JS:** `node --check` OK en `codemap/viewer/vocab.js`, `codemap/viewer/walkthrough.js` y `codemap/viewer/app.js`.
- **Pruebas unitarias y headless (`tests/test_cycle10_fixes.py` + batería completa):** **95/95** pruebas en verde (`0` fallos, `0` regresiones).
- **Verificación en navegador real (`examples/multi`):** 0 errores de consola y 0 peticiones fallidas (`18/18` HTTP 200); confirmados 0 menciones de `"Chispa"`, clic 0 px en Nivel 3 sin degradar aristas ni fijar nodo, arrastre ortogonal en Nivel 3, `#walkthrough-hud` en una sola fila exacta (`topSpread = 0 px`), `Ajustar líneas` en Inspector y redimensionado `350 px → 457 px → 350 px` con `#details-panel-resizer`, recorrido aislado en ventana flotante con `0` funciones expandidas en `#cy` y detención limpia al cerrar la ventana, y `Nivel 3+` con múltiples funciones espaciadas con claridad.
