"""Small admin commands. Run from user_connections/backend:

    uv run python -m app.cli make-admin <username>
    uv run python -m app.cli remove-admin <username>
    uv run python -m app.cli list-admins
"""

import sys

from sqlalchemy import select

from app.db import SessionLocal
from app.models import User


def set_admin(username: str, value: bool) -> None:
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == username.lower()))
        if user is None:
            sys.exit(f'No user "{username}". They must log in once first.')
        user.is_admin = value
        db.commit()
        print(f"{user.username}: is_admin = {value}")


def list_admins() -> None:
    with SessionLocal() as db:
        admins = db.scalars(select(User.username).where(User.is_admin)).all()
        print("\n".join(admins) or "(no admins)")


if __name__ == "__main__":
    match sys.argv[1:]:
        case ["make-admin", name]:
            set_admin(name, True)
        case ["remove-admin", name]:
            set_admin(name, False)
        case ["list-admins"]:
            list_admins()
        case _:
            sys.exit(__doc__)
