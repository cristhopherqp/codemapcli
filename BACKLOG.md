# CodeMap — Plan de Mejoras y Correcciones (Backlog Técnico Depurado)

---

## Estado de Fases

- **Fase 1 (Parser AST, Resolver y Graph Builder):** ✅ Completada — análisis estático, resolución de alias/callbacks/top-level/HTML, semántica de aristas, cálculo determinista de `execution_flows` y compactación/límite de `FlowGraphBuilder` (Nivel 3+) verificados con `tests/test_phase1.py`.
- **Fase 2 (Visor Web, Hilos de Ejecución y Reducción de Ruido):** ✅ Completada — selector visual de `execution_flows`, estilos semánticos por `edge_type`/`entry_kind`/HTML + tooltip + leyenda, filtro anti-maraña con chips en inspector, Modo Foco multi-rama con `↑`/`↓`/`→`/`Enter`, aislamiento espacial de `pinned_positions` por nivel (`tests/test_phase2.py`) y exportación de capturas PNG/JPG verificados en navegador sin errores.
- **Fase 3 (UX Avanzada — Ventanas Flotantes Anidadas):** ✅ Completada — gestor de ventanas flotantes arrastrables y redimensionables con instancias Cytoscape+ELK aisladas, puertos de frontera (`⇠`/`⇢`), líneas puente SVG Bézier sincronizadas en tiempo real, bloqueo de cierre padre-hijo (`🔒` / `Cerrar cadena` / `Esc` por hojas), sincronización con el Inspector y reconciliación en recarga WebSocket, verificado extremo a extremo en navegador sin errores.

---

## 1. Bugs Críticos en Análisis Estático y Resolución (Parser & Resolver) — ✅ Fase 1 Completada

### 1.1. [✅ Resuelto — Fase 1] Funciones pasadas como referencia (Callbacks sin paréntesis)
- **Problema:** `python_parser.py` y `js_parser.py` solo capturaban invocaciones explícitas (`call`, `call_expression`, `new_expression`). Cuando una función se pasaba por referencia como argumento (ej. `addEventListener('click', loadSampleImages)`, `items.map(formatUser)`), no se generaba arista y el destino parecía código muerto.
- **Implementación y decisiones de diseño:**
  - `codemap/models.py`: `CallSite` enriquecido con `kind`, `is_invocation`, `via`, `event`, `is_top_level_stmt`, `is_main_guard`.
  - `codemap/parsers/js_parser.py` y `codemap/parsers/python_parser.py`: inspección de argumentos posicionales, nombrados (`keyword_argument`), `.bind(...)` y props JSX `onX={...}` para emitir `CallSite(is_invocation=False)` clasificados como `event_listener`, `reactive_subscribe` o `callback_ref`. También se detectan llamadas dentro de callbacks/lambdas inline pasados a registradores de eventos o suscripciones.
  - **Guardas anti-ruido y estabilidad de huella:**
    - Se omiten identificadores que sombrean parámetros de la función contenedora y contenedores de inspección/logging (`print`, `console.*`, `isinstance`, `type`, etc.).
    - `codemap/resolver.py`: para referencias no invocadas (`is_invocation=False`), se desactiva la resolución de clases a constructores (`allow_class_constructor=False`) y se restringe `infer_by_member` solo a registradores de eventos/suscripciones. Además se corrigió `lookup_in_scope()` para resolver funciones anidadas directas (`fn.inner`).
    - `compute_fingerprint()`, `has_io` y `collect_external_calls()` filtran estrictamente por `call.is_invocation`, manteniendo 100% intactas las huellas AST existentes en `notes.json` y evitando falsas APIs externas.

### 1.2. [✅ Resuelto — Fase 1] Llamadas en la raíz del archivo (Top-Level / Module Init Calls)
- **Problema:** Cuando `find_enclosing_key(call_node, functions)` devolvía `None`, las llamadas a nivel de módulo (`initApp()`, `start(3000)`, `if __name__ == "__main__": main()`) se descartaban.
- **Implementación y decisiones de diseño:**
  - `codemap/models.py`: añadido `FileAnalysis.module_calls`.
  - `js_parser.py` / `python_parser.py`: registran las llamadas top-level distinguiendo sentencias de arranque (`is_top_level_stmt=True` / `is_main_guard=True` para `if __name__ == "__main__":`) de inicializadores de constantes (`const x = helper()`), decoradores o cuerpos de clase.
  - `codemap/resolver.py` (`resolve_module_calls()`) y `codemap/graph_builder.py`: marcan funciones invocadas en top-level con `is_module_entry: true`, registran `module_entry_functions` en el nodo de archivo y emiten aristas directas únicamente para llamadas top-level **entre archivos distintos** (evitando aristas de contención padre → hijo incompatibles con Cytoscape/ELKjs).

