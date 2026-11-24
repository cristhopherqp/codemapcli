# Ciclo 7 — Variables y Constantes Top-Level (Nivel de Archivo)

**Fecha:** 2026-11-24  
**Estado:** ✅ Completado y validado (76/76 pruebas unitarias y headless OK, `node --check` OK y verificación visual/interactiva en navegador sobre `codemap/parsers/common.py` con 0 errores de consola y 0 peticiones fallidas)

---

## Motivación

Los archivos reales suelen centralizar configuración, límites, rutas base, tablas de reglas y enumeraciones en declaraciones de nivel raíz (*top-level*). Sin mostrarlas bajo demanda, resultaba difícil rastrear qué funciones consumen qué constantes o estado compartido sin abrir el código fuente. Al mismo tiempo, inyectarlas siempre en el lienzo o mezclarlas con la clasificación de funciones añadiría ruido visual y distorsionaría los flujos de ejecución, las funciones hoja (`is_terminal`) y las capas topológicas.

---

## Cambios Implementados

### Fase 7.1 — Backend AST, resolución anti-sombreado y serialización aislada
- **Modelos y utilidades (`codemap/models.py`, `codemap/parsers/common.py`):**
  - Añadidos `EDGE_READS_VAR = "reads_var"`, `VariableInfo` (`qualname`, `short_name`, `kind`, `line`, `end_line`, `value_preview`, `docstring`, `type_annotation`, `fingerprint`), `VarRefSite`, `FunctionInfo.var_refs` y `FileAnalysis.variables`.
  - Añadidos `format_value_preview()` (truncado compacto a 80 caracteres con redacción automática de literales sensibles como `SECRET`/`TOKEN`/`PASSWORD`/`API_KEY` → `'"[REDACTED]"'`) y `compute_variable_fingerprint()`.
- **Extracción AST y anti-sombreado Python (`codemap/parsers/python_parser.py`):**
  - `collect_top_level_variables()` extrae únicamente declaraciones en la raíz del módulo (`assignment`, `annotated_assignment`, desempaquetado en tuplas), excluyendo `import`, `def`/`class`, `lambda`, atributos/subíndices y bloques `if __name__ == "__main__":`, clasificando `constant` (MAYÚSCULAS o `Final`) vs `variable` y extrayendo comentarios `#` contiguos superiores o inline.
  - `collect_python_var_refs()` recorre el cuerpo de cada función con pila léxica de ámbitos (parámetros, asignaciones locales, comprensiones, lambdas, `global`/`nonlocal`), ignorando argumentos keyword, anotaciones de tipo y callees directos, y emitiendo lecturas de variables locales, dicts/objetos (`CONFIG.get(...)`) y módulos importados (`config.TIMEOUT`).
- **Extracción AST y anti-sombreado JS/TS (`codemap/parsers/js_parser.py`):**
  - `collect_top_level_variables()` extrae `const`/`let`/`var`, `export const`, desestructuración simple y `enum_declaration` de TypeScript, excluyendo `import`, `require(...)`, funciones flecha, expresiones de función y clases; `extract_file_docstring()` evita robar JSDoc `/**` pegados a declaraciones top-level de constantes/variables/enums.
  - `collect_js_var_refs()` implementa pila léxica por bloque con *hoisting* de `var`/`function`, parámetros desestructurados, `for`/`catch` y propiedades *shorthand* (`{ LOCAL_TAG }`).
- **Resolución, grafo aislado, `/source` y exportador IA (`codemap/resolver.py`, `codemap/graph_builder.py`, `codemap/server.py`, `codemap/exporter.py`):**
  - `resolve_variable_refs()` resuelve lecturas locales, imports nombrados/default, re-exportaciones encadenadas y accesos `ns.VAR` hacia aristas `función → variable` (`edge_type: "reads_var"`).
  - `build_graph()` calcula `variable_nodes` (ordenados por `line`, respetando `--include-private` para `_VAR`/`#var`) y `var_edges` **después** de `terminal_ids`, `execution_flows` y `compute_architectural_layers`, evitando cualquier distorsión en métricas de funciones; añade `meta.total_variables`.
  - `server.py` habilita `GET /source?node_id=<var_id>` con el mismo confinamiento estricto al proyecto analizado.
  - `exporter.py` serializa nodos `variable` compactos, `meta.total_variables` y aristas `reads_var` (`lee`) tanto en JSON IA como en Markdown.

### Fase 7.2 — Visor interactivo, toggle en barra lateral y `Orden: Creación (1→N)` (`index.html`, `styles.css`, `app.js`)
- **Toggle en barra lateral izquierda (desactivado por defecto):** `#btn-toggle-variables` (`🔖 Mostrar constantes (N)` / `Ocultar constantes (N)`, `aria-pressed="false"`, badge numérico) controla la visibilidad de nodos `type: "variable"` y aristas `reads_var` en el grafo principal, modo Capas y ventanas flotantes.
- **Estilos Cytoscape y Leyenda:** Pastillas compactas con borde punteado cian (`#06b6d4`) para constantes y ámbar (`#eab308`) para variables mutables; aristas `reads_var` punteadas discretas (`opacity: 0.58`, flecha `vee` cian) restauradas al 100 % al seleccionar o interactuar; entradas `Constante / Var` y `Lee variable` en `#graph-legend`.
- **Compatibilidad total con `Orden: Creación (1→N)`:** `buildCreationElkInput()`, `computeCreationPartition()` y `applyCreationRowStagger()` ordenan constantes/variables junto a las funciones estrictamente por línea de declaración (`1→N`).
- **Inspector, búsqueda y tooltip `1 s`:**
  - Al seleccionar una variable: insignias `CONSTANTE`/`VARIABLE` y anotación de tipo, bloque `Valor / Declaración` con botón bajo demanda **`Ver código`** (`GET /source`), sección **`Leída por (N)`** con salto directo a las funciones consumidoras, nota personal, `Explorar vecindad` y enlace `VS Code (L<n>)`.
  - Al seleccionar un archivo: nuevo bloque `#detail-file-variables-block` con la lista numerada clicable de sus constantes/variables (navegar a una variable oculta desde archivo, `Ctrl+K` o tarjeta activa automáticamente `Mostrar constantes`).
  - Tooltip flotante tras `1000 ms` de hover muestra docstring y/o `value_preview` de la constante/variable.

---

## Validación Final

- Nueva suite: [test_cycle7_variables.py](file:///e:/all_projects/guided_ia_proj/codemap/tests/test_cycle7_variables.py) (7 casos cubriendo Python, JS/TS, anti-sombreado, re-exportaciones, aislamiento de métricas, `/source` + confinamiento, exportador IA y pruebas headless en Node con Cytoscape 3.30.2 + ELKjs).
- `.venv\Scripts\python.exe -m unittest discover -s tests -v`: **76/76 pruebas OK**.
- `node --check codemap/viewer/app.js`: **exit 0**.
- Verificación interactiva en navegador con **0 errores de consola** y **0 peticiones fallidas** sobre `codemap/parsers/common.py`: arranque con `Mostrar constantes (8)` desactivado por defecto, activación con pastillas cian (`CALLEE_MAX_CHARS`, `DOCSTRING_MAX_CHARS`, etc.) y ámbar (`NodeKey`, `PendingExit`), `Orden: Creación (1→N)` limpio, búsqueda `Ctrl+K`, carga exacta de `GET /source` (`27 │ CALLEE_MAX_CHARS = 80`), `Leída por (1)` con `normalize_callee()`, lista de 8 variables en el Inspector del archivo `common.py` y desactivación limpia.
