"""Server-to-server endpoints, used ONLY by the signal server.

Not under /api, so the frontend proxy never exposes them, and they
require the shared X-Internal-Key header on top of that.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select

from app.deps import DB, require_internal_key
from app.models import Call, CallStatus, Friendship, FriendshipStatus
from app.routers.friends import friendship_between, involving
from app.schemas import CanCallOut, InternalCallCreate, InternalCallUpdate

router = APIRouter(prefix="/internal", tags=["internal"], dependencies=[Depends(require_internal_key)])

FINAL_STATUSES = {CallStatus.ended, CallStatus.declined, CallStatus.missed, CallStatus.cancelled, CallStatus.failed}


@router.get("/can-call", response_model=CanCallOut)
def can_call(caller_id: int, callee_id: int, db: DB) -> CanCallOut:
    f = friendship_between(db, caller_id, callee_id)
    if f is None or f.status != FriendshipStatus.accepted:
        return CanCallOut(allowed=False, reason="not_friends")
    return CanCallOut(allowed=True)


@router.get("/friends/{user_id}")
def friend_ids(user_id: int, db: DB) -> dict:
    """Used for presence: when a user connects, the signal server tells their friends."""
    rows = db.scalars(
        select(Friendship).where(involving(user_id), Friendship.status == FriendshipStatus.accepted)
    ).all()
    return {"friend_ids": [f.user_high_id if f.user_low_id == user_id else f.user_low_id for f in rows]}


@router.post("/calls")
def create_call(body: InternalCallCreate, db: DB) -> dict:
    db.add(Call(**body.model_dump(), status=CallStatus.ringing))
    db.commit()
    return {"ok": True}


@router.patch("/calls/{call_id}")
def update_call(call_id: uuid.UUID, body: InternalCallUpdate, db: DB) -> dict:
    call = db.get(Call, call_id)
    if call is None:
        raise HTTPException(404, "No such call")
    try:
        new_status = CallStatus(body.status)
    except ValueError:
        raise HTTPException(422, f"Unknown status {body.status!r}")

    call.status = new_status
    call.end_reason = body.end_reason
    if new_status == CallStatus.accepted:
        call.answered_at = func.now()
    if new_status in FINAL_STATUSES:
        call.ended_at = func.now()
    db.commit()
    return {"ok": True}
