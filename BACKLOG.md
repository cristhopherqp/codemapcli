# Pending & Technical Debt

*The suggested actions are only possible standard steps to take, not the exact root cause of the problem. You should take them into account, but if the issue lies elsewhere, you must find the root cause and fix it.*

> **Principio transversal:** Todas las funcionalidades activas deben mantener **cero intrusión** sobre los repositorios analizados (sin crear ni modificar archivos en el proyecto objetivo; toda persistencia vive en `~/.codemap/<hash>/` o `~/.codemap/`) y operar de forma **100 % estática** sobre `tree-sitter`, `graph.json`, Cytoscape.js/ELKjs y `GET /source`.

---

## Improvements & Refactoring

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