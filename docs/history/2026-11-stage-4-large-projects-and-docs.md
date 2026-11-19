# Etapa 4 — Escalabilidad Visual II (Proyectos Grandes) y Documentación

**Fecha:** 2026-11-19  
**Estado:** ✅ Completada y validada (30/30 pruebas unitarias OK, `node --check` OK y verificación extremo a extremo en navegador con 0 errores de consola)

---

## 1. Escalabilidad (2/5) — Exploración por Vecindad (`N-hops` Drill-Down)

- **Umbral compartido (`codemap/graph_builder.py`):**
  - Se expuso `meta.large_project_threshold = LARGE_PROJECT_FUNCTIONS` (`25`) en `graph.json`.
- **Filtrado progresivo `N-hops` en el Visor (`codemap/viewer/index.html`, `styles.css`, `app.js`):**
  - `computeNHopsSubgraph()` ejecuta BFS acotado bidireccional sobre `state.rawGraph.edges` (respetando utilitarios ocultos salvo anclas) e integra el resultado en el pipeline `computeSubgraphFilter()` introducido en la Etapa 3.
  - **Activación automática en proyectos grandes:** Al entrar en **Nivel 3 (Funciones)** cuando `total_functions > large_project_threshold` (sin hilo activo), activa automáticamente `1 hop` bidireccional alrededor de la selección o de `meta.main_entry_functions` en lugar de desplegar cientos de funciones de golpe.
  - **Controles interactivos (`#nhops-hud` + Inspector `#btn-explore-nhops`):** Botones `← +1` (callers), `+1 →` (callees), presets `1 hop` / `2 hops`, `Mostrar todo (N)` y activación manual desde cualquier nodo en proyectos de cualquier tamaño; salida rápida con `Esc`.

---

## 2. Escalabilidad (5/5) — Capas Topológicas Automáticas (*Architectural Slicing*)

- **Cálculo topológico resistente a ciclos (`compute_architectural_layers()` en `codemap/graph_builder.py`):**
  - Implementa **Tarjan SCC iterativo** (`_tarjan_scc()`) y condensación en DAG (`_condense_dag_depths()`) excluyendo aristas de retorno `reactive_trigger` para evitar falsos ciclos Observer/Pub-Sub.
  - Estratifica cada archivo y función en **4 capas semánticas deterministas** (`arch_layer: 0..3`, expuestas además en `meta.architectural_layers` y preservadas en `codemap/exporter.py` sin podar el valor `0`):
    - `0` — **Entradas / UI**
    - `1` — **Orquestadores**
    - `2` — **Servicios / Estado**
    - `3` — **Utilidades / Persistencia**
- **Modo de agrupación en el Visor (`Carpetas` | `Capas de Flujo`):**
  - Conmutador `#btn-group-folders` / `#btn-group-layers` en la barra superior (`setGroupingMode()`).
  - `buildLayerModeElements()` sustituye los módulos por contenedores sintéticos `layer::0..3` con acentos visuales diferenciados por capa: colapsados en N1, agrupando archivos en N2 y agrupando funciones (con prefijo de archivo `archivo :: fn()`) en N3/N3+.
  - `buildElkInput()` activa `"elk.partitioning.activate": "true"` y `"elk.partitioning.partition": "<0..3>"` por capa, garantizando un flujo estrictamente unidireccional de arriba hacia abajo incluso ante aristas de retorno.
  - Aislamiento completo de anclajes `pinned_positions` bajo claves `"layers_*"` en `notes.json`.

---

## 3. Sincronización de Documentación e Higiene Final

- **`README.md`:** Actualizado integralmente con soporte HTML, la escala definitiva de 4 niveles (`N1–N3+`), `codemap export` (`json`/`md`), Hilos de Ejecución + Aislamiento real, Enrutamiento ortogonal ELKjs, Aristas bajo demanda, `N-hops`, Capas de Flujo, Ventanas Flotantes Anidadas y tabla completa de atajos.
- **`BACKLOG.md`:** Limpiado de todos los ítems resueltos del Ciclo 2 (repositorio libre de archivos temporales).

---

## 4. Validación

- Nuevas pruebas en `tests/test_stage4.py` (arquitectura lineal 4 capas, ciclos mutuos + Observer/Pub-Sub con Tarjan SCC, `examples/multi` + preservación de `arch_layer: 0` en `exporter.py`, controles del visor y test headless de particionamiento monotónico con `elk.bundled.js`).
- `.venv\Scripts\python.exe -m unittest discover -s tests -v`: **30/30 OK**; `node --check codemap/viewer/app.js`: **exit 0**.
- Verificación interactiva en navegador sobre proyecto sintético de **32 funciones / 30 aristas** (`http://127.0.0.1:53466`, **0 errores de consola**): apertura en N1, disparo automático de `N-hops` al pasar a N3 (`4/32 fns → 10/32 fns → 32/32 fns`), `N-hops` manual desde Inspector + `Esc`, y **Capas de Flujo** en N1, N2 y N3 con las 4 capas apiladas verticalmente en orden estricto `0 → 1 → 2 → 3`.
