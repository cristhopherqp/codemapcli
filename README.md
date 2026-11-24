# CodeMap

Herramienta CLI local de análisis estático y mapeo cognitivo interactivo que permite comprender, navegar y documentar la arquitectura de proyectos de código sin modificar nunca los repositorios analizados.

## ¿Qué es y para qué sirve?

CodeMap analiza proyectos completos o archivos individuales de **Python** (`.py`), **JavaScript** (`.js`, `.jsx`), **TypeScript** (`.ts`, `.tsx`) y puntos de entrada **HTML** (`.html`, `.htm`) mediante `tree-sitter` y ofrece un visor web local interactivo impulsado por Cytoscape.js y ELKjs.

- **Cero intrusión:** Nunca crea archivos dentro del repositorio analizado. Toda la caché (`graph.json`), notas personales (`notes.json`), APIs aprendidas y exportaciones por defecto se guardan de forma centralizada en `~/.codemap/<hash>/`.
- **Visualización multiescala (4 niveles):** Explora el código desde una vista macro hasta el flujo línea por línea:
  1. **Nivel 1 — Módulos (`1`):** Carpetas y archivos raíz colapsados.
  2. **Nivel 2 — Archivos (`2`):** Carpetas desplegadas con archivos colapsados para inspeccionar el flujo inter-archivos sin saturación.
  3. **Nivel 3 — Funciones (`3`):** Todas las funciones e interconexiones visibles (con protección progresiva `N-hops` en proyectos grandes).
  4. **Nivel 3+ — Intra-función (`4`):** Desglose interno de ramas (`if/switch/match`), bucles (`🔁`), listeners/hooks (`⚡`), bloques `try/except` y llamadas clave.
