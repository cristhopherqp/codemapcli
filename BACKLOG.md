# Pending & Technical Debt

*The suggested actions are only possible standard steps to take, not the exact root cause of the problem. You should take them into account, but if the issue lies elsewhere, you must find the root cause and fix it.*

## Critical Fixes (Bugs)
*(Sin bugs críticos pendientes en este ciclo.)*

## Improvements & Refactoring
- [ ] **Escalabilidad (1/5) — Aislamiento real de subgrafo en Hilos y Modo Foco:** Añadir un interruptor **"Aislar en lienzo"** en `codemap/viewer/index.html` y `codemap/viewer/app.js` cuando exista un `execution_flow` o Modo Foco (`T`) activo. En lugar de dejar los nodos `.dimmed` ocupando espacio en el canvas, filtrar `buildVisibleElements()` para pasar a `runElkLayout()` únicamente los nodos, contenedores ancestros y aristas del flujo activo, generando un árbol compacto y directo.
- [ ] **Escalabilidad (2/5) — Exploración por vecindad (`N-hops` Drill-Down):** Para proyectos medianos o grandes (superando `LARGE_PROJECT_FUNCTIONS` en `codemap/graph_builder.py`), evitar que el nivel de funciones despliegue todo el repositorio de golpe. Permitir expandir progresivamente `1` o `2` saltos hacia adelante (`callees`) o hacia atrás (`callers`) desde un nodo seleccionado, manteniendo colapsado o fuera de vista el resto del proyecto.
- [ ] **Escalabilidad (3/5) — Enrutamiento ortogonal de aristas en ELKjs (`ORTHOGONAL`):** Configurar `"elk.edgeRouting": "ORTHOGONAL"` en `ELK_LAYOUT_OPTIONS` (`codemap/viewer/app.js`) y mapear los `bendPoints` devueltos por `state.elk.layout()` a `"curve-style": "segments"` (o `"taxi"`) en Cytoscape, logrando que las aristas rodeen los contenedores en ángulos rectos en lugar de cruzar diagonalmente sobre nodos no relacionados.
- [ ] **Escalabilidad (4/5) — Modo "Aristas bajo demanda" (*Hover / Selection Reveal*):** Incorporar un modo de visualización limpia para vistas densas donde las aristas no prioritarias permanecen con opacidad mínima (`~0.10`) por defecto y se revelan dinámicamente (`mouseover` o selección de nodo) diferenciando entrantes (cian) y salientes (ámbar).
- [ ] **Escalabilidad (5/5) — Capas topológicas automáticas (*Architectural Slicing*):** Calcular en `codemap/graph_builder.py` la profundidad topológica de cada archivo/función (Entradas/UI → Orquestadores → Estado/Servicios → Utilidades/Persistencia) y ofrecer en el visor un modo de agrupación por **Capas de Flujo** alternativo a la jerarquía por carpetas, asegurando que los datos avancen siempre en una sola dirección clara.

## Under Observation & Edge Cases
- [ ] **Higiene de repositorio e historial de deuda técnica:** Mantener `BACKLOG.md` únicamente con ítems activos y archivar cada lote completado en `docs/history/` para minimizar consumo de contexto en sesiones con agentes.