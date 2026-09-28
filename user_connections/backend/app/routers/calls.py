from fastapi import APIRouter
from sqlalchemy import or_, select

from app import turn
from app.config import settings
from app.deps import DB, CurrentUser
from app.models import Call
from app.schemas import CallOut, ClientConfigOut, UserOut

router = APIRouter(tags=["calls"])


@router.get("/calls", response_model=list[CallOut])
def call_history(user: CurrentUser, db: DB) -> list[CallOut]:
    calls = db.scalars(
        select(Call)
        .where(or_(Call.caller_id == user.id, Call.callee_id == user.id))
        .order_by(Call.created_at.desc())
        .limit(30)
    ).all()
    return [
        CallOut(
            id=c.id,
            direction="outgoing" if c.caller_id == user.id else "incoming",
            other=UserOut.model_validate(c.callee if c.caller_id == user.id else c.caller),
            media=c.media,
            status=c.status.value,
            end_reason=c.end_reason,
            created_at=c.created_at,
            answered_at=c.answered_at,
            ended_at=c.ended_at,
        )
        for c in calls
    ]


@router.get("/config", response_model=ClientConfigOut)
def client_config(user: CurrentUser) -> ClientConfigOut:
    """What the app needs before EVERY call: STUN + short-lived TURN credentials."""
    servers, source = turn.ice_servers_for(user.id)
    return ClientConfigOut(
        ice_servers=servers,
        ice_source=source,
        turn_credential_ttl_seconds=settings.turn_credential_ttl_seconds,
    )
