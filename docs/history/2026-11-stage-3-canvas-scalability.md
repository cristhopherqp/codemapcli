# Etapa 3 — Escalabilidad Visual I (Limpieza de Lienzo)

**Fecha:** 2026-11-19  
**Estado:** ✅ Completada y validada (25/25 pruebas unitarias OK, `node --check` OK y verificación extremo a extremo en navegador con 0 errores de consola)

---

## 1. Escalabilidad (1/5) — Aislamiento Real de Subgrafo en Hilos y Modo Foco

- **Hook unificado `computeSubgraphFilter()` (`codemap/viewer/app.js`):**
  - Filtra directamente `buildVisibleElements()` y `projectEdges()` para pasar a ELKjs únicamente los nodos, contenedores ancestros y aristas pertenecientes al `execution_flow` activo o a la vecindad inmediata del Modo Foco (`T`), preparado para reutilizarse en `N-hops` (Etapa 4).
  - Controles sincronizados en tres puntos contextuales: botón **"Aislar en lienzo"** en la barra superior (`#btn-isolate-context`), botón **"Aislar"** en `#active-flow-panel` (`#btn-inspector-isolate-flow`) y botón **"Aislar"** en `#trace-branch-hud` (`#btn-trace-isolate`).
- **Guardas anti-regresión:**
  - En modo aislado, `runElkLayout()` ignora temporalmente `pinned_positions` del lienzo completo para construir árboles compactos y directos.
  - Al avanzar o retroceder en Modo Foco (`→`/`←`/`Enter` o clic en otro nodo), `jumpTraceToNode()` recompone dinámicamente el subgrafo aislado a partir de `state.rawGraph.edges` alrededor del nuevo nodo enfocado.
  - `hasActiveFocusOrFlow()` reconoce el aislamiento real en `#export-modal`, manteniendo habilitada la exportación PNG/JPG de **"Solo Foco / Hilo activo"** aunque haya 0 elementos `.dimmed`.

---

## 2. Escalabilidad (3/5) — Enrutamiento Ortogonal ELKjs (`ORTHOGONAL` → `segments` / `taxi`)

- **Configuración ELKjs (`ELK_LAYOUT_OPTIONS` en `codemap/viewer/app.js`):**
  - Activado `"elk.edgeRouting": "ORTHOGONAL"` junto con márgenes dedicados (`elk.spacing.edgeNode: "20"`, `elk.spacing.edgeEdge: "12"`, `elk.layered.spacing.edgeNodeBetweenLayers: "22"`).
- **Mapeo geométrico exacto y compartido (`applyElkEdgeRoutes()`, `convertElkPointsToCytoscapeSegments()`):**
  - `collectAbsolutePositions()` registra los offsets absolutos de cada contenedor (`containerOffsets`) bajo `INCLUDE_CHILDREN` para trasladar correctamente `edge.sections[0]` cuando `edge.container !== "root"`.
  - Proyecta `[startPoint, ...bendPoints, endPoint]` usando la inversa exacta de `vectorNormInverse` de Cytoscape (`edge-distances: "node-position"`, `segment-weights`, `segment-distances`, `segment-radii: 6`) bajo la clase `.elk-routed`.
  - Fallback ortogonal automático `curve-style: "taxi"` (`downward` en lienzo principal/flujos y `rightward` en ventanas flotantes de archivo/módulo) para aristas rectas, extremos compuestos o nodos fijados/arrastrados, y `bezier` para auto-lazos (`edge:loop`).
  - Al arrastrar un nodo (`handleNodeDragFree`), se retira `.elk-routed` de sus aristas incidentes para recalcular al instante con `taxi` sin quiebres obsoletos.
  - Compartido con `runSubElkLayout()` en ventanas flotantes anidadas.

---

## 3. Escalabilidad (4/5) — Modo "Aristas bajo demanda" (*Hover / Selection Reveal*)

- **Botón `#btn-on-demand-edges` en la barra lateral y `applyOnDemandEdgeHighlight()` (`index.html`, `app.js`):**
  - Atenúa aristas `edge[kind="call"]` no prioritarias (`.edge-muted`: `opacity: 0.10`, `text-opacity: 0`) preservando las aristas de un hilo de ejecución activo si existe.
  - Al pasar el cursor (`mouseover`) o mantener un nodo seleccionado (`selectedNodeId`), revela dinámicamente sus aristas incidentes diferenciando **entrantes en cian** (`.edge-reveal-in`, `#22d3ee`) y **salientes en ámbar** (`.edge-reveal-out`, `#f59e0b`), soportando tanto funciones individuales como contenedores compuestos.

---

## 4. Validación

- Nuevas pruebas en `tests/test_stage3.py` (incluyendo test geométrico headless contra ELKjs verificando error de reconstrucción `< 0.15 px`).
- `.venv\Scripts\python.exe -m unittest discover -s tests -v`: **25/25 OK**; `node --check codemap/viewer/app.js`: **exit 0**.
- Verificación interactiva en navegador sobre `examples/multi` (`http://127.0.0.1:62651`, **0 errores de consola**): enrutamiento ortogonal en Nivel 3 y ventanas flotantes, aislamiento real de `Hilo Principal · app.py::main` (`18 fns → 5 fns`) con exportación de foco habilitada, navegación aislada en Modo Foco (`main() → UserService.get_user() → normalize()`) y revelado cian/ámbar en Aristas bajo demanda.
