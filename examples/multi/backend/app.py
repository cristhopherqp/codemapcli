"""Punto de entrada del backend de ejemplo."""

import services.users as users_mod
from services import UserService
from utils import slugify


def main() -> None:
    service = UserService(db=None)
    for raw in ["ada", "linus"]:
        user = service.get_user(raw)
        print(slugify(user["name"]))
    users_mod.build_report([])


if __name__ == "__main__":
    main()
