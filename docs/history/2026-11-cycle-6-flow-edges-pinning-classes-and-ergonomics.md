# Ciclo 6 — Corrección de Aristas en Nivel 3+, Anclaje por Ámbito, Clases y Ergonomía del Visor

**Fecha:** 2026-11-24  
**Estado:** ✅ Completado y validado (69/69 pruebas unitarias y headless OK, `node --check` OK y verificación visual/interactiva en navegador sobre `examples/multi` y `codemap/parsers/python_parser.py` con 0 errores de consola)

---

## Motivación

Al inspeccionar proyectos reales en profundidad aparecieron dos fallos críticos y tres cuellos de botella de ergonomía:
1. En `Nivel 3+: Intra-función` (tanto inline como en ventanas flotantes), Cytoscape 3.30.2 marcaba `rscratch.badLine = true` en aristas `.elk-routed` (haciéndolas 100 % invisibles) por desalineación entre las dimensiones pasadas a ELK y el `outerWidth`/`outerHeight` real en Cytoscape (especialmente `+46 px` de padding oculto en rombos `round-diamond`), por incluir `startPoint`/`endPoint` dentro de `segpts`, por despojar `.elk-routed` en extremos `flowContainer` y por recálculo perezoso de `updateCompoundBounds()` dentro de `cy.batch()`.
2. Arrastrar un contenedor fijaba individualmente a todos sus hijos en `notes.json` y destruía `.elk-routed` incluso en aristas internas, mientras que los pasos `flow` en Nivel 3+ no podían fijarse y `reconcile_notes()` habría expulsado claves `fn::step` y `layer::*` a `orphans`.
3. Al inspeccionar constructores y métodos faltaba el contexto de clase (herencia, docstring y rol `CONSTRUCTOR`/`MÉTODO`), Python ocultaba `__init__` por defecto, las acciones del Inspector ocupaban excesiva altura sin liberación selectiva de pines, y la vista dividida `Flujo y código` carecía de divisor manual, ajuste de líneas (`Word Wrap`) y zoom de fuente.

---

## Cambios Implementados

### Fase 6.1 — Trazado ortogonal y visibilidad de aristas en `Nivel 3+` (`codemap/viewer/app.js`)
- **Alineación exacta ELK ↔ Cytoscape:** `estimateFlowStepSize()` calcula dimensiones interiores (`nodeWidth`/`nodeHeight`) y exteriores exactas (`elkWidth`/`elkHeight`, con medición 2D canvas cacheada en navegador), `padding: 0` en rombos `decision` de flujo y espaciado intra-función ampliado (`nodeNodeBetweenLayers: "44"`, `spacing.nodeNode: "28"`, `spacing.edgeNode: "18"`, `spacing.edgeEdge: "14"`).
- **Propiedad LCA y `staggerMeta`:** En `buildElkInput()` y `buildCreationElkInput()`, cada arista `kind === "flow"` se inserta en su contenedor ELK LCA exacto (`flowContainer`, `expandedFn` o `root`). `adjustElkSectionPoints()` añade fallback a `containerBaseShiftY` para extremos de contenedor en `Creación (1→N)`.
- **Eliminación de `badLine` y visibilidad:** Regla `edge.elk-routed[srcEndpoint][tgtEndpoint]` con `"edge-distances": "endpoints"`; `applyElkEdgeRoutes()` fuerza `cy.nodes(":parent").updateCompoundBounds(true)` (crucial para contenedores anidados dentro de `cy.batch()`), proyecta extremos al perímetro real (`round-diamond` inclinado, `ellipse`, rectángulos y compuestos), envía solo puntos estrictamente interiores (o punto medio en rectas de 2 puntos), conserva `.elk-routed` en `flowContainer`/`expandedFn` y aplica alto contraste (`#94a3b8`, `width: 1.8`, `z-compound-depth: "top"`) junto a `.compound-incident`.

### Fase 6.2 — Anclaje estricto por ámbito, Nivel 3+ y recálculo local (`codemap/notes_storage.py`, `codemap/viewer/app.js`)
- **Protección en `notes_storage.py`:** `reconcile_notes()` valida claves `fn::step` desde `internal_flow` y contenedores `layer::*`, migra automáticamente `old_fn::step` → `new_fn::step` al renombrar funciones por `fingerprint` AST y descarta pasos solo-pin obsoletos sin ensuciar `orphans` (conservando en `orphans` aquellos con nota o rol humano).
- **Anclaje sin contaminar hijos:** `grab`/`drag`/`dragfree` agrupado en microtask (`handleNodeDragFreeBatch` + `filterOutermostDraggedNodes`) persiste únicamente el ancestro más externo arrastrado (`module`, `file`, `layer`, `expandedFn`, `flowContainer` o paso `flow` en `intra`/`creation_intra`), y habilita `#btn-pin-node` en contenedores compuestos. `applyScopedPinsToLayout()` aplica contenedores fijados top-down como bloques rígidos `(dx, dy)` antes que hojas individuales.
- **Recálculo local no destructivo (`rerouteExternalEdgesLocally`):** Conserva intactas las aristas internas `.elk-routed` y re-enruta localmente (< 2 ms) únicamente las aristas externas con evasión de obstáculos, carriles paralelos de `±7 px` y soporte `taxiDir: "leftward"`.

