"""Servicio de usuarios con acceso a datos."""

from ..utils import normalize


class UserService:
    def __init__(self, db) -> None:
        self.db = db

    def get_user(self, name: str) -> dict:
        """Busca un usuario por nombre normalizado."""
        clean = normalize(name)
        self._validate(clean)
        rows = self.db.query("SELECT * FROM users WHERE name = ?", clean) if self.db else []
        return rows[0] if rows else {"name": clean}

    def _validate(self, name: str) -> None:
        if not name:
            raise ValueError("nombre vacío")


def build_report(users: list[dict]) -> str:
    """Clasifica el tamaño del lote."""
    if not users:
        return "vacío"
    elif len(users) < 10:
        return "pequeño"
    elif len(users) < 100:
        return "mediano"
    return "grande"
