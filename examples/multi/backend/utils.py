def normalize(text: str) -> str:
    return text.strip().lower()


def slugify(text: str) -> str:
    return normalize(text).replace(" ", "-")
