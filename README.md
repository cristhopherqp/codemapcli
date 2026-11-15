# CodeMap

Herramienta CLI local de análisis estático y mapeo interactivo que permite comprender y documentar los flujos de código sin modificar los repositorios analizados.

## ¿Qué es y para qué sirve?

CodeMap analiza proyectos completos o archivos individuales de **Python** (`.py`), **JavaScript** (`.js`, `.jsx`) y **TypeScript** (`.ts`, `.tsx`) mediante `tree-sitter` y proporciona un visor web local e interactivo.

- **Cero intrusión:** Nunca crea archivos dentro del repositorio analizado. Toda la caché y las notas personales se almacenan de forma centralizada en `~/.codemap/<hash>/`.
- **Visualización multiescala:** Permite explorar el código en cuatro niveles de detalle: arquitectura por carpetas, interconexión de funciones, flujo de un archivo y flujo intra-función.
- **Memoria cognitiva persistente:** Permite escribir notas personales en cada función, modificar su representación visual y fijar su posición en el lienzo. Si renombras una función sin alterar su estructura, CodeMap migra automáticamente la nota asociada mediante su huella AST.
- **Actualización en vivo:** Supervisa los archivos mientras editas y actualiza automáticamente el grafo en el navegador cada vez que guardas los cambios.

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

Para instalar CodeMap en modo editable durante el desarrollo, utiliza el siguiente comando desde tu entorno virtual:

```bash
pip install --no-build-isolation -e .
```

## Uso

### Comandos principales

```bash
# Analizar un proyecto o archivo y abrir el visor en vivo
codemap ruta/del/proyecto
codemap ruta/del/archivo.py

# Abrir en modo estático (sin supervisar cambios en tiempo real)
codemap ruta/del/proyecto --once

# Incluir funciones privadas o dunder (_helper, __init__, #metodo)
codemap ruta/del/proyecto --include-private

# Opciones adicionales
codemap ruta/del/proyecto --no-browser  # Inicia el servidor sin abrir el navegador
codemap ruta/del/proyecto --no-serve    # Genera únicamente graph.json, sin iniciar el visor

# Gestionar los proyectos registrados en ~/.codemap/
codemap list   # Muestra los proyectos registrados
codemap clean  # Elimina las cachés de proyectos que ya no existen en disco
```

### Controles del visor web

- **Clic en un nodo:** Muestra su firma, docstring, llamadas internas y externas, un enlace para abrirlo en VS Code y el editor de notas personales.
- **Doble clic en un módulo, archivo o función:** Contrae o expande los contenedores y permite explorar el flujo interno de una función.
- **Arrastrar un nodo:** Fija su posición (`pinned`) para conservarla al reorganizar el grafo.
- **`T` + `←` / `→`:** Activa el modo Foco, que resalta las relaciones entre el nodo seleccionado y sus llamadores o funciones llamadas, permitiendo navegar paso a paso.
- **`Ctrl + K`:** Abre el buscador instantáneo de funciones, archivos y notas.
- **`R`:** Reorganiza automáticamente los nodos que no están fijados.