# Ciclo 5 — Orden de Creación Estricto (`1→N`) en Todos los Niveles y Corredores Macro Cosidos

**Fecha:** 2026-11-22  
**Estado:** ✅ Completado y validado (59/59 pruebas unitarias OK, `node --check` OK y verificación visual/interactiva en navegador sobre `examples/multi` con 0 errores de consola/página)

---

## Motivación

En los ciclos 3–4, el modo `↑ Creación` invertía verticalmente ELK (`elk.direction: "UP"`), pero las capas verticales seguían gobernadas por la topología de llamadas (`NETWORK_SIMPLEX`) y el orden horizontal dentro de cada fila era reordenado por `LAYER_SWEEP` (además de que `considerModelOrder` no se heredaba a los contenedores `file`/`module` en `INCLUDE_CHILDREN`). En consecuencia, `↑ Creación` se veía casi como un espejo vertical de `↓ Ejecución` y no reflejaba el orden `1 → N` real de declaración mostrado en el Inspector de archivo.

---

## Cambios Implementados

1. **Motor de Orden de Creación estricto (`codemap/viewer/app.js`):**
   - **`assignCreationBands()`:** Agrupa funciones ordenadas por `line` ascendente en bandas adaptativas (`2` funciones si el archivo tiene `≤ 4`, `3` si tiene `≥ 5`), abriendo una nueva banda cuando se llena o cuando existe una arista intra-archivo con cualquier función de la banda actual. Garantiza matemáticamente 0 aristas intra-banda, impidiendo que ELK subdivida o invierta una banda.
   - **`buildCreationElkInput()`:** Usa `elk.direction: "DOWN"`, `elk.hierarchyHandling: "SEPARATE_CHILDREN"`, `elk.partitioning.activate: "true"`, `elk.separateConnectedComponents: "false"`, `elk.layered.crossingMinimization.forceNodeModelOrder: "true"` y márgenes laterales ampliados (`padding: [top=42,left=36,bottom=24,right=36]`) en contenedores `file` para carriles laterales ortogonales.
   - **Coherencia en todos los niveles (`computeModuleArchLayer`, `computeCreationPartition`, `computeIntraTierFoundationDepths`):**
     - **Nivel 1 (Módulos) y Nivel 2 (Archivos):** Partición `(3 - arch_layer) * 10 + depth` (cimientos/utilidades arriba → servicios/estado → orquestadores → entradas/UI abajo), ignorando archivos vacíos (como `__init__.py`) al calcular el `arch_layer` de un módulo.
     - **Nivel 3+ (`expandedFn`):** Las funciones expandidas inline conservan su banda exacta `1 → N` dentro del archivo mientras su subgrafo interno de pasos `flow` mantiene `DOWN` con `INCLUDE_CHILDREN` sin conflictos con `SEPARATE_CHILDREN`.
     - **Capas de Flujo (`layers`):** Orden invertido de arriba abajo `3 → 2 → 1 → 0` (Utilidades → Entradas).
   - **Corredores macro ELK cosidos con carriles paralelos acotados (`buildPostStaggerBoxes`, `stitchCrossFileEdgeOntoMacroCorridor`, `applyElkEdgeRoutes`):**
     - Proyecta aristas inter-archivo como aristas macro ortogonales en el ancestro común más cercano (LCA), orientadas `cimiento → consumidor`.
     - Cose cada arista inter-archivo sobre el tronco ortogonal calculado por ELK (usando los márgenes internos de `36 px` del archivo si otro nodo bloquea la vertical) y acota dinámicamente el desplazamiento de carriles paralelos (`±7 px`) al espacio real libre entre cajas adyacentes para evitar invasiones en proyectos densos.
     - Conserva `.elk-routed` tras el escalonamiento `+14px` (`applyCreationRowStagger` + `adjustElkSectionPoints` con desplazamiento de canales en extremos macro).

2. **Jerarquía visual y compatibilidad interactiva (`buildStylesheet`, `runSubElkLayout`, `toggleLayoutOrderMode`, `index.html`):**
   - Reglas Cytoscape para `edge.creation-cross-edge` (opacidad base `0.48`, grosor `1.5 px`) con restauración garantizada a `opacity: 1` y grosor completo sobre todos los selectores reales de interacción: `.edge-reveal-in`, `.edge-reveal-out`, `.edge-reveal-internal`, `.flow-active-edge`, `.trace-caller`, `.trace-callee`, `.trace-branch-active` y `:selected` (y `.dimmed` a `0.15`).
   - Ventanas flotantes de archivo/módulo en modo Creación: aplican bandas `1 → N` (`DOWN` + `+14px`), con `port_out` (dependencias externas) arriba y `port_in` (llamadores externos) abajo, y se relayoutan automáticamente al alternar el botón del header.
   - Botón toggle actualizado a **`Orden: Creación (1→N)`** (vs **`Orden: ↓ Ejecución`**) y documentación actualizada en `#help-modal` y `README.md`.

---

## Validación Final

- Nueva suite [test_cycle5_creation_order.py](file:///e:/all_projects/guided_ia_proj/codemap/tests/test_cycle5_creation_order.py) (4 casos) + actualización de [test_cycle3_phase3.py](file:///e:/all_projects/guided_ia_proj/codemap/tests/test_cycle3_phase3.py) y [test_cycle4_phase2.py](file:///e:/all_projects/guided_ia_proj/codemap/tests/test_cycle4_phase2.py):
  - `config.js` (10 funciones reales): orden exacto `1 → 10` (Y estrictamente creciente), `23/23` aristas ortogonales, `0` diagonales y `0` cruces sobre nodos.
  - `examples/multi` (Nivel 1, 2, 3, 3+ `expandedFn`, `Capas de Flujo` y Ventana Flotante `store.tsx`): `14/14` aristas enrutadas, `0` segmentos no ortogonales y `0` cruces sobre nodos hoja (frente a `17` con `taxi` ingenuo).
  - Stress test con `20` aristas paralelas en el mismo corredor: todos los carriles y márgenes internos estrictamente acotados sin invadir cajas vecinas.
  - Verificación headless en `cytoscape.min.js` de todos los selectores de `.creation-cross-edge`.
- `.venv\Scripts\python.exe -m unittest discover -s tests -v`: **59/59 pruebas OK**.
- `node --check codemap/viewer/app.js`: **exit 0**.
- Verificación visual/interactiva en navegador sobre `examples/multi` con **0 errores de consola y 0 errores de página** confirmando Nivel 1/2/3, corredores ortogonales limpios, `Aristas bajo demanda`, `Modo Foco (T)`, `Capas de Flujo (3→0)`, ventana flotante de `store.tsx` en bandas `1→5` y sincronización en vivo al alternar `Orden: ↓ Ejecución` / `Orden: Creación (1→N)`.
