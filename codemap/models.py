"""Estructuras de datos intermedias entre parsers, resolver y generador de grafo.

Son dataclasses planas: los parsers las llenan, el resolver las lee y el
generador las convierte al esquema de graph.json.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Roles visuales de la especificación (taxonomía de formas).
ROLE_ENTRY = "entry"          # óvalo
ROLE_TRANSFORM = "transform"  # rectángulo redondeado
ROLE_DECISION = "decision"    # rombo
ROLE_IO = "io"                # cilindro

# Semántica de llamadas / aristas del grafo.
EDGE_DIRECT_CALL = "direct_call"
EDGE_EVENT_LISTENER = "event_listener"
EDGE_CALLBACK_REF = "callback_ref"
EDGE_REACTIVE_SUBSCRIBE = "reactive_subscribe"
EDGE_REACTIVE_TRIGGER = "reactive_trigger"
EDGE_LOADS_SCRIPT = "loads_script"
EDGE_SERVES_HTML = "serves_html"

# Clasificación semántica de puntos de entrada / handlers / funciones sin llamadas.
ENTRY_KIND_MAIN = "main"
ENTRY_KIND_ROUTE = "route_handler"
ENTRY_KIND_EVENT = "event_handler"
ENTRY_KIND_UNREFERENCED = "unreferenced"


@dataclass
class FlowEdge:
    """Arista dirigida entre pasos del flujo intra-función (Nivel 3+)."""

    target: str
    label: str = ""
    kind: str = "flow"  # "flow" | "branch_yes" | "branch_no" | "exception"


@dataclass
class FlowStep:
    """Un paso o sub-contenedor del flujo intra-función (Nivel 3+)."""

    id: str
    role: str
    label: str
    code: str = ""
    parent_id: str | None = None
    is_container: bool = False
    kind: str = "step"  # "step" | "loop" | "event" | "merge" | "except"
    edges: list[FlowEdge] = field(default_factory=list)


@dataclass
class CallSite:
    """Una invocación o referencia a función encontrada en una función o a nivel de módulo.

    `callee` es el texto normalizado de lo invocado/referenciado: "foo", "self.bar",
    "mod.func", "obj.method". El resolver decide a qué función apunta.
    """

    callee: str
    line: int
    kind: str = EDGE_DIRECT_CALL
    is_invocation: bool = True
    via: str = ""
    event: str = ""
    is_top_level_stmt: bool = False
    is_main_guard: bool = False


@dataclass
class ScriptRef:
    """Etiqueta <script src="..."> detectada en un archivo HTML."""

    src: str
    line: int
    is_module: bool = False


@dataclass
class HtmlRef:
    """Referencia literal a un archivo .html/.htm desde código JS/TS o Python."""

    target: str
    line: int
    owner_qualname: str | None = None


@dataclass
class FunctionInfo:
    """Función, método, arrow function o callback nombrado por contexto."""

    qualname: str              # "Value.backward", "outer.inner", "app.get[/u]@L12"
    short_name: str            # "backward"
    class_name: str | None     # clase contenedora inmediata (si es método)
    container: str | None      # qualname de la función que la contiene (anidadas)
    line: int                  # 1-based
    signature: str
    docstring: str
    param_count: int
    calls: list[CallSite] = field(default_factory=list)
    internal_flow: list[FlowStep] = field(default_factory=list)
    branch_count: int = 0      # if / elif / case ...
    return_count: int = 0
    has_io: bool = False       # await, I/O conocido o mutación de estado global
    is_entry_hint: bool = False  # pista de entrada principal explícita (main, CLI, boot)
    entry_kind_hint: str | None = None  # "main" | "route_handler" | "event_handler" | None
    event_trigger: str = ""    # ruta HTTP o evento asociado (si aplica)
    callback_via: str = ""     # callee que registró este callback de módulo (si aplica)
    fingerprint: str = ""


@dataclass
class ImportBinding:
    """Un nombre local introducido por un import.

    - `from a.b import c as d`   -> local_name="d", module="a.b", imported_name="c"
    - `import a.b`               -> local_name="a.b", module="a.b", imported_name=None
    - `import { c } from './b'`  -> local_name="c", module="./b", imported_name="c"
    - `import * as ns from './b'`-> local_name="ns", module="./b", imported_name=None

    imported_name=None significa que el nombre local es el módulo completo.
    """

    local_name: str
    module: str
    imported_name: str | None
    line: int


@dataclass
class FileAnalysis:
    """Resultado de analizar un archivo fuente."""

    path: str                  # ruta absoluta POSIX
    language: str              # "python" | "javascript" | "typescript" | "tsx" | "html"
    docstring: str = ""
    functions: list[FunctionInfo] = field(default_factory=list)
    imports: list[ImportBinding] = field(default_factory=list)
    class_names: set[str] = field(default_factory=set)
    default_export: str | None = None  # qualname exportado por defecto (JS/TS)
    module_calls: list[CallSite] = field(default_factory=list)
    script_refs: list[ScriptRef] = field(default_factory=list)
    html_refs: list[HtmlRef] = field(default_factory=list)
    serves_static_dirs: list[str] = field(default_factory=list)
    is_server_file: bool = False
