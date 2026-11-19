# Pending & Technical Debt

*The suggested actions are only possible standard steps to take, not the exact root cause of the problem. You should take them into account, but if the issue lies elsewhere, you must find the root cause and fix it.*

## Critical Fixes (Bugs)
*(Sin bugs críticos pendientes en este ciclo.)*

## Improvements & Refactoring
- [ ] **Escalabilidad (2/5) — Exploración por vecindad (`N-hops` Drill-Down):** Para proyectos medianos o grandes (superando `LARGE_PROJECT_FUNCTIONS` en `codemap/graph_builder.py`), evitar que el nivel de funciones despliegue todo el repositorio de golpe. Permitir expandir progresivamente `1` o `2` saltos hacia adelante (`callees`) o hacia atrás (`callers`) desde un nodo seleccionado, manteniendo colapsado o fuera de vista el resto del proyecto.
- [ ] **Escalabilidad (5/5) — Capas topológicas automáticas (*Architectural Slicing*):** Calcular en `codemap/graph_builder.py` la profundidad topológica de cada archivo/función (Entradas/UI → Orquestadores → Estado/Servicios → Utilidades/Persistencia) y ofrecer en el visor un modo de agrupación por **Capas de Flujo** alternativo a la jerarquía por carpetas, asegurando que los datos avancen siempre en una sola dirección clara.
- [ ] **Sincronización integral de `README.md`:** Actualizar la documentación principal con todos los comandos (`codemap export`), nuevos niveles (`N1–N3+`), ventanas flotantes y funciones de escalabilidad visual.

## Under Observation & Edge Cases
- [ ] **Higiene de repositorio e historial de deuda técnica:** Mantener `BACKLOG.md` únicamente con ítems activos y archivar cada lote completado en `docs/history/` para minimizar consumo de contexto en sesiones con agentes.