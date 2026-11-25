# Ciclo 9 — Fichas Vivas de Vocabulario Técnico ("Anki en vivo") y Notas por Línea (Lote 4)

- **Fecha:** 2026-11-24
- **Alcance:** Fases 9.1 y 9.2 del plan de ejecución aprobado (`BACKLOG.md` — Lote 4).
- **Principio verificado:** 100 % estático, offline, seguro (cero `innerHTML` en el nuevo módulo `vocab.js`, validación estricta `http:`/`https:`) y cero intrusión sobre los repositorios analizados.

---

## Cambios implementados

### Fase 9.1 — Micro-diccionario estático, extractor AST y notas por línea
- **Empaquetado (`pyproject.toml`):** Añadido `"*.json"` a `[tool.setuptools.package-data]` para que `codemap/vocab_dictionary.json` se incluya correctamente en instalaciones `pipx` / `uv tool` / wheel.
- **Micro-diccionario curado (`codemap/vocab_dictionary.json`):** 82 entradas offline con contratos en español **`Entrada → Acción → Salida`** cubriendo:
  - 17 modismos y operadores AST de JS/TS (`?.`, `??`, `??=`, `||`, `&&`, `...` spread/rest, desestructuración objeto/array, `async`/`await`, template literals, ternario, arrow `=>`, `yield*`, `for...of`, `for...in`, `as Type`).
  - 17 modismos AST de Python (comprensiones de lista/dict/set, generadores, `@decorator`, `with`/`async with`, walrus `:=`, f-strings, slicing `[a:b:c]`, `*args`/`**kwargs`, `lambda`, ternario, `async`/`await`, `yield`, `match`/`case`, `try`/`except`).
  - 30 métodos estándar alineados exactamente con los `api_id` emitidos por `graph_builder.py` (`js:Array.prototype.*`, `js:Object.*`, `js:Promise.*`, `py:dict.get`, `py:builtins.enumerate`, `py:str.split`, etc.).
  - 14 códigos POSIX frecuentes (`ENOENT`, `EACCES`, `EPERM`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ECONNREFUSED`, `EADDRINUSE`, `ETIMEDOUT`, `EPIPE`, `ECONNRESET`, `ENOSPC`, `EINVAL`, `EBUSY`) y 4 literales de control (`\0`, `\n`, `\r\n`, `\t`).
- **Extractor AST (`codemap/vocab.py`, `codemap/models.py`, `codemap/parsers/python_parser.py`, `codemap/parsers/js_parser.py`, `codemap/graph_builder.py`):**
  - Añadido `FunctionInfo.vocab_by_line: dict[int, list[str]]` recorrido directamente sobre el árbol `tree-sitter` ya parseado, descartando nodos `comment` y funciones anidadas (registrando únicamente la firma `arrow_function` en la línea de declaración sin descender al cuerpo de la función hija).
  - Serializado en `graph.json` solo cuando no está vacío; el exportador compacto IA (`codemap/exporter.py`) poda automáticamente `vocab_by_line` para mantener el peso mínimo.
- **Notas por línea y endpoint de diccionario (`codemap/notes_storage.py`, `codemap/server.py`):**
  - `notes_storage.py` añade soporte retrocompatible para `"line_notes"` (`"<file_id>::<line>" -> { file_id, line, note, line_hash, updated_at }`) en `load_notes()`, `save_notes()`, `reconcile_notes()` (conserva notas de archivos presentes y poda archivos eliminados) y `update_notes()` (upsert/eliminación parcial con `null`).
  - `server.py` expone `GET /vocab-dictionary` con `Cache-Control: no-store`.

### Fase 9.2 — Glosario progresivo que se desvanece, notas por línea e Inventario unificado
- **Módulo dedicado (`codemap/viewer/vocab.js`):** Script estándar UMD (`window.CodeMapVocab` / `module.exports`), validado con `node --check`, 100 % DOM/`textContent` (cero `innerHTML`), que:
  - Agrega ocurrencias de `vocab_by_line` y `external_calls` enriquecidas con su contrato `Entrada → Acción → Salida` para la línea o rango activo.
  - Filtra automáticamente todo concepto marcado como aprendido en `~/.codemap/known_apis.json`.
  - Ofrece **`✓ Ya la sé`** (persiste vía `POST /known-apis` y desvanece la ficha en todas las vistas abiertas y proyectos futuros) y un editor inline **`+ 📝 Nota en L<n>`** (guarda en `POST /notes.json` bajo `line_notes`, mostrando confirmación `"Guardada ✓"` resistente al eco WebSocket `notes_updated`).
- **Integración en el visor (`codemap/viewer/app.js`, `codemap/viewer/walkthrough.js`, `codemap/viewer/index.html`, `codemap/viewer/styles.css`):**
  - **Ventanas flotantes (`Solo código` / `Flujo y código`):** Dock `.fw-vocab-dock` bajo el código fuente actualizado al hacer clic en cualquier línea o paso de flujo, con indicador `📝` en el margen de líneas con nota personal (`.fw-code-line.has-line-note`).
  - **Recorrido Visual — Modo Paso a Paso (N3+):** Dock `#wt-vocab-dock` sincronizado dentro del panel Call Stack del Inspector junto a `#wt-code-lines` (también con indicador `📝` en líneas anotadas).
  - **Modal `Inventario de APIs y Vocabulario`:** Unifica APIs externas y conceptos de sintaxis/POSIX/control con filtros por categoría (`Todos`, `APIs`, `Sintaxis y SO`), resumen compacto `Entrada → Salida` en cada ficha y sincronización bidireccional `✓ Ya la sé` / `↩ Por aprender`.

---

## Verificación
- **Sintaxis JS:** `node --check` exitoso en `codemap/viewer/vocab.js`, `codemap/viewer/walkthrough.js` y `codemap/viewer/app.js`.
- **Pruebas unitarias y headless:** **90/90** pruebas en verde (`tests/test_cycle9_vocab.py` + toda la batería previa), incluyendo empaquetado JSON, cobertura del diccionario, extracción AST Python y JS/TS con cero falsos positivos en comentarios, persistencia y reconciliación de `line_notes`, endpoints HTTP `/vocab-dictionary`, `/notes.json` y `/known-apis`, cero `innerHTML` y pruebas Node directas sobre `vocab.js`.
- **Verificación en navegador real (`codemap/notes_storage.py`):** 0 errores de consola y 0 peticiones fallidas (21/21 HTTP 200); validado flujo completo de Fichas Vivas en `Flujo y código`, desvanecimiento inmediato con **`✓ Ya la sé`** (`try / except`), guardado de nota personal por línea con marca `📝` en el margen, sincronización en **Modo Paso a Paso (N3+)** sin reaparición del concepto aprendido, y modal **`Inventario de APIs y Vocabulario`** con filtros `Todos` / `APIs` / `Sintaxis y SO` y pestaña `Aprendidas` (`↩ Por aprender`). Estado previo de `~/.codemap/known_apis.json` restaurado y caché temporal eliminada; 0 archivos modificados en el objetivo analizado.