### 1.3. [✅ Resuelto — Fase 1] Puente invisible en archivos HTML y detección del archivo gestor
- **Problema:** Los `.html` se ignoraban en `discovery.py`, desconectando servidores (`server.js` / `server.py`) del script gestor principal (`js/app.js`).
- **Implementación y decisiones de diseño:**
  - `codemap/discovery.py` y `codemap/languages.py`: soporte para `.html` y `.htm`.
  - `codemap/parsers/html_parser.py`: parser ligero basado en `html.parser.HTMLParser` (stdlib, sin dependencias extra) que extrae `<script src="...">` locales (ignorando CDNs/URLs externas) y detecta `type="module"`.
  - `js_parser.py` / `python_parser.py`: extraen referencias literales a `.html`/`.htm` (`FileAnalysis.html_refs`), directorios estáticos (`serves_static_dirs`) y señal de archivo servidor (`is_server_file`).
  - `codemap/resolver.py` (`resolve_html_bridges()`) y `codemap/graph_builder.py`: conectan `servidor -> html` (`edge_type: "serves_html"`) y `html -> script/función de arranque` (`edge_type: "loads_script"`), filtran archivos `.html` sueltos sin scripts ni servidor asociado para evitar ruido, y marcan los archivos gestores con `is_main_entry: true` (más `meta.main_entry_files` / `meta.main_entry_functions`).

### 1.4. [✅ Resuelto — Fase 1] Falsos positivos masivos en el rol `entry` (`INICIO`)
- **Problema:** `classify_role()` en `codemap/roles.py` asignaba `ROLE_ENTRY` a cualquier función sin llamadores (`not has_callers`), llenando el grafo de falsos `[INICIO]`.
- **Implementación y decisiones de diseño:**
  - `codemap/roles.py` y `codemap/graph_builder.py`: se eliminó la regla genérica `not has_callers -> ROLE_ENTRY` y se introdujo clasificación semántica explícita mediante `entry_kind` (`"main"`, `"route_handler"`, `"event_handler"`, `"unreferenced"`, `null`) junto a los flags `is_main_entry`, `is_event_handler`, `is_unreferenced` e `is_module_entry`.
  - Se mantienen los 4 roles visuales estándar (`entry`, `transform`, `decision`, `io`) en `node.role` para retrocompatibilidad total con el visor actual: solo las entradas reales de arranque (`main`, top-level, `__main__`, `DOMContentLoaded`/`load`, CLI) y rutas HTTP explícitas de nivel superior reciben `ROLE_ENTRY`. Handlers secundarios y funciones huérfanas conservan su rol conductual (`io`, `decision`, `transform`).

### 1.5. [✅ Resuelto — Fase 1 y Fase 2] Semántica de aristas y flujos invertidos (Patrón Observer / Pub-Sub)
- **Backend (Fase 1 — `models.py`, `resolver.py`, `graph_builder.py`):**
  - Todas las aristas en `graph.json` preservan los campos actuales (`id`, `source`, `target`, `confidence`, `call_count`, `line`) y añaden `edge_type` (`"direct_call"`, `"event_listener"`, `"callback_ref"`, `"reactive_subscribe"`, `"reactive_trigger"`, `"loads_script"`, `"serves_html"`), más `event` (evento/ruta) y `edge_types` cuando coexisten múltiples semánticas entre el mismo par.
  - `resolve_reactive_triggers()` deduce automáticamente la dirección reactiva de disparo (`notificador -> suscriptor`, `edge_type: "reactive_trigger"`, `confidence: "inferred"`) tanto para referencias directas (`subscribeState(updateUI)`) como para callbacks inline (`subscribeState(() => updateUI())`).
