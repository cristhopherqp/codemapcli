"""Script de ejemplo: un solo archivo con 2 funciones (activa el Nivel 3+)."""

import json


def load_scores(path: str) -> list[int]:
    """Lee puntajes desde un JSON y descarta los inválidos."""
    with open(path, encoding="utf-8") as handle:
        raw = json.load(handle)
    scores = []
    for value in raw:
        if not isinstance(value, int):
            continue
        elif value < 0:
            scores.append(0)
        else:
            scores.append(value)
    return scores

def main() -> None:
    scores = load_scores("scores.json")
    if not scores:
        print("sin datos")
        return
    print(sum(scores) / len(scores))

if __name__ == "__main__":
    main()
