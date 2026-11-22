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
  - **Orden de Ejecución (`↓`) y Orden de Creación (`↑`):** Alterna desde la barra superior entre `↓ Ejecución` (entradas arriba → callees abajo) y `↑ Creación` (helpers arriba → entradas abajo, respetando orden de declaración con `NODES_AND_EDGES`, escalonamiento vertical `+14px` entre hermanas de la misma fila y coordenadas `pinned` independientes `creation_*`).
  - **Hilos de Ejecución + Aislamiento real:** Selecciona hilos principales de arranque o hilos por evento/ruta y activa **"Aislar en lienzo"** para reconstruir únicamente el subgrafo activo en un árbol compacto.
  - **Enrutamiento ortogonal ELKjs:** Las aristas rodean los contenedores en ángulos rectos (`ORTHOGONAL` → `segments` / `taxi`) evitando cruces diagonales sobre nodos no relacionados.
  - **Aristas bajo demanda:** Atenúa conexiones no prioritarias (`opacity ~0.10`) y revela al vuelo las entrantes (cian) y salientes (ámbar) al pasar el cursor o seleccionar un nodo.
  - **Exploración por vecindad (`N-hops`):** En proyectos con `> 25` funciones (o bajo demanda desde el Inspector), expande progresivamente `1` o `2` saltos hacia atrás (`callers`) o hacia adelante (`callees`).
  - **Capas de Flujo (*Architectural Slicing*):** Alterna entre agrupación por **Carpetas** y agrupación automática por **Capas topológicas** (*Entradas/UI → Orquestadores → Servicios/Estado → Utilidades/Persistencia*) usando condensación SCC (Tarjan) y particionamiento ELK.
  - **Ventanas flotantes anidadas (`Alt + Doble clic`):** Expande módulos, archivos o flujos internos en modales aislados con puertos de frontera (`⇠`/`⇢`), líneas puente SVG, bloqueo padre-hijo, paneo completo (clic derecho / central / `Espacio`) y tooltip de docstrings.
  - **Inspección enriquecida de archivos y tooltip tras 1 s:** Extrae docstrings de cabecera de archivos Python y JS/TS (expuestos en `graph.json` y exportación IA), muestra un tooltip flotante tras `1000 ms` de hover sobre cualquier función o archivo con docstring, y al seleccionar un archivo muestra en el Inspector su **Docstring**, una **lista numerada secuencial clicable** de sus funciones ordenadas por línea y su **Nota Personal**.
  - **Filtro anti-maraña de utilitarios:** Oculta funciones utilitarias de alto *fan-in* manteniendo insignias `⚙×N` y chips navegables en el Inspector.
- **Exportación para IA e Imágenes:**
  - CLI `codemap export` y modal web para generar grafos **JSON minificados** (reduciendo el peso en ~75–90%) y resúmenes **Markdown con diagramas Mermaid** optimizados para LLMs, además de capturas en alta resolución **PNG / JPG** (`2×`).
- **Memoria cognitiva persistente, seguridad local y recarga en vivo:** Notas personales por nodo, roles visuales personalizables, posiciones fijadas (`pinned`) aisladas por escala/agrupación/orden, migración automática de notas por huella AST al renombrar funciones, inventario global de APIs aprendidas/pendientes, escrituras atómicas con locks y servidor local endurecido con validación `Host`/`Origin` loopback (`127.0.0.1`, `localhost`, `[::1]`) y sincronización WebSocket multi-pestaña.

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

# Incluir funciones privadas o dunder (_helper, __init__, #metodo)
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
| **Orden: `↓ Ejecución` / `↑ Creación`** | Alternar dirección del grafo (`DOWN` vs `UP` con escalonamiento por línea y pines independientes) |
| **Clic en nodo / fondo vacío** | Inspeccionar función (firma, llamadas, APIs, nota) o archivo (**Docstring → Lista numerada de funciones → Nota**); clic en fondo vacío muestra el **resumen dinámico del flujo** |
| **Hover `1 s` en archivo o función** | Mostrar tooltip flotante con su docstring (en el grafo principal y en ventanas flotantes) |
| **Doble clic en nodo** | Colapsar o expandir módulo, capa, archivo o flujo intra-función |
| `Alt` + **Doble clic** | Abrir módulo, archivo o función en una **ventana flotante aislada** con puertos |
| **Arrastrar un nodo** | Fijar su posición (`pinned`) aislada por nivel, agrupación y orden de layout |
| `T` + `↑` / `↓` + `→` / `Enter` / `←` | **Modo Foco** multi-rama con halo de alto contraste preservando el color semántico de cada flecha y opción **"Aislar en lienzo"** |
| **Selector de Hilos** | Resaltar o aislar hilos principales de arranque y flujos por evento/ruta |
| **Barra lateral** | Modo Foco (`T`), Ocultar utilitarios, **Aristas bajo demanda**, Buscador (`Ctrl+K`), Huérfanas, Inventario de APIs, Exportar (PNG/JPG + JSON/MD para IA), Reordenar (`R`), Centrar (`F`), Ayuda (`?`) y **Leyenda (`🗺️`)** al pie |
| **Clic derecho** / central / `Espacio` + Arrastrar | Paneo libre de la cámara en el grafo principal y ventanas flotantes sin mover nodos |
| `Ctrl + K` | Buscador instantáneo de funciones, archivos y notas |
| `]` o `Ctrl + \` | Mostrar u ocultar el panel Inspector |
| `Esc` | Cerrar modales / ventana flotante hoja / salir de Foco, aislamiento, `N-hops` o Hilo / deseleccionar |

## Pruebas

```bash
python -m unittest discover -s tests -v
node --check codemap/viewer/app.js
```