- **Visor Web (Fase 2 — `viewer/app.js`, `viewer/index.html`, `viewer/styles.css`):**
  - `projectEdges()` conserva `edgeType`, `edgeEvent`, `rawEdgeIds` y `line`; Cytoscape aplica estilos diferenciados para cada categoría (sólida cian directa, discontinua ámbar `event_listener`, punteada violeta `callback_ref`, diamante magenta `reactive_subscribe`, trazo pulso rosa `reactive_trigger` y conector estructural verde `serves_html`/`loads_script`).
  - Diferenciación visual de archivos `.html` (`🌐`, borde naranja, forma `cut-rectangle`), archivos gestores (`★`, borde verde) y `entry_kind` (`main`, `route_handler`, `event_handler`, `unreferenced` con borde discontinuo atenuado).
  - Tooltip semántico flotante `#edge-tooltip` al pasar sobre aristas, píldoras de tipo en "Llamadas internas" del inspector y leyenda `#graph-legend` actualizada.

### 1.6. [✅ Resuelto — Fase 1] Falsos paquetes npm en alias de rutas (`@/...`) y `.gitignore` anidados
- **Resolución de alias JS/TS (`resolver.py`, `graph_builder.py`):**
  - Lectura de `tsconfig.json` / `jsconfig.json` más cercanos (subiendo hasta `root_dir`, ideal para monorepos), con parser JSONC (comentarios `//`, `/* */` y comas colgantes), herencia `"extends"`, `compilerOptions.paths` (con orden por especificidad de comodines) y `compilerOptions.baseUrl`.
  - Respaldo automático para prefijos `@/`, `~/` y `/` contra la raíz del paquete, `src/`, `root_dir` y `public/`.
  - Guarda estricta en `classify_js_external()` y `npm_package_name()` (`is_js_local_alias()`): ningún alias (`@/...`, `~/...`, `/...`, `#...` ni rutas configuradas en `tsconfig.json`) genera enlaces rotos a `npmjs.com`, conservando paquetes con scope npm real (ej. `@tanstack/react-query`).
- **`.gitignore` anidados (`discovery.py`, `watcher.py`):**
  - Nueva clase `GitIgnoreMatcher` usando `pathspec.GitIgnoreSpec.check_file()` para evaluar jerárquicamente cada `.gitignore` relativo a su subdirectorio, respetando negaciones (`!`) en niveles inferiores y poda de directorios ancestros ignorados.
  - `codemap/watcher.py` integrado con `GitIgnoreMatcher` para recargar dinámicamente `.gitignore` anidados y reaccionar ante cambios en `tsconfig.json` / `jsconfig.json`.

---

## 2. Visualización de Hilos de Datos y Reducción de la "Maraña" (Viewer & Layout) — ✅ Fase 2 Completada

### 2.1. [✅ Resuelto — Fase 1 y Fase 2] Selector de Hilo Principal, Hilos Secundarios e Hilos por Feature
- **Backend (Fase 1 — `codemap/graph_builder.py`):**
  - Precalcula determinísticamente `execution_flows` en `graph.json` mediante DFS ordenado por línea y resistente a ciclos (`kind: "main"` de arranque y `kind: "feature"` por evento/ruta con `steps` numerados `1 → 2 → 3`).
- **Visor Web (Fase 2 — `viewer/app.js`, `viewer/index.html`, `viewer/styles.css`):**
  - Selector `#flow-select` en la barra superior agrupado en *Hilos Principales (Arranque)* e *Hilos por Feature / Evento / Ruta*, con botón rápido de reseteo (`#btn-clear-flow`) y soporte de `Esc`.
  - Al seleccionar un hilo: expande automáticamente los contenedores ancestros necesarios (guardando el estado previo para restaurarlo al volver a *Todos*), atenúa el resto del grafo (`.dimmed`), etiqueta los nodos/aristas activos con el orden secuencial (`[1]`, `[2]`, `[3]` / `#2`) y muestra la lista navegable de pasos en `#active-flow-panel` dentro del inspector.

