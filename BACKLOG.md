# CodeMap — Plan de Mejoras y Correcciones (Backlog Técnico Depurado)

---

## Estado de Fases

- **Fase 1 (Parser AST, Resolver y Graph Builder):** ✅ Completada — todos los ítems de análisis estático, resolución de alias/callbacks/top-level/HTML, semántica de aristas, cálculo determinista de `execution_flows` y compactación/límite de `FlowGraphBuilder` (Nivel 3+) están implementados y verificados con pruebas unitarias (`tests/test_phase1.py`).
- **Fase 2 (Visor Web, Layout y UX):** Pendiente — consumo visual de `edge_type`, `entry_kind`, `execution_flows`, filtro anti-maraña, navegación en Modo Foco, ventanas flotantes y exportación de capturas.

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

### 1.5. [✅ Backend Fase 1 / ⏳ UI Fase 2] Semántica de aristas y flujos invertidos (Patrón Observer / Pub-Sub)
- **Resuelto en Fase 1 (`models.py`, `resolver.py`, `graph_builder.py`):**
  - Todas las aristas en `graph.json` preservan los campos actuales (`id`, `source`, `target`, `confidence`, `call_count`, `line`) y añaden `edge_type` (`"direct_call"`, `"event_listener"`, `"callback_ref"`, `"reactive_subscribe"`, `"reactive_trigger"`, `"loads_script"`, `"serves_html"`), más `event` (evento/ruta) y `edge_types` cuando coexisten múltiples semánticas entre el mismo par.
  - `resolve_reactive_triggers()` deduce automáticamente la dirección reactiva de disparo (`notificador -> suscriptor`, `edge_type: "reactive_trigger"`, `confidence: "inferred"`) tanto para referencias directas (`subscribeState(updateUI)`) como para callbacks inline (`subscribeState(() => updateUI())`).
- **Pendiente para Fase 2 (`codemap/viewer/app.js`):**
  - Mostrar en el visor (mediante icono, estilo de línea o color de flecha) la semántica de `edge_type` y la etiqueta `event`.

### 1.6. [✅ Resuelto — Fase 1] Falsos paquetes npm en alias de rutas (`@/...`) y `.gitignore` anidados
- **Resolución de alias JS/TS (`resolver.py`, `graph_builder.py`):**
  - Lectura de `tsconfig.json` / `jsconfig.json` más cercanos (subiendo hasta `root_dir`, ideal para monorepos), con parser JSONC (comentarios `//`, `/* */` y comas colgantes), herencia `"extends"`, `compilerOptions.paths` (con orden por especificidad de comodines) y `compilerOptions.baseUrl`.
  - Respaldo automático para prefijos `@/`, `~/` y `/` contra la raíz del paquete, `src/`, `root_dir` y `public/`.
  - Guarda estricta en `classify_js_external()` y `npm_package_name()` (`is_js_local_alias()`): ningún alias (`@/...`, `~/...`, `/...`, `#...` ni rutas configuradas en `tsconfig.json`) genera enlaces rotos a `npmjs.com`, conservando paquetes con scope npm real (ej. `@tanstack/react-query`).
- **`.gitignore` anidados (`discovery.py`, `watcher.py`):**
  - Nueva clase `GitIgnoreMatcher` usando `pathspec.GitIgnoreSpec.check_file()` para evaluar jerárquicamente cada `.gitignore` relativo a su subdirectorio, respetando negaciones (`!`) en niveles inferiores y poda de directorios ancestros ignorados.
  - `codemap/watcher.py` integrado con `GitIgnoreMatcher` para recargar dinámicamente `.gitignore` anidados y reaccionar ante cambios en `tsconfig.json` / `jsconfig.json`.

---

## 2. Visualización de Hilos de Datos y Reducción de la "Maraña" (Viewer & Layout)

### 2.1. [✅ Cálculo en `graph.json` Fase 1 / ⏳ Selector UI Fase 2] Selector de Hilo Principal, Hilos Secundarios e Hilos por Feature
- **Resuelto en Fase 1 (`codemap/graph_builder.py`):**
  - Se precalcula determinísticamente la sección `execution_flows` en `graph.json` mediante DFS ordenado por línea y resistente a ciclos:
    1. **Hilos Principales (`kind: "main"`):** árboles de arranque desde servidor/HTML/lanzador/`main`/top-level (poda raíces subsumidas y evita engullir handlers de eventos de usuario o suscriptores diferidos).
    2. **Hilos por Feature / Evento / Ruta (`kind: "feature"`):** un hilo por cada handler de evento o ruta HTTP registrada, siguiendo `direct_call`, `callback_ref` y `reactive_trigger` (permitiendo trazar cambios de estado hasta el re-render de UI), con `steps` numerados `1 → 2 → 3` y `registered_by`.
- **Pendiente para Fase 2 (`codemap/viewer/app.js`, `codemap/viewer/index.html`):**
  - Añadir un desplegable **"Hilos de Ejecución"** en la barra superior del visor que permita iluminar el Hilo Principal o aislar cualquier Hilo por Feature (atenuando el resto del grafo y numerando el orden de ejecución `1 → 2 → 3`).

