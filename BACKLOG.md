# Pending & Technical Debt

*The suggested actions are only possible standard steps to take, not the exact root cause of the problem. You should take them into account, but if the issue lies elsewhere, you must find the root cause and fix it.*

## Critical Fixes (Bugs)
- Falsos paquetes npm en alias de rutas de TypeScript (@/...): En resolver.py, resolve_js_module() solo resuelve rutas relativas que empiezan con . (./, ../). Si analizas un proyecto moderno con path aliases (como import { api } from '@/services/api'), el resolver no lo encuentra como archivo interno y classify_js_external() en graph_builder.py lo trata como un paquete scoped de npm (@/services), generando un enlace roto a [npmjs.com/package/@/services](https://npmjs.com/package/@/services).

- Funciones pasadas como referencia (callbacks) no generan aristas: Tanto python_parser.py como js_parser.py solo registran llamadas explícitas (call / call_expression / new_expression). Si el código hace users.map(formatUser) o button.addEventListener('click', handleSave) sin invocar formatUser() con paréntesis, CodeMap no dibujará la flecha hacia formatUser ni hacia handleSave.   

- La navegación por teclado en Modo Foco (→) solo sigue una rama: En app.js, la función stepTrace("forward") ordena alfabéticamente las funciones llamadas (callees) y salta siempre a callees[0]. Si una función orquestadora llama a 4 funciones distintas, con el teclado entrarás siempre en la primera por orden alfabético y tendrás que usar el ratón para explorar las otras 3.   

- Desfase espacial de nodos fijados (pinned) al cambiar de nivel: En runElkLayout(), los nodos con pinned: true restauran sus coordenadas (x, y) guardadas, mientras ELKjs recalcula desde cero los nodos no fijados. Si fijas nodos en Nivel 2 y luego pasas a Nivel 3+ (donde los contenedores crecen mucho al expandir los pasos internos de cada función), los nodos fijados pueden quedar superpuestos o estirar en exceso los contenedores padre.   

- Solo lee el .gitignore de la raíz: En discovery.py, load_gitignore(root) únicamente carga el archivo .gitignore del directorio principal. En monorepos o proyectos que tienen .gitignore adicionales dentro de subcarpetas (frontend/.gitignore, backend/.gitignore), esos archivos ignorados sí serán escaneados.   

## Improvements and refactoring

- Agregar una función en donde la IA te explica todo el flujo hasta el punto en el que esta, solo funciona con once.


## Under Observation & Edge Cases