### 2.2. [✅ Resuelto — Fase 2] Filtro Anti-Maraña para Nodos Utilitarios (Alto Fan-In / Leaf Helpers)
- **Implementación y decisiones de diseño (`viewer/app.js`, `viewer/index.html`, `viewer/styles.css`):**
  - `computeUtilityNodes()` detecta dinámicamente nodos hoja/utilitarios excluyendo puntos de entrada: umbral estricto ($\ge 3$ archivos o $\ge 5$ funciones llamadoras y $\le 1$ salida interna), con respaldo adaptativo para proyectos compactos ($\le 25$ funciones, hoja transversal llamada desde $\ge 2$ archivos) cuando el criterio estricto devuelve 0.
  - Interruptor `#btn-hide-utilities` en la barra lateral con contador dinámico. Al activarse, oculta dichos nodos y **todas** las aristas incidentes (con guarda explícita `hiddenNodeIds` en `projectEdges()` para evitar que `resolveVisibleEndpoint()` redirija aristas al archivo padre), muestra insignia `⚙×N` en los llamadores y lista chips interactivos en `#detail-hidden-utilities` dentro de "Llamadas internas" para inspeccionarlos al instante. Los utilitarios pertenecientes a un hilo de ejecución activo se mantienen visibles mientras ese hilo está seleccionado.

### 2.3. [✅ Resuelto — Fase 2] Navegación por teclado entre múltiples ramas en Modo Foco (`T`) y nodos `pinned`
- **Modo Foco multi-rama (`viewer/app.js`, `viewer/index.html`, `viewer/styles.css`):**
  - En Modo Foco (`T`), `↑` / `↓` ciclan entre ramas candidatas ordenadas por línea de llamada resaltando la arista y el destino candidato (`.trace-branch-active`) y actualizando el indicador flotante `#trace-branch-hud` (`Rama 1/N: nombreFuncion()`). `→` o `Enter` confirman el salto; `←` retrocede en el historial o permite elegir entre múltiples llamadores cuando el historial está vacío.
- **Aislamiento de coordenadas `pinned` por nivel (`codemap/notes_storage.py`, `viewer/app.js`, `tests/test_phase2.py`):**
  - `notes.json` incorpora el mapa opcional `pinned_positions` (`level_1`..`level_4`), manteniendo retrocompatibilidad con `x`/`y` planos (que aplican únicamente en `level_2` sin funciones expandidas).
  - `runElkLayout()`, `handleNodeDragFree()` y `#btn-pin-node` operan estrictamente sobre el contexto de nivel activo (`getCurrentLayoutContextKey()`), evitando que anclajes de Nivel 2 distorsionen los contenedores expandidos en Nivel 3+.

---

## 3. Nuevas Funcionalidades de Exploración y Exportación (UX Avanzada) — ✅ Fase 3 Completada

