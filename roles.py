"""Asignación de `role` inicial a cada función (taxonomía de formas).

Prioridad (la primera que aplica gana):
  1. entry      -> pista explícita (main, decorador de ruta, handler, callback de módulo)
  2. io         -> await, I/O conocido o mutación de estado global
  3. decision   -> >= 3 ramas condicionales y >= 2 returns (devuelve caminos distintos)
  4. entry      -> función (no método) que nadie del proyecto invoca
  5. transform  -> todo lo demás
"""

from __future__ import annotations

import re

from codemap.models import (
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

# Nombres típicos de funciones de entrada / manejadores de eventos.
ENTRY_NAME_PATTERN = re.compile(r"^(main|on_[a-z]|on[A-Z]|handle_|handle[A-Z])")


def is_io_call(callee: str) -> bool:
    parts = callee.split(".")
    return parts[-1] in IO_CALL_NAMES or parts[0] in IO_CALL_PREFIXES


def looks_like_entry_name(short_name: str) -> bool:
    return short_name == "main" or bool(ENTRY_NAME_PATTERN.match(short_name))


def classify_role(function: FunctionInfo, has_callers: bool) -> str:
    if function.is_entry_hint:
        return ROLE_ENTRY
    if function.has_io:
        return ROLE_IO
    if (
        function.branch_count >= DECISION_MIN_BRANCHES
        and function.return_count >= DECISION_MIN_RETURNS
    ):
        return ROLE_DECISION
    if not has_callers and function.class_name is None:
        return ROLE_ENTRY
    return ROLE_TRANSFORM
