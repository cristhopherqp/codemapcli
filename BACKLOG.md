# Pending & Technical Debt

*The suggested actions are only possible standard steps to take, not the exact root cause of the problem. You should take them into account, but if the issue lies elsewhere, you must find the root cause and fix it.*

> **Principio transversal:** Todas las funcionalidades activas deben mantener **cero intrusión** sobre los repositorios analizados (sin crear ni modificar archivos en el proyecto objetivo; toda persistencia vive en `~/.codemap/<hash>/` o `~/.codemap/`) y operar de forma **100 % estática** sobre `tree-sitter`, `graph.json`, Cytoscape.js/ELKjs y `GET /source`.

---

## Critical Fixes (Bugs)

- [ ] **Trazado de aristas roto o invisible en `Nivel 3+: Intra-función` (lienzo principal y ventana flotante):**
  - *Problema:* Al visualizar el flujo interno de una función (tanto expandido inline en Nivel 3+ como dentro de ventanas flotantes de función), las flechas entre pasos (`type === "flow"`) se trazan de forma errónea, se desvían o directamente no llegan a verse.
  - *Causas probables a investigar y corregir:*
    - Verificar el alcance de las aristas de flujo en `buildElkInput()` / `buildCreationElkInput()` y `runSubElkLayout()` (`codemap/viewer/app.js`): colocar aristas internas en el contenedor propietario correcto (`expandedFn` / `flowContainer`) y validar `containerOffsets` al proyectar `sections` hacia `convertElkPointsToCytoscapeSegments()`, especialmente cuando coexisten con `SEPARATE_CHILDREN` en modo `Creación (1→N)`.
    - Revisar aristas que entran o salen de sub-contenedores compuestos (`flowContainer === "true"`, como bucles `🔁` o hooks `⚡`) donde `srcNode.isParent() || tgtNode.isParent()` hoy descarta `.elk-routed` o genera colisiones de coordenadas.
    - Asegurar visibilidad y contraste en `buildStylesheet()` (`z-compound-depth: "top"`, contraste de `edge[kind = "flow"]` sobre fondos `#142030` / `#101b2d` y comportamiento de `edge-distances` entre pasos cortos).

- [ ] **Anclaje por ámbito real al arrastrar contenedores, persistencia en Nivel 3+ y recálculo selectivo de aristas:**
  - *Problema:*
    1. Al arrastrar un contenedor (`file`, `module` o `function` expandida en Nivel 3/3+) aunque sea ligeramente, `handleNodeDragFree()` fija individualmente a todos sus nodos hijos en `notes.json` y borra `.elk-routed` de todas sus aristas (incluso las internas), provocando que el contenido interno se desordene al re-renderizar o recargar.
    2. En `Nivel 3+: Intra-función`, mover pasos de flujo (`type === "flow"`) o bloques internos no fija su posición al soltarlos.
  - *Solución técnica sugerida (coherente en todos los niveles: Módulos, Archivos, Funciones e Intra-función):*
    - **Anclaje estricto por ámbito (sin contaminar hijos):**
      - Arrastrar un **módulo** o **archivo** fija únicamente el desplazamiento/posición de ese contenedor (trasladando su contenido interno como bloque rígido `(dx, dy)` sin marcar como `pinned` a sus archivos ni funciones hijas).
      - Arrastrar una **función** fija únicamente esa función (sin fijar los pasos internos de su flujo 3+ si está expandida).
      - Arrastrar un **paso de flujo (`type === "flow"`)** en Nivel 3+ (lienzo principal y/o estado de posición por contexto `intra`) sí persiste su posición fijada en `notes.json` (`VALID_LAYOUT_LEVELS` / `notes_storage.py`).
    - **Recálculo local y no destructivo de aristas:**
      - Conservar intactas las rutas `.elk-routed` de todas las aristas *internas* a un contenedor trasladado en bloque (al compartir el mismo `(dx, dy)`, `segment-weights` y `segment-distances` son invariantes).
      - Recalcular/re-enrutar **únicamente las aristas externas incidentes** al nodo o contenedor movido (mediante enrutado ortogonal local / `taxi` direccional ajustado o recálculo focalizado al soltar el arrastre), sin ejecutar un relayout global que mueva el resto del grafo.

---

## Improvements & Refactoring

### Lote 1 — Ergonomía del Inspector, Clases y Ventanas Flotantes

