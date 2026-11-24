# Pending & Technical Debt

*The suggested actions are only possible standard steps to take, not the exact root cause of the problem. You should take them into account, but if the issue lies elsewhere, you must find the root cause and fix it.*

> **Principio transversal:** Todas las funcionalidades activas deben mantener **cero intrusión** sobre los repositorios analizados (sin crear ni modificar archivos en el proyecto objetivo; toda persistencia vive en `~/.codemap/<hash>/` o `~/.codemap/`) y operar de forma **100 % estática** sobre `tree-sitter`, `graph.json`, Cytoscape.js/ELKjs y `GET /source`.

---

## Improvements & Refactoring

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