### 3.1. [✅ Resuelto — Fase 3] Expansión en Ventanas Flotantes Anidadas (Modales de Lienzo) con Puertos y Bloqueo Padre-Hijo
- **Problema:** Expandir un archivo (`state.js`) o el flujo interno de una función directamente sobre el grafo principal recalculaba todo el layout con ELKjs y rompía la distribución visual que el usuario ya había comprendido.
- **Arquitectura e implementación (`codemap/viewer/index.html`, `codemap/viewer/styles.css`, `codemap/viewer/app.js`):**
  - **Gestor de Ventanas Flotantes (`openFloatingWindow`, `buildFloatingSubgraph`, `runSubElkLayout`):**
    - Apertura desde el Inspector (`#btn-open-floating`) y mediante `Alt + Doble clic` en el grafo principal (o doble clic sobre funciones/sub-contenedores dentro de otra ventana flotante) para nodos `module`, `file` y `function` con `internal_flow`, sin tocar el layout ni las posiciones del grafo principal.
    - Cada ventana vive dentro de `#floating-windows-layer` (`position: absolute` en `#canvas-area`) con barra arrastrable, redimensionamiento (`resize: both` sincronizado mediante `ResizeObserver` con `subCy.resize()`), enfoque dinámico (`z-index`), botón centrar (`⛶`) y su propia instancia aislada de Cytoscape.js + ELKjs (reutilizando `buildStylesheet`, `buildElkInput`, `collectAbsolutePositions`, `appendInternalFlowElements` y `appendInternalFlowEdges`).
    - Los sub-grafos de archivos/módulos se distribuyen con ELK en dirección `RIGHT` (puertos `⇠` a la izquierda, internos al centro, puertos `⇢` a la derecha) y los flujos Nivel 3+ de funciones en dirección `DOWN` sin caja contenedora redundante.
  - **Puertos de Frontera y Líneas Puente SVG (`handlePortClick`, `renderFloatingBridges`):**
    - Calcula automáticamente las aristas de `state.rawGraph.edges` que cruzan la frontera del módulo/archivo para crear píldoras compactas deduplicadas `.port-in` (`⇠ archivo :: fn()`) y `.port-out` (`⇢ archivo :: fn()`), preservando los endpoints reales (`rawSource`/`rawTarget`) en `#edge-tooltip`. Si el propio archivo participa en aristas directas (p. ej. `loads_script` HTML o llamadas top-level), añade automáticamente su nodo ancla raíz.
    - Al hacer clic en un puerto se abre (o enfoca, evitando ciclos padre-hijo si ya está abierta) la ventana del archivo/módulo conectado, resaltando en dorado (`.port-linked-highlight`) el puerto recíproco y la función destino.
    - Capa SVG `#floating-bridges-svg` (`pointer-events: none`, sincronizada vía `requestAnimationFrame`) que dibuja curvas Bézier discontinuas por tipo semántico de arista entre puertos conectados y curvas `.bridge-parent_child` entre un nodo función/archivo padre y su ventana hija anidada, actualizándose en vivo al arrastrar, redimensionar o hacer pan/zoom.
  - **Jerarquía Padre → Hijo, Bloqueo de Cierre y Ciclo de Vida (`closeFloatingWindow`, `closeMostRecentLeafFloatingWindow`, `reconcileFloatingWindowsOnLiveUpdate`):**
    - Cada ventana rastrea `parentWindowId` y `childWindowIds` (infiriendo automáticamente la ventana padre cuando se abre una función desde el Inspector estando su ventana contenedora activa).
    - Mientras `childWindowIds.size > 0`, el botón de cierre cambia a estado bloqueado (`🔒` / `.locked`), rechaza el cierre individual mostrando `.fw-lock-notice` y haciendo pulsar (`.pulse-child`) a las ventanas descendientes, y muestra el botón secundario explícito **"Cerrar cadena"** para cerrar el sub-árbol en orden hoja → raíz.
    - La tecla `Esc` cierra únicamente la ventana flotante **hoja** más recientemente activa antes de salir del Modo Foco o deseleccionar nodos.
    - Clicar cualquier nodo o paso de flujo dentro de una ventana flotante actualiza el Inspector derecho (`selectNode`, `syncFlowStepHighlight`, notas, roles y enlaces VS Code). Al cerrarse, se destruye `win.cy.destroy()`, se desconecta `ResizeObserver` y se limpian timers/referencias; ante actualizaciones WebSocket (`applyLiveUpdate`), las ventanas sobrevivientes se re-renderizan y las eliminadas se cierran limpiamente re-parentando hijas aún válidas.

### 3.2. [✅ Resuelto — Fase 2] Exportación de Capturas del Grafo (PNG / JPG)
- **Implementación y decisiones de diseño (`viewer/app.js`, `viewer/index.html`, `viewer/styles.css`):**
  - Botón `#btn-export-image` en la barra lateral que abre `#export-modal` con descarga directa en **PNG** y **JPG** (escala `2×`, fondo `#0f141b`) para tres alcances: **Grafo completo** (`full: true`), **Vista actual** (`full: false`) y **Solo Foco / Hilo activo** (oculta temporalmente los elementos `.dimmed` mediante la clase `.export-hidden` durante la captura de Cytoscape y los restaura inmediatamente en `finally`).

### 3.3. [✅ Resuelto — Fase 1] Límite configurable o plegado en `FlowGraphBuilder` (Nivel 3+)
- **Problema:** `FLOW_MAX_STEPS = 40` truncaba funciones orquestadoras largas con `… (límite de pasos alcanzado)`, ocultando pasos críticos al final de la función.
- **Implementación y decisiones de diseño:**
  - `codemap/parsers/common.py`: límite unificado `FLOW_MAX_STEPS = 96` (importado por ambos parsers) y umbral `FLOW_COMPACT_MIN_RUN = 3` con `format_compacted_step_label()`.
  - `js_parser.py` y `python_parser.py`: en `walk_flow_block()`, secuencias contiguas de $\ge 3$ sentencias simples (declaraciones/asignaciones puras o consultas/operaciones DOM triviales sin ramas, saltos, I/O ni llamadas a funciones internas) se compactan en un solo paso agrupado (separando bloques DOM de asignaciones generales), conservando el código completo multi-línea en `step.code` para su inspección.
