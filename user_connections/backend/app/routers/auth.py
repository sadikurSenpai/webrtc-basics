"""Login = sign-up: an unknown username is created on the spot with the given password."""

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select

from app.deps import DB, CurrentUser
from app.models import User
from app.schemas import LoginIn, LoginOut, UserOut
from app.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginOut)
def login(body: LoginIn, db: DB) -> LoginOut:
    username = body.username.lower()
    user = db.scalar(select(User).where(User.username == username))
    created = False

    if user is None:
        user = User(username=username, password_hash=hash_password(body.password))
        db.add(user)
        created = True
    elif not verify_password(user.password_hash, body.password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong password for this username")

    user.last_login_at = func.now()
    db.commit()
    return LoginOut(
        access_token=create_access_token(user.id, user.username),
        user=UserOut.model_validate(user),
        created=created,
    )


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser) -> User:
    return user