- **Resolución semántica avanzada:** Detecta llamadas directas, callbacks pasados por referencia, hooks de arranque top-level, alias de `tsconfig.json` / `jsconfig.json`, `.gitignore` anidados, puentes `servidor → HTML → script` y patrones Observer / Pub-Sub (disparos reactivos).
- **Escalabilidad visual y ergonomía para proyectos grandes:**
  - **Orden de Ejecución (`↓`) y Orden de Creación estricto (`1→N`):** Alterna desde la barra superior entre `↓ Ejecución` (flujo topológico entradas arriba → destinos abajo) y `Creación (1→N)` (orden estricto `1→N` por `line` ascendente en bandas adaptativas de `2–3` funciones con escalonamiento `+14px`, `forceNodeModelOrder: true`, cimientos→ensamblaje en Módulos/Archivos/Capas, corredores macro ELK cosidos sin cruces sobre nodos, atenuación suave en aristas inter-archivo restaurada al 100% en interacción, sincronización en ventanas flotantes y coordenadas `pinned` independientes `creation_*`).
  - **Hilos de Ejecución + Aislamiento real:** Selecciona hilos principales de arranque o hilos por evento/ruta y activa **"Aislar en lienzo"** para reconstruir únicamente el subgrafo activo en un árbol compacto.
  - **Enrutamiento ortogonal ELKjs robusto en todos los niveles (incluido `Nivel 3+`):** Las aristas rodean los contenedores en ángulos rectos (`ORTHOGONAL` → `segments` con `edge-distances: endpoints` y proyección exacta al borde de rombos, elipses y contenedores compuestos `flowContainer`/`expandedFn`), con propiedad LCA exacta en ELK, alto contraste y `z-compound-depth: top` en aristas de flujo tanto en `↓ Ejecución` como en `Creación (1→N)` y ventanas flotantes.
  - **Anclaje estricto por ámbito y recálculo local de aristas:** Arrastrar cualquier contenedor (`module`, `file`, `layer`, `expandedFn` o `flowContainer`) fija únicamente ese contenedor trasladando su contenido como bloque rígido `(dx, dy)` sin contaminar a sus hijos, conserva intactas sus aristas internas `.elk-routed` y re-enruta localmente solo las aristas externas incidentes; además permite fijar pasos `flow` en `Nivel 3+` (`intra` / `creation_intra`) con migración automática por huella AST en `notes.json`.
  - **Aristas bajo demanda:** Atenúa conexiones no prioritarias (`opacity ~0.10`) y revela al vuelo las entrantes (cian) y salientes (ámbar) al pasar el cursor o seleccionar un nodo.
  - **Exploración por vecindad (`N-hops`):** En proyectos con `> 25` funciones (o bajo demanda desde el Inspector), expande progresivamente `1` o `2` saltos hacia atrás (`callers`) o hacia adelante (`callees`).
  - **Capas de Flujo (*Architectural Slicing*):** Alterna entre agrupación por **Carpetas** y agrupación automática por **Capas topológicas** (*Entradas/UI → Orquestadores → Servicios/Estado → Utilidades/Persistencia*) usando condensación SCC (Tarjan) y particionamiento ELK.
  - **Ventanas flotantes anidadas (`Clic central` o `Alt + Doble clic`) con visor de código sincronizado:** Expande módulos, archivos o funciones en ventanas aisladas con puertos de frontera (`⇠`/`⇢`), líneas puente SVG, bloqueo padre-hijo, paneo completo (clic derecho / arrastrar rueda / `Espacio`) y tooltip de docstrings. En ventanas flotantes de función, alterna entre **Solo flujo**, **Solo código** (cargado bajo demanda vía `GET /source` sin engordar `graph.json`, con números de línea, resaltado sintáctico seguro, toggle **Ajustar líneas** / *Word Wrap*, zoom de fuente **`A− / A+`** `10–22px` persistido en `localStorage` y botón copiar) y **Flujo y código** (vista dividida con **divisor vertical arrastrable** y doble clic para restaurar 50/50, sincronizada paso ↔ línea de código).
  - **Contexto completo de clases e inspección ergonómica:** Extrae `ClassInfo` (herencia `extends` / `implements` / bases Python, clases abstractas, rango de líneas y docstring/JSDoc de clase sin duplicación) en Python y JS/TS; hace visible `__init__` por defecto con insignia **`CONSTRUCTOR`** (junto a **`MÉTODO`** para métodos de clase), enlace a la declaración de clase y bloque dedicado con el docstring de la clase. El Inspector organiza las acciones en una grilla compacta **3 filas × 2 botones**, incluye **`Liberar fijados (N)`** estrictamente contextual (selección actual o multi-selección `Shift`/`Ctrl` y su subárbol) y ubica **`🎯 Aislar archivo`** como píldora compacta en la cabecera al seleccionar archivos en proyectos multi-archivo.
  - **Inspección enriquecida de archivos y tooltip tras 1 s:** Extrae docstrings de cabecera de archivos Python y JS/TS (expuestos en `graph.json` y exportación IA), muestra un tooltip flotante tras `1000 ms` de hover sobre cualquier función o archivo con docstring, y al seleccionar un archivo muestra en el Inspector su **Docstring**, una **lista numerada secuencial clicable** de sus funciones ordenadas por línea y su **Nota Personal**.
  - **Filtro anti-maraña de utilitarios:** Oculta funciones utilitarias de alto *fan-in* manteniendo insignias `⚙×N` y chips navegables en el Inspector.
- **Exportación para IA e Imágenes:**
  - CLI `codemap export` y modal web para generar grafos **JSON minificados** (reduciendo el peso en ~75–90%) y resúmenes **Markdown con diagramas Mermaid** optimizados para LLMs, además de capturas en alta resolución **PNG / JPG** (`2×`).
- **Memoria cognitiva persistente, seguridad local y recarga en vivo:** Notas personales por nodo, roles visuales personalizables, posiciones fijadas (`pinned`) aisladas por escala/agrupación/orden, migración automática de notas por huella AST al renombrar funciones, inventario global de APIs aprendidas/pendientes, escrituras atómicas con locks, confinamiento estricto de `tsconfig.json` `extends` y `GET /source` al proyecto analizado, y servidor local endurecido con validación `Host`/`Origin` loopback (`127.0.0.1`, `localhost`, `[::1]`) y sincronización WebSocket multi-pestaña.

## Requisitos

- Python 3.11 o superior.

## Instalación

Ejecuta cualquiera de los siguientes comandos desde la carpeta raíz del proyecto (donde se encuentra `pyproject.toml`):

```bash
# Instalación global y aislada (recomendada)
pipx install .

# Alternativa mediante uv
uv tool install .
```

Para instalar CodeMap en modo editable durante el desarrollo:

```bash
pip install --no-build-isolation -e .
```

## Uso

### Comandos CLI

