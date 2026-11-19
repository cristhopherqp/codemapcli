"""Asignación de `role` inicial y clasificación semántica de llamadas/entradas.

Prioridad de `classify_role()` (la primera que aplica gana):
  1. entry      -> punto de entrada principal real (`main`, top-level, `__main__`,
                   boot lifecycle o ruta HTTP explícita de nivel superior)
  2. io         -> await, I/O conocido o mutación de estado global
  3. decision   -> >= 3 ramas condicionales y >= 2 returns (devuelve caminos distintos)
  4. transform  -> todo lo demás (incluidos handlers secundarios y funciones sin llamadores)
"""

from __future__ import annotations

import re

from codemap.models import (
    EDGE_CALLBACK_REF,
    EDGE_EVENT_LISTENER,
    EDGE_REACTIVE_SUBSCRIBE,
    ENTRY_KIND_MAIN,
    ENTRY_KIND_ROUTE,
    ROLE_DECISION,
    ROLE_ENTRY,
    ROLE_IO,
    ROLE_TRANSFORM,
    FunctionInfo,
)

DECISION_MIN_BRANCHES = 3
DECISION_MIN_RETURNS = 2

# Último segmento de la llamada que delata I/O (archivos, red, BD, procesos).
IO_CALL_NAMES: frozenset[str] = frozenset(
    {
        "open", "input", "fetch", "urlopen",
        "read", "write", "readline", "readlines", "writelines",
        "read_text", "write_text", "read_bytes", "write_bytes",
        "readFile", "writeFile", "readFileSync", "writeFileSync",
        "appendFile", "appendFileSync", "unlink", "mkdir", "makedirs",
        "rmtree", "remove", "rename",
        "execute", "executemany", "commit", "rollback", "query",
        "send", "sendall", "recv", "connect",
        "dump", "load", "save",
    }
)

# Primer segmento de la llamada que delata un módulo/objeto de I/O.
IO_CALL_PREFIXES: frozenset[str] = frozenset(
    {
        "requests", "httpx", "aiohttp", "urllib", "socket", "subprocess",
        "shutil", "sqlite3", "fs", "axios", "http", "https",
        "localStorage", "sessionStorage", "db", "cursor",
    }
)

# Nombres típicos de manejadores de eventos (ya no fuerzan ROLE_ENTRY principal).
EVENT_HANDLER_NAME_PATTERN = re.compile(r"^(on_[a-z]|on[A-Z]|handle_|handle[A-Z])")

# Eventos de ciclo de vida que disparan el arranque inicial de la aplicación.
BOOT_EVENT_NAMES: frozenset[str] = frozenset(
    {"domcontentloaded", "load", "ready", "readystatechange"}
)

EVENT_REGISTRAR_METHODS: frozenset[str] = frozenset(
    {
        "addEventListener",
        "on",
        "once",
        "addListener",
        "prependListener",
        "prependOnceListener",
        "attachEvent",
        "connect",
        "bind_all",
    }
)

EXPLICIT_ROUTE_METHODS: frozenset[str] = frozenset(
    {
        "add_get",
        "add_post",
        "add_put",
        "add_delete",
        "add_patch",
        "add_head",
        "add_options",
        "add_route",
        "add_url_rule",
        "add_api_route",
        "add_websocket_route",
        "createServer",
    }
)

HTTP_ROUTE_VERBS: frozenset[str] = frozenset(
    {"get", "post", "put", "delete", "patch", "options", "head", "all", "route", "use", "ws"}
)

ROUTER_RECEIVER_NAMES: frozenset[str] = frozenset(
    {"app", "router", "server", "bp", "blueprint", "api", "fastify", "koa", "hono", "express"}
)

REACTIVE_REGISTRAR_PATTERN = re.compile(
    r"^(?:subscribe(?:[A-Z_].*)?|watch(?:[A-Z_].*)?|observe(?:[A-Z_].*)?|"
    r"on(?:State)?Change|on_?(?:state_)?change|onUpdate|on_update|"
    r"(?:add|register)(?:Observer|Listener|Subscriber|Callback)|"
    r"(?:add|register)_(?:observer|listener|subscriber|callback))$"
)

REACTIVE_EXCLUDED_PATTERN = re.compile(r"^(?:un|remove|off|dis)", re.IGNORECASE)

NOTIFIER_NAME_PATTERN = re.compile(
    r"^(?:notify|emit|publish|dispatch|broadcast|trigger|fire)(?:[A-Z_].*)?$"
)

NON_CALLBACK_CONTAINERS: frozenset[str] = frozenset(
    {
        "print", "isinstance", "issubclass", "type", "id", "repr", "str", "dir",
        "vars", "help", "hasattr", "getattr", "setattr", "delattr", "len",
        "bool", "int", "float", "typeof", "console.log", "console.debug",
        "console.info", "console.warn", "console.error", "console.dir",
        "console.table", "console.trace", "removeEventListener", "removeListener",
        "off", "unsubscribe",
    }
)

