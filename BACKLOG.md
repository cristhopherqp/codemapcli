# Pending & Technical Debt

*The suggested actions are only possible standard steps to take, not the exact root cause of the problem. You should take them into account, but if the issue lies elsewhere, you must find the root cause and fix it.*

## Critical Fixes (Bugs)

*(Sin bugs críticos pendientes tras el cierre del Ciclo 3 — ver historial archivado en `docs/history/`.)*

## Improvements & Refactoring

*(Sin tareas pendientes activas.)*

## Under Observation & Edge Cases

- [ ] **Higiene de repositorio e historial de deuda técnica:** Mantener `BACKLOG.md` únicamente con ítems activos y archivar cada lote completado en `docs/history/` para minimizar consumo de contexto en sesiones con agentes.
- [ ] **Confinamiento de `tsconfig.json` `extends` en repositorios de terceros:** Evaluar si restringir cadenas `"extends"` relativas en `codemap/resolver.py` estrictamente a ancestros/rutas dentro de `root_dir` cuando se analicen repositorios no confiables.
