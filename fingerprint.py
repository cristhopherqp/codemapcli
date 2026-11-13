"""Huella estructural AST de una función.

Según la especificación se calcula sobre:
  - cantidad de parámetros,
  - secuencia de tipos de nodos AST internos,
  - nombres de funciones invocadas (excluyendo el propio nombre de la función).

No depende del nombre de la función, así que sobrevive a un renombrado.
(La migración de notas que la usa llega en la Etapa 3.)
"""

from __future__ import annotations

import hashlib

FINGERPRINT_LENGTH = 10


def compute_fingerprint(
    param_count: int,
    node_types: list[str],
    called_names: list[str],
    own_name: str,
) -> str:
    calls = [name for name in called_names if name.split(".")[-1] != own_name]
    payload = "|".join(
        [
            str(param_count),
            ",".join(node_types),
            ",".join(calls),
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:FINGERPRINT_LENGTH]