SERVER_CALL_METHODS: frozenset[str] = frozenset(
    {
        "createServer", "listen", "express", "Flask", "FastAPI",
        "HTTPServer", "ThreadingHTTPServer", "SimpleHTTPRequestHandler",
    }
)

STATIC_MOUNT_METHODS: frozenset[str] = frozenset(
    {"static", "add_static", "StaticFiles", "send_from_directory", "serveStatic", "sirv"}
)


def is_io_call(callee: str) -> bool:
    parts = callee.split(".")
    return parts[-1] in IO_CALL_NAMES or parts[0] in IO_CALL_PREFIXES


def looks_like_main_entry_name(short_name: str) -> bool:
    return short_name == "main"


def looks_like_event_handler_name(short_name: str) -> bool:
    return bool(EVENT_HANDLER_NAME_PATTERN.match(short_name))


def looks_like_entry_name(short_name: str) -> bool:
    """Compatibilidad: solo nombres explícitos de arranque principal (`main`)."""
    return looks_like_main_entry_name(short_name)


def is_boot_event_name(event_name: str) -> bool:
    return event_name.strip().lower() in BOOT_EVENT_NAMES


def is_non_callback_container(outer_callee: str) -> bool:
    tail = outer_callee.rsplit(".", 1)[-1]
    return outer_callee in NON_CALLBACK_CONTAINERS or tail in NON_CALLBACK_CONTAINERS


def is_reactive_registrar(outer_callee: str) -> bool:
    tail = outer_callee.rsplit(".", 1)[-1]
    if REACTIVE_EXCLUDED_PATTERN.match(tail):
        return False
    return bool(REACTIVE_REGISTRAR_PATTERN.match(tail))


def is_route_registrar(outer_callee: str, first_string_arg: str = "") -> bool:
    tail = outer_callee.rsplit(".", 1)[-1]
    if tail in EXPLICIT_ROUTE_METHODS:
        return True
    if tail in HTTP_ROUTE_VERBS:
        if first_string_arg.startswith("/"):
            return True
        if "." in outer_callee:
            receiver_parts = outer_callee.rsplit(".", 1)[0].split(".")
            if any(part.lower() in ROUTER_RECEIVER_NAMES for part in receiver_parts):
                return True
    return False


def is_event_registrar(outer_callee: str, first_string_arg: str = "") -> bool:
    tail = outer_callee.rsplit(".", 1)[-1]
    if tail in EVENT_REGISTRAR_METHODS:
        return True
    return is_route_registrar(outer_callee, first_string_arg)


def classify_callback_container(outer_callee: str, first_string_arg: str = "") -> tuple[str, str]:
    """Devuelve `(call_kind, event_or_route)` para un callback pasado a `outer_callee`."""
    if is_reactive_registrar(outer_callee):
        return EDGE_REACTIVE_SUBSCRIBE, first_string_arg
    if is_event_registrar(outer_callee, first_string_arg):
        event_label = first_string_arg
        if not event_label and outer_callee.rsplit(".", 1)[-1] == "createServer":
            event_label = "http:request"
        return EDGE_EVENT_LISTENER, event_label
    return EDGE_CALLBACK_REF, ""


def is_server_call(callee: str) -> bool:
    tail = callee.rsplit(".", 1)[-1]
    if tail in SERVER_CALL_METHODS:
        return True
    if callee in {"web.Application", "web.TCPSite", "uvicorn.run", "app.run", "server.serve_forever"}:
        return True
    return False


def is_startup_hook_call(callee: str) -> bool:
    """True si la llamada registra un hook de arranque de servidor (p. ej. `server.listen`)."""
    tail = callee.rsplit(".", 1)[-1]
    return tail == "listen"


def is_static_mount_call(callee: str) -> bool:
    tail = callee.rsplit(".", 1)[-1]
    if tail in STATIC_MOUNT_METHODS:
        if tail == "static" and not callee.endswith("express.static"):
            return False
        return True
    return False


def is_notifier_name(short_name: str) -> bool:
    return bool(NOTIFIER_NAME_PATTERN.match(short_name))


def classify_role(
    function: FunctionInfo,
    has_callers: bool,
    *,
    entry_kind: str | None = None,
) -> str:
    if entry_kind == ENTRY_KIND_MAIN:
        return ROLE_ENTRY
    if entry_kind == ENTRY_KIND_ROUTE and not has_callers:
        return ROLE_ENTRY
    if entry_kind is None and function.is_entry_hint:
        return ROLE_ENTRY
    if function.has_io:
        return ROLE_IO
    if (
        function.branch_count >= DECISION_MIN_BRANCHES
        and function.return_count >= DECISION_MIN_RETURNS
    ):
        return ROLE_DECISION
    return ROLE_TRANSFORM
