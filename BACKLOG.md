# Pending & Technical Debt

*The suggested actions are only possible standard steps to take, not the exact root cause of the problem. You should take them into account, but if the issue lies elsewhere, you must find the root cause and fix it.*

> **Principio transversal:** Todas las funcionalidades activas deben mantener **cero intrusión** sobre los repositorios analizados (sin crear ni modificar archivos en el proyecto objetivo; toda persistencia vive en `~/.codemap/<hash>/` o `~/.codemap/`) y operar de forma **100 % estática** sobre `tree-sitter`, `graph.json`, Cytoscape.js/ELKjs y `GET /source`.

---

## Under Observation & Edge Cases

- [ ] **[HORIZONTE FUTURO — NO IMPLEMENTAR EN ESTA ITERACIÓN] Trazado Dinámico, RAM y Call Stack Real (`codemap trace`):**
  - *Estado:* Documentado exclusivamente como referencia arquitectónica para garantizar que el contrato de eventos (`WalkthroughTrace` v1) del *Recorrido Visual* se mantenga 100 % compatible con trazas reales. **No diseñar ni codificar todavía.**
  - *Definición prevista para fase futura:*
    - **Activación Opt-in explícita:** Subcomando dedicado `codemap trace <ruta> -- <comando>` con advertencia explícita de que el código objetivo sí se ejecutará (con posibles efectos en disco o red).
    - **Record & Replay sin tocar el repositorio:** Lanzador externo que graba la ejecución en `~/.codemap/<hash>/traces/<timestamp>.trace.json` para reproducción *Time-Travel* (adelante/atrás) sobre el mismo reproductor visual:
      - *Python:* `sys.monitoring` (PEP 669 en Python 3.12+, fallback `sys.settrace` en 3.11), filtrando eventos fuera del directorio del proyecto.
      - *Node.js / JS / TS:* V8 Inspector Protocol (CDP) en loopback estricto (`127.0.0.1`), blackboxing de `node_modules` y soporte de pilas `async/await`.
    - **Capacidades adicionales sobre el visor:** Valores reales de variables en RAM con resaltado *diff* por paso, Call Stack real, ramas realmente ejecutadas, excepciones reales y tiempos en microsegundos.
    - **Salvaguardas obligatorias:** Serialización acotada (profundidad máxima, truncado de strings, límite de ítems y protección anti-ciclos), redacción automática de secretos (`token`, `secret`, `password`, `api_key` → `"[REDACTED]"`) antes de escribir en disco, y búfer circular con tope de eventos contra bucles infinitos.

- [ ] **Higiene de repositorio e historial de deuda técnica:** Mantener `BACKLOG.md` únicamente con ítems activos y archivar cada lote completado en `docs/history/` para minimizar consumo de contexto en sesiones con agentes.