- [ ] **Contexto completo de Clases en parsers e Inspector (herencia, docstring y rol constructor/método):**
  - *Problema:* Al seleccionar un constructor o método (p. ej. `ConfigError.constructor()` de `export class ConfigError extends Error`), el Inspector solo muestra `Transformación`, `FIN` y el nombre `ConfigError.constructor()`, sin indicar claramente que pertenece a una clase, de qué hereda ni mostrar el docstring explicativo de la clase.
  - *Solución técnica sugerida:*
    - Añadir `ClassInfo` (`qualname`, `short_name`, `bases`, `docstring`, `line`, `end_line`) en `codemap/models.py` y extraerlo en `codemap/parsers/python_parser.py` y `codemap/parsers/js_parser.py` (incluyendo `extends` en JS/TS, clases base en Python y el docstring/JSDoc propio de la clase).
    - Exponer el mapa/resumen de clases por archivo en `codemap/graph_builder.py` (evitando duplicar el docstring de clase en cada método) y marcar `is_constructor` / `class_name` en los nodos de función correspondientes.
    - En el Inspector (`codemap/viewer/app.js`, `index.html`, `styles.css`), al seleccionar un constructor o método: mostrar una insignia clara (`CONSTRUCTOR` o `MÉTODO`), indicar la clase y su herencia (`class ConfigError extends Error`) junto al encabezado, y renderizar un bloque dedicado con el **Docstring de la clase** antes o junto al docstring del método.

- [ ] **Reorganización de acciones del Inspector (3 filas) y liberación selectiva de posiciones fijadas:**
  - *Problema:* Los botones de acción del Inspector ocupan demasiada altura vertical, algunos textos se comprimen y no existe una forma rápida de liberar posiciones fijadas únicamente para la selección actual sin reiniciar todo el grafo.
  - *Solución técnica sugerida:*
    - Reorganizar `.details-actions` en `codemap/viewer/index.html`, `styles.css` y `app.js` en **3 filas de 2 botones** con textos concisos que encajen holgadamente:
      1. **Fila 1:** `Expandir flujo` / `Ocultar flujo` (o `Expandir` / `Colapsar` en contenedores) **|** `Abrir en ventana`
      2. **Fila 2:** `Fijar posición` / `Liberar posición` **|** `Liberar fijados` (ámbito selectivo)
      3. **Fila 3:** `Explorar vecindad` **|** `Abrir en VS Code`
    - Implementar el botón **`Liberar fijados`** con alcance estrictamente contextual (nunca global sobre todo el repositorio):
      - Si hay **multi-selección** en Cytoscape (`Shift` o `Ctrl` + clic / selección de caja, `cy.nodes(":selected").length > 1`), libera las posiciones fijadas de esos nodos seleccionados (y sus descendientes si incluye contenedores) en el contexto de layout activo.
      - Si hay un único nodo seleccionado (`module`, `file`, `function` o sección/capa), libera las posiciones fijadas pertenecientes únicamente a ese nodo y su subárbol directo en el contexto activo, actualizando `notes.json` en una sola petición y re-enrutando solo el ámbito afectado.

- [ ] **Divisor redimensionable manual y controles de lectura (`Word Wrap` + Zoom de fuente) en ventana flotante de código:**
  - *Problema:* En la vista dividida `Flujo y código` de las ventanas flotantes no es posible ajustar manualmente el ancho entre ambos paneles; además, en `Solo código` y `Flujo y código` faltan controles para alternar ajuste de líneas (`wrap`) y variar el tamaño de letra del código.
  - *Solución técnica sugerida:*
    - Añadir una barra divisoria vertical arrastrable (`.fw-split-resizer`) dentro de `.fw-body.mode-split` (`app.js`, `styles.css`) para ajustar libremente la proporción entre el subgrafo Cytoscape y `.fw-code-pane` (con límites mínimos seguros y llamando `win.cy.resize()` en tiempo real).
    - Incorporar en la barra superior de `.fw-code-pane` (visible en `Solo código` y `Flujo y código`):
      - Botón toggle **`Ajustar líneas` (Word Wrap)** que alterne entre ajuste al ancho disponible (`white-space: pre-wrap; overflow-wrap: anywhere`) y desplazamiento horizontal (`white-space: pre; overflow-x: auto`).
      - Controles de tamaño de fuente (**`A−`**, indicador numérico, **`A+`**, acotados p. ej. entre `10px` y `22px`, recordando la preferencia en el navegador vía `localStorage`).

---