### Fase 6.3 — Contexto completo de Clases y visibilidad de `__init__` (`models.py`, `python_parser.py`, `js_parser.py`, `graph_builder.py`, `exporter.py`, `viewer/*`)
- Añadidos `ClassInfo` (`qualname`, `short_name`, `bases`, `implements`, `is_abstract`, `docstring`, `line`, `end_line`) en `models.py` y `FunctionInfo.is_constructor`.
- Extracción AST en `python_parser.py` (bases, genéricos, `metaclass`, `ABC`, decoradores, docstring) y `js_parser.py` (`class_declaration`, `abstract_class_declaration`, expresiones `const Foo = class extends Bar {}`, `extends`/`implements` TS, JSDoc protegido contra robo de archivo).
- `__init__` visible por defecto en Python (`is_private()` mantiene ocultos `_helper`, resto de *dunders* y `#privado` salvo `--include-private`).
- Serialización sin duplicación (`file.classes`, `fn.class_name`, `fn.is_constructor`) en `graph_builder.py` y `exporter.py` (JSON y Markdown IA).
- Renderizado en Inspector: insignias **`CONSTRUCTOR`** / **`MÉTODO`**, subtítulo clicable a VS Code (`#detail-class-context`) y bloque dedicado **`Docstring de la clase`** (`#detail-class-docstring-block`).

### Fase 6.4 — Grilla 3×2 del Inspector, `Liberar fijados` selectivo y lectura en ventanas flotantes (`index.html`, `styles.css`, `app.js`)
- `.details-actions` reorganizado en grilla estricta **3 filas × 2 botones**; `#btn-isolate-file` (`🎯 Aislar archivo`) movido como píldora contextual compacta en `.details-header-top` (visible únicamente al seleccionar archivos en proyectos multi-archivo).
- **`Liberar fijados (N)`** (`collectScopedPinnedNodeIds` + `releaseScopedPinnedNodes`) estrictamente contextual para el nodo seleccionado o multi-selección `Shift`/`Ctrl` y su subárbol directo, sincronizado en vivo con `select`/`unselect` y persistido en un único `POST /notes.json`.
- **Divisor manual (`.fw-split-resizer`)** arrastrable en `Flujo y código` (mínimo `180 px` por panel, doble clic restaura 50/50, `win.cy.resize()` en `requestAnimationFrame` y limpieza en `closeFloatingWindow()`).
- **Controles de lectura en `.fw-code-toolbar`:** toggle **`Ajustar líneas`** (`.wrap-enabled` sobrescribiendo `min-width: 0; width: 100%` sobre `.fw-code-lines`) y zoom de fuente **`A− / 12px / A+`** (`10px..22px` vía `--fw-code-font-size`), persistidos en `localStorage` y sincronizados entre ventanas flotantes.

---

## Validación Final

- Nuevas suites: [test_cycle6_phase1.py](file:///e:/all_projects/guided_ia_proj/codemap/tests/test_cycle6_phase1.py), [test_cycle6_phase2.py](file:///e:/all_projects/guided_ia_proj/codemap/tests/test_cycle6_phase2.py) y [test_cycle6_phase3_4.py](file:///e:/all_projects/guided_ia_proj/codemap/tests/test_cycle6_phase3_4.py).
- `.venv\Scripts\python.exe -m unittest discover -s tests -v`: **69/69 pruebas OK** (`22.54s`).
- `node --check codemap/viewer/app.js`: **exit 0**.
- Verificación interactiva en navegador con **0 errores de consola** sobre `examples/multi` y `codemap/parsers/python_parser.py`: Nivel 3+ en `↓ Ejecución`, `Creación (1→N)` y ventanas flotantes; arrastre de contenedores sin contaminar hijos + persistencia en `notes.json` de pasos `flow`; visibilidad por defecto de `UserService.__init__()` con `CONSTRUCTOR` y `Store.add()` con `MÉTODO`; grilla 3×2 + píldora `🎯 Aislar archivo` + `Liberar fijados (1)` contextual; divisor `.fw-split-resizer`, `Ajustar líneas` y zoom `10–22px` persistido en `localStorage`.
