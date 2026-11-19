# Etapa 2 — Escala de Niveles (N1–N3+), `pinned_positions` Semánticos e Inspector Dinámico

**Fecha:** 2026-11-19  
**Estado:** ✅ Completada y validada (23/23 pruebas unitarias OK, `node --check` OK y verificación extremo a extremo en navegador con 0 errores de consola)

---

## 1. Bug 5 y Reordenamiento de la Escala de Niveles

- **Corrección en Nivel 1 (`collapseTopContainers()` en `codemap/viewer/app.js`):**
  - Se reemplazó `collapseTopModules()` para colapsar **todos** los contenedores raíz (`module` y `file` con `parent === null`) que contengan funciones descendientes, evitando que archivos raíz como `server.js` queden expandidos cuando existen subcarpetas (`js/`).
  - Archivos vacíos o `.html` sin funciones no muestran sufijos `[+ 0]`.
- **Nueva escala Módulos (N1) → Archivos (N2) → Funciones (N3) → Intra-función (N3+):**
  - **Backend (`codemap/graph_builder.py`) y CLI (`codemap/cli.py`):**
    - Constantes `LEVEL_MODULES = 1`, `LEVEL_FILES = 2`, `LEVEL_FUNCTIONS = 3`, `LEVEL_INTRA_FUNCTION = 4` (manteniendo alias heredados) y etiquetas `LEVEL_NAMES` sincronizadas.
    - `recommended_level(total_functions, is_single_file, has_modules)`: `<= 2` funciones → `4` (Intra-función), archivo suelto → `3` (Funciones), mediano multi-archivo (`3..25`) → `2` (Archivos), grande (`> 25`) → `1` (Módulos) o `2` si es plano.
  - **Visor Web (`codemap/viewer/index.html`, `codemap/viewer/app.js`):**
    - Botones actualizados: **Nivel 1: Módulos**, **Nivel 2: Archivos** (`collapseAllFiles()`, carpetas abiertas y archivos colapsados), **Nivel 3: Funciones** y **Nivel 3+: Intra-función** (`expandFunctionFlowsSmart()`, con protección automática para proyectos `> 25` funciones).
    - Atajos de teclado `1` / `2` / `3` / `4` documentados en `#help-modal`.

---

## 2. Aislamiento de Archivo desde el Inspector y Compatibilidad de `pinned_positions`

- **Botón "Aislar archivo" (`#btn-isolate-file` + HUD `#file-isolation-hud`):**
  - Disponible en el Inspector para cualquier `file` o `function` en proyectos multi-archivo; colapsa el resto de archivos, encuadra el archivo enfocado y permite salir desde el HUD, el propio botón o la tecla `Esc`.
- **Claves semánticas sin colisiones (`codemap/notes_storage.py`, `codemap/viewer/app.js`):**
  - `VALID_LAYOUT_LEVELS` ampliado con `"modules"`, `"files"`, `"functions"`, `"intra"` (y `"layers_*"` listas para Etapa 4), conservando retrocompatibilidad con `"level_1".."level_4"`.
  - `getPinnedPositionForContext()` mapea `"modules" → level_1`, `"functions" → level_2 / x,y planos` (migración transparente de anclajes previos de funciones), `"intra" → level_4`, y mantiene `"files"` completamente aislado sin heredar pines antiguos. Al desfijar, también se limpian claves heredadas equivalentes.

---

## 3. Resumen Dinámico del Flujo en `#details-empty`

- **`renderEmptyInspectorSummary()` (`codemap/viewer/index.html`, `styles.css`, `app.js`):**
  - Sustituye el texto estático por una vista contextual sincronizada con el nivel activo: insignia de nivel, contadores visibles reales (`mód.`, `arch.`, `fns`, `conex.`), **Puntos de entrada** clicables, **Conexiones principales visibles** ordenadas por peso/prioridad y lista clicable de **Hilos de ejecución** (oculta cuando `#active-flow-panel` ya está activo).
  - Se oculta al seleccionar un nodo y reaparece automáticamente al presionar `Esc` o al hacer clic en el fondo vacío del lienzo.

---

## 4. Validación

- Nuevas pruebas en `tests/test_stage2.py` (reglas `recommended_level`, proyectos multi/suelto/grande plano y persistencia/reconciliación de claves semánticas `pinned_positions`).
- `.venv\Scripts\python.exe -m unittest discover -s tests -v`: **23/23 OK**.
- `node --check codemap/viewer/app.js`: **exit 0**.
- Verificación interactiva en navegador (`127.0.0.1` sobre fixture con carpetas + archivo raíz `server.js` + `index.html`): N2 inicial, N1 colapsa `server.js` y `js/` sin `[+ 0]` en `index.html`, N3 despliega las 6 funciones, aislamiento de archivo desde Inspector + HUD, N3+ con nodos `⚡`, deselección con `Esc`, exportación IA desde `#export-modal` y **0 errores de consola**.