### Lote 2 — Variables y Constantes Top-Level (Nivel de Archivo)

- [ ] **Detección y visualización opcional de Variables y Constantes a nivel de archivo (Top-Level):**
  - *Objetivo:* Hacer visibles el estado compartido, constantes de configuración, rutas base y tablas declarativas de reglas dentro de un archivo sin saturar el grafo.
  - *Alcance y criterios:*
    - **Incluir:** Únicamente declaraciones ubicadas en la raíz del archivo (constantes, objetos/tablas de configuración, variables top-level que no sean funciones).
    - **Excluir:** Declaraciones `import`/`require` y variables locales internas de cada función.
  - *Solución técnica sugerida:*
    - **Backend (`models.py`, `python_parser.py`, `js_parser.py`, `resolver.py`, `graph_builder.py`, `exporter.py`):**
      - Extraer `VariableInfo` (`qualname`, `short_name`, `kind`, `line`, `end_line`, `value_preview`, `docstring`) y detectar referencias de lectura/uso desde funciones (respetando sombreado de parámetros y variables locales) para generar aristas sutiles (`edge_type: "reads_var"` / `"uses_var"`).
      - Serializar nodos `type: "variable"` en `graph.json` ordenados por `line` (compatibles con `Orden: Creación (1→N)` y la lista del archivo).
    - **Frontend (`app.js`, `index.html`, `styles.css`):**
      - Representación visual compacta y diferenciada de las funciones (p. ej. estilo pastilla con borde punteado) conectada con aristas discretas hacia las funciones consumidoras.
      - Botón toggle en la barra lateral izquierda (`Mostrar/Ocultar constantes`) para activarlos o esconderlos al vuelo, plenamente integrados con el Inspector (vista previa/código vía `GET /source`, docstring y nota personal) y el tooltip flotante de `1 s`.

---

### Lote 3 — Recorrido Visual Estático (*Static Walkthrough* / Debug Visual)

- [ ] **Reproductor de Recorrido Visual Estático con partícula "Chispa", Call Stack simulado y contrato desacoplado:**
  - *Objetivo:* Animar el viaje del control y los datos a través del grafo y del código línea por línea de forma 100 % estática (sin ejecutar el proyecto analizado).
  - *Arquitectura y contrato de eventos:*
    - Definir un formato estándar desacoplado de secuencia de pasos (`{ seq, kind, from, to, fn_id, step_id, edge_id, line, end_line, label, branch_kind, ... }`) que hoy produzca un generador estático a partir de `graph.json` (`edges`, `execution_flows`, `internal_flow`, `line`), pero que el reproductor consuma de forma agnóstica para soportar trazas dinámicas reales en el futuro sin reescribir la UI.
  - *Motor visual de partículas (`<canvas>` superpuesto):*
    - Superponer un `<canvas>` transparente (`pointer-events: none`) sincronizado con `cy.pan()`, `cy.zoom()` y `requestAnimationFrame` sin crear nodos temporales ni provocar recálculos de ELKjs.
    - Interpolar la posición de la partícula sobre la polilínea ortogonal exacta de las aristas (`.elk-routed` `segments` / `taxi`), respetando sus ángulos de 90°.
  - *Semántica de movimiento y ramificaciones:*
    - **Llamada (`call`):** Chispa de ida (cian) desde la función llamadora hacia la invocada.
    - **Retorno (`return`):** Chispa de vuelta (verde o ámbar) regresando desde la invocada hacia la llamadora para reflejar el desapilado antes de avanzar a la siguiente sentencia.
    - **Ramas condicionales y error (`if` / `switch` / `throw` / `try-catch`):** Seguir el camino principal por defecto emitiendo un destello rojo breve hacia las ramas de error/guardas evaluadas, con control interactivo para alternar manualmente hacia una rama alternativa o simular el camino de excepción.
  - *Controles y dos modos de reproducción:*
    - Barra compacta flotante: `Play / Pause`, `← Paso atrás`, `→ Paso adelante`, selector de velocidad ("ciclos de reloj") y toggle `Profundizar en hijas` (*Step Into / Step Over*).
    - **Modo Pulso (Nivel 3):** Saltos de función a función a ritmo constante + vista de **Call Stack simulado** en el Inspector que apila y desapila funciones activas en vivo.
    - **Modo Paso a Paso (Nivel 3+):** Avance instrucción por instrucción sincronizado con el visor de código (`GET /source`) + tarjeta flotante breve junto al nodo activo resumiendo la acción actual (asignación, comprobación, llamada o retorno).

