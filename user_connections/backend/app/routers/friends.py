from fastapi import APIRouter, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app import signal_client
from app.deps import DB, CurrentUser
from app.models import Friendship, FriendshipStatus, User
from app.schemas import FriendOut, FriendRequestIn, FriendRequestOut, UserOut

router = APIRouter(prefix="/friends", tags=["friends"])


def ordered_pair(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def friendship_between(db: Session, a: int, b: int) -> Friendship | None:
    low, high = ordered_pair(a, b)
    return db.scalar(
        select(Friendship).where(Friendship.user_low_id == low, Friendship.user_high_id == high)
    )


def involving(user_id: int):
    return or_(Friendship.user_low_id == user_id, Friendship.user_high_id == user_id)


@router.get("", response_model=list[FriendOut])
def list_friends(user: CurrentUser, db: DB) -> list[FriendOut]:
    rows = db.scalars(
        select(Friendship).where(involving(user.id), Friendship.status == FriendshipStatus.accepted)
    ).all()
    friends = sorted((f.other_user(user.id) for f in rows), key=lambda u: u.username)
    online = signal_client.online_user_ids([f.id for f in friends])
    return [
        FriendOut(id=f.id, username=f.username, online=None if online is None else f.id in online)
        for f in friends
    ]


@router.get("/requests", response_model=list[FriendRequestOut])
def list_requests(user: CurrentUser, db: DB) -> list[FriendRequestOut]:
    rows = db.scalars(
        select(Friendship)
        .where(involving(user.id), Friendship.status == FriendshipStatus.pending)
        .order_by(Friendship.updated_at.desc())
    ).all()
    return [
        FriendRequestOut(
            id=f.id,
            user=UserOut.model_validate(f.other_user(user.id)),
            direction="outgoing" if f.requested_by_id == user.id else "incoming",
            created_at=f.updated_at,
        )
        for f in rows
    ]


@router.post("/requests")
def send_request(body: FriendRequestIn, user: CurrentUser, db: DB) -> dict:
    target = db.scalar(select(User).where(User.username == body.username.strip().lower()))
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f'No user named "{body.username}"')
    if target.id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't add yourself")

    f = friendship_between(db, user.id, target.id)
    if f and f.status == FriendshipStatus.accepted:
        raise HTTPException(status.HTTP_409_CONFLICT, "You are already friends")
    if f and f.status == FriendshipStatus.pending and f.requested_by_id == user.id:
        raise HTTPException(status.HTTP_409_CONFLICT, "Request already sent")

    if f and f.status == FriendshipStatus.pending:
        # They already asked us → sending a request back means "yes".
        f.status = FriendshipStatus.accepted
        db.commit()
        signal_client.notify(target.id, "friend.accepted", {"username": user.username})
        return {"result": "accepted"}

    if f is None:
        low, high = ordered_pair(user.id, target.id)
        f = Friendship(user_low_id=low, user_high_id=high)
        db.add(f)
    f.requested_by_id = user.id
    f.status = FriendshipStatus.pending  # also re-opens a previously declined request
    db.commit()
    signal_client.notify(target.id, "friend.request", {"username": user.username})
    return {"result": "requested"}


def _pending_incoming(db: Session, request_id: int, user_id: int) -> Friendship:
    f = db.get(Friendship, request_id)
    if (
        f is None
        or f.status != FriendshipStatus.pending
        or user_id not in (f.user_low_id, f.user_high_id)
        or f.requested_by_id == user_id
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such pending request")
    return f


@router.post("/requests/{request_id}/accept")
def accept_request(request_id: int, user: CurrentUser, db: DB) -> dict:
    f = _pending_incoming(db, request_id, user.id)
    f.status = FriendshipStatus.accepted
    db.commit()
    signal_client.notify(f.requested_by_id, "friend.accepted", {"username": user.username})
    return {"result": "accepted"}


@router.post("/requests/{request_id}/decline")
def decline_request(request_id: int, user: CurrentUser, db: DB) -> dict:
    f = _pending_incoming(db, request_id, user.id)
    f.status = FriendshipStatus.declined
    db.commit()
    signal_client.notify(f.requested_by_id, "friend.declined", {"username": user.username})
    return {"result": "declined"}


@router.delete("/{friend_id}")
def remove_friend(friend_id: int, user: CurrentUser, db: DB) -> dict:
    f = friendship_between(db, user.id, friend_id)
    if f is None or f.status != FriendshipStatus.accepted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not friends")
    db.delete(f)
    db.commit()
    signal_client.notify(friend_id, "friend.removed", {"username": user.username})
    return {"result": "removed"}