### 2.2. [Pendiente — Fase 2] Filtro Anti-Maraña para Nodos Utilitarios (Alto Fan-In / Leaf Helpers)
- **Problema:** Al expandir los archivos en Nivel 2, funciones utilitarias o de acceso a estado llamadas desde todas partes (`showToast`, `getImages`, `scheduleSaveSession`) generan decenas de flechas cruzadas que vuelven ilegible la gráfica.
- **Archivos a modificar:** `codemap/viewer/app.js`, `codemap/viewer/index.html`.
- **Solución técnica:**
  - Detectar automáticamente como **"Nodos Utilitarios / Transversales"** a las funciones hoja (`is_terminal: true` o sin salidas complejas) que reciban llamadas desde $\ge 3$ archivos o $\ge 5$ funciones distintas.
  - Añadir un botón toggle en el visor (**"Ocultar utilitarios / Reducir ruido"**) que oculte las aristas globales hacia esos nodos y, en su lugar, los muestre como una pequeña insignia dentro de las funciones que los usan.

### 2.3. [Pendiente — Fase 2] Navegación por teclado entre múltiples ramas en Modo Foco (`T`) y nodos `pinned`
- **Problema 1:** En `viewer/app.js`, `stepTrace("forward")` ordena `callees` alfabéticamente y salta siempre a `callees[0]`, impidiendo elegir con el teclado a cuál de las funciones llamadas entrar.
- **Problema 2:** En `runElkLayout()`, restaurar coordenadas absolutas `(x, y)` de nodos `pinned` de Nivel 2 rompe las cajas cuando se pasa a Nivel 3+.
- **Archivos a modificar:** `codemap/viewer/app.js`.
- **Solución técnica:**
  - En Modo Foco (`T`), permitir que `↑` / `↓` cambien la selección previa entre las distintas funciones llamadas (o llamadoras) resaltando la arista candidata, y que `→` / `Enter` confirme el salto hacia esa rama.
  - Guardar coordenadas `pinned` por nivel (`pinned_positions: { level_1, level_2 }`) o ignorar el anclaje de Nivel 2 cuando hay funciones expandidas en Nivel 3+.

---

## 3. Nuevas Funcionalidades de Exploración y Exportación (UX Avanzada)

### 3.1. [Pendiente — Fase 2/3] Expansión en Ventanas Flotantes Anidadas (Modales de Lienzo) con Puertos y Bloqueo Padre-Hijo
- **Problema:** Expandir un archivo (`state.js`) o el flujo interno de una función directamente sobre el grafo principal recalcula todo el layout con ELKjs y destruye la distribución visual que el usuario ya había comprendido.
- **Archivos a modificar:** `codemap/viewer/app.js`, `codemap/viewer/index.html`, `codemap/viewer/styles.css`.
- **Solución técnica:**
  - Permitir elegir (mediante clic derecho, botón en el inspector o `Alt + Doble clic`) **"Expandir en ventana flotante"** frente a **"Expandir en el lienzo"**.
  - Crear un gestor de ventanas flotantes arrastrables y redimensionables dentro del contenedor del visor, donde cada ventana renderiza su propio sub-grafo Cytoscape + ELKjs aislado (para un archivo o para el flujo Nivel 3+ de una función).
  - **Puertos de Frontera (Cross-Modal Connectors):** Cuando una función dentro de la ventana flotante de `state.js` llama a una función externa (ej. `storage.js::scheduleSaveSession`), dibujar dentro del modal un nodo conector compacto (`⇢ storage.js::scheduleSaveSession`). Al hacer clic en ese conector, abrir (o enfocar) la ventana flotante hija de `storage.js` resaltando el conector de entrada correspondiente (`⇠ state.js::notifyStateChange`).
  - **Jerarquía Padre → Hijo:** Registrar qué ventana flotante abrió a cuál (`parentModalId` / `childModalIds`). Bloquear el cierre individual de una ventana padre mientras tenga ventanas hijas abiertas (mostrando un aviso o un botón para cerrar la cadena hija en orden).

### 3.2. [Pendiente — Fase 2/3] Exportación de Capturas del Grafo (PNG / JPG / SVG)
- **Problema:** No existe una opción directa en la interfaz para exportar como imagen el mapa completo o únicamente el subgrafo que está en Modo Foco.
- **Archivos a modificar:** `codemap/viewer/app.js`, `codemap/viewer/index.html`.
- **Solución técnica:**
  - Aprovechar los métodos nativos de Cytoscape (`state.cy.png({ full, scale: 2, bg: '#0f141b' })` y `state.cy.jpg(...)`) para agregar un menú de exportación en la barra lateral: **"Exportar vista actual (PNG/JPG)"**, **"Exportar grafo completo"** y **"Exportar solo nodos en Foco"**.

### 3.3. [✅ Resuelto — Fase 1] Límite configurable o plegado en `FlowGraphBuilder` (Nivel 3+)
- **Problema:** `FLOW_MAX_STEPS = 40` truncaba funciones orquestadoras largas con `… (límite de pasos alcanzado)`, ocultando pasos críticos al final de la función.
- **Implementación y decisiones de diseño:**
  - `codemap/parsers/common.py`: límite unificado `FLOW_MAX_STEPS = 96` (importado por ambos parsers) y umbral `FLOW_COMPACT_MIN_RUN = 3` con `format_compacted_step_label()`.
  - `js_parser.py` y `python_parser.py`: en `walk_flow_block()`, secuencias contiguas de $\ge 3$ sentencias simples (declaraciones/asignaciones puras o consultas/operaciones DOM triviales sin ramas, saltos, I/O ni llamadas a funciones internas) se compactan en un solo paso agrupado (separando bloques DOM de asignaciones generales), conservando el código completo multi-línea en `step.code` para su inspección.