---

### Lote 4 — Fichas Vivas de Vocabulario Técnico ("Anki en vivo")

- [ ] **Micro-diccionario estático de sintaxis/SO, contratos `Entrada → Salida` y glosario progresivo que se desvanece:**
  - *Objetivo:* Reducir la fricción al leer operadores, métodos nativos o códigos del sistema poco familiares durante la inspección, ocultando progresivamente lo que el usuario ya domina a nivel global.
  - *Solución técnica sugerida:*
    - **Micro-diccionario estático empaquetado (`codemap/vocab_dictionary.json` + extracción AST en parsers):**
      - Incluir un diccionario JSON ligero (sin IA ni ejecución) con descripciones concisas de **Entrada → Salida** (qué recibe, qué transforma y qué devuelve en una frase sencilla) para:
        - Modismos y operadores AST frecuentes de JS/TS y Python (`?.`, `??`, `await`, desestructuración, spread `...`, comprensiones, decoradores, etc.).
        - Métodos estándar frecuentes (enriqueciendo las entradas de `external_calls`).
        - Códigos de error POSIX y literales de control habituales (`ENOENT`, `EACCES`, `ECONNREFUSED`, `'\0'`, etc.).
    - **Enriquecimiento del Inventario Global (`known_apis_storage.py`, `notes_storage.py`):**
      - Reutilizar `~/.codemap/known_apis.json` para persistir el estado aprendido/pendiente tanto de APIs como de conceptos de sintaxis/SO, preservando retrocompatibilidad con entradas existentes.
      - Permitir guardar notas/explicaciones personales asociadas a una línea concreta en `~/.codemap/<hash>/notes.json` (análogo a las notas por nodo, sin tocar el repositorio analizado).
    - **Glosario progresivo en el visor (`app.js`, `styles.css`):**
      - Al inspeccionar una línea en **Modo Paso a Paso** o en la vista dividida **Flujo y código**, mostrar micro-tarjetas únicamente para los elementos de esa línea aún marcados como **pendientes**.
      - Incluir en cada tarjeta el botón **`✓ Ya la sé`** (marca el concepto globalmente y lo desvanece en el proyecto actual y futuros) y acceso rápido a editar la nota personal de esa línea.

---

## Under Observation & Edge Cases

- [ ] **[HORIZONTE FUTURO — NO IMPLEMENTAR EN ESTA ITERACIÓN] Trazado Dinámico, RAM y Call Stack Real (`codemap trace`):**
  - *Estado:* Documentado exclusivamente como referencia arquitectónica para garantizar que el contrato de eventos del *Recorrido Visual Estático* (Lote 3) nazca 100 % compatible con trazas reales. **No diseñar ni codificar todavía.**
  - *Definición prevista para fase futura:*
    - **Activación Opt-in explícita:** Subcomando dedicado `codemap trace <ruta> -- <comando>` con advertencia explícita de que el código objetivo sí se ejecutará (con posibles efectos en disco o red).
    - **Record & Replay sin tocar el repositorio:** Lanzador externo que graba la ejecución en `~/.codemap/<hash>/traces/<timestamp>.trace.json` para reproducción *Time-Travel* (adelante/atrás) sobre el mismo reproductor visual del Lote 3:
      - *Python:* `sys.monitoring` (PEP 669 en Python 3.12+, fallback `sys.settrace` en 3.11), filtrando eventos fuera del directorio del proyecto.
      - *Node.js / JS / TS:* V8 Inspector Protocol (CDP) en loopback estricto (`127.0.0.1`), blackboxing de `node_modules` y soporte de pilas `async/await`.
    - **Capacidades adicionales sobre el visor:** Valores reales de variables en RAM con resaltado *diff* por paso, Call Stack real, ramas realmente ejecutadas, excepciones reales y tiempos en microsegundos.
    - **Salvaguardas obligatorias:** Serialización acotada (profundidad máxima, truncado de strings, límite de ítems y protección anti-ciclos), redacción automática de secretos (`token`, `secret`, `password`, `api_key` → `"[REDACTED]"`) antes de escribir en disco, y búfer circular con tope de eventos contra bucles infinitos.

- [ ] **Higiene de repositorio e historial de deuda técnica:** Mantener `BACKLOG.md` únicamente con ítems activos y archivar cada lote completado en `docs/history/` para minimizar consumo de contexto en sesiones con agentes.