```bash
# Analizar un proyecto o archivo y abrir el visor en vivo
codemap ruta/del/proyecto
codemap ruta/del/archivo.py

# Abrir en modo estático (sin supervisar cambios en tiempo real)
codemap ruta/del/proyecto --once

# Incluir funciones privadas o dunder (_helper, __repr__, #metodo; __init__ es visible por defecto)
codemap ruta/del/proyecto --include-private

# Opciones adicionales del visor
codemap ruta/del/proyecto --no-browser  # Inicia el servidor sin abrir el navegador
codemap ruta/del/proyecto --no-serve    # Genera únicamente graph.json, sin iniciar el visor

# Exportación compacta para compartir arquitectura con IA
codemap export ruta/del/proyecto                         # Escribe ~/.codemap/<hash>/graph.ai.json
codemap export ruta/del/proyecto --format md             # Genera resumen Markdown con diagrama Mermaid
codemap export ruta/del/proyecto --include-flow          # Incluye flujo intra-función (Nivel 3+)
codemap export ruta/del/proyecto --out arquitectura.json # Guarda en una ruta explícita
codemap export ruta/del/proyecto --format md --stdout    # Imprime directamente en salida estándar

# Gestionar cachés en ~/.codemap/
codemap list   # Lista los proyectos registrados
codemap clean  # Elimina cachés de proyectos que ya no existen en disco
```

### Controles y atajos del visor web

| Atajo / Acción | Función |
| --- | --- |
| `1` / `2` / `3` / `4` | Cambiar nivel: **Módulos → Archivos → Funciones → Intra-función (3+)** |
| **Carpetas / Capas de Flujo** | Alternar entre jerarquía de directorios y capas topológicas automáticas |
| **Orden: `↓ Ejecución` / `Creación (1→N)`** | Alternar entre flujo topológico (`DOWN`) y orden de creación estricto (`1→N` por línea en bandas + cimientos→ensamblaje en todos los niveles y ventanas flotantes, con pines independientes) |
| **Clic en nodo / fondo vacío** | Inspeccionar función (firma, llamadas, APIs, nota) o archivo (**Docstring → Lista numerada de funciones → Nota**); clic en fondo vacío muestra el **resumen dinámico del flujo** |
| **Hover `1 s` en archivo o función** | Mostrar tooltip flotante con su docstring (en el grafo principal y en ventanas flotantes) |
| **Doble clic en nodo** | Colapsar o expandir módulo, capa, archivo o flujo intra-función |
| **Clic central en nodo** / `Alt` + **Doble clic** | Abrir módulo, archivo o función en una **ventana flotante aislada** con puertos (sin auto-scroll nativo) |
| **Modos en ventana de función** | Alternar entre **Solo flujo**, **Solo código** y **Flujo y código** (divisor vertical arrastrable + doble clic 50/50, **Ajustar líneas** y zoom de fuente **`A− / A+`** `10–22px`) |
| **Arrastrar un nodo o contenedor** | Fijar únicamente el nodo o contenedor arrastrado (`pinned`) sin contaminar hijos, preservando aristas internas y re-enrutando solo aristas externas (compatible con pasos `flow` en Nivel 3+); **`Liberar fijados (N)`** suelta únicamente la selección/subárbol actual |
| `T` + `↑` / `↓` + `→` / `Enter` / `←` | **Modo Foco** multi-rama con halo de alto contraste preservando el color semántico de cada flecha y opción **"Aislar en lienzo"** |
| **Selector de Hilos** | Resaltar o aislar hilos principales de arranque y flujos por evento/ruta |
| **Barra lateral** | Modo Foco (`T`), Ocultar utilitarios, **Aristas bajo demanda**, Buscador (`Ctrl+K`), Huérfanas, Inventario de APIs, Exportar (PNG/JPG + JSON/MD para IA), Reordenar (`R`), Centrar (`F`), Ayuda (`?`) y **Leyenda (`🗺️`)** al pie |
| **Clic derecho** / arrastrar rueda / `Espacio` + Arrastrar | Paneo libre de la cámara en el grafo principal y ventanas flotantes sin mover nodos |
| `Ctrl + K` | Buscador instantáneo de funciones, archivos y notas |
| `]` o `Ctrl + \` | Mostrar u ocultar el panel Inspector |
| `Esc` | Cerrar modales / ventana flotante hoja / salir de Foco, aislamiento, `N-hops` o Hilo / deseleccionar |

## Pruebas

```bash
python -m unittest discover -s tests -v
node --check codemap/viewer/app.js
```
