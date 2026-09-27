"""Admin-only views of call recordings (the frontend's /recordings page)."""

import uuid

from fastapi import APIRouter, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app import storage
from app.deps import DB, AdminUser
from app.models import Call, CallRecording
from app.routers.recordings import reconcile_abandoned
from app.schemas import AdminCallRow, AdminRecordingOut, UserOut

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/recordings", response_model=list[AdminCallRow])
def list_recorded_calls(_: AdminUser, db: DB, limit: int = 100) -> list[AdminCallRow]:
    """One row per call (not per recording); each row lists both sides' status."""
    recordings = db.scalars(
        select(CallRecording)
        .options(selectinload(CallRecording.call).selectinload(Call.caller),
                 selectinload(CallRecording.call).selectinload(Call.callee),
                 selectinload(CallRecording.user))
        .order_by(CallRecording.started_at.desc())
    ).all()

    by_call: dict[uuid.UUID, list[CallRecording]] = {}
    for rec in recordings:
        by_call.setdefault(rec.call_id, []).append(rec)

    rows = []
    for recs in list(by_call.values())[:limit]:
        call = recs[0].call
        rows.append(AdminCallRow(
            call_id=call.id,
            caller=UserOut.model_validate(call.caller),
            callee=UserOut.model_validate(call.callee),
            media=call.media,
            call_status=call.status.value,
            created_at=call.created_at,
            answered_at=call.answered_at,
            ended_at=call.ended_at,
            sides=[
                {"username": r.user.username, "status": r.status.value,
                 "chunk_count": r.chunk_count, "size_bytes": r.size_bytes}
                for r in sorted(recs, key=lambda r: r.user_id != call.caller_id)  # caller first
            ],
        ))
    return rows


@router.get("/calls/{call_id}/recordings", response_model=list[AdminRecordingOut])
def call_recordings(call_id: uuid.UUID, _: AdminUser, db: DB) -> list[AdminRecordingOut]:
    call = db.get(Call, call_id)
    if call is None:
        raise HTTPException(404, "No such call")
    recs = db.scalars(select(CallRecording).where(CallRecording.call_id == call_id)).all()

    out = []
    for rec in sorted(recs, key=lambda r: r.user_id != call.caller_id):  # caller first
        reconcile_abandoned(db, rec)
        # Chunk keys come from S3 itself, so gaps (a failed upload) are skipped.
        keys = [c["key"] for c in storage.list_chunks(rec.s3_prefix)]
        out.append(AdminRecordingOut(
            recording_id=rec.id,
            user=UserOut.model_validate(rec.user),
            role="caller" if rec.user_id == call.caller_id else "callee",
            status=rec.status.value,
            mime_type=rec.mime_type,
            chunk_count=len(keys),
            size_bytes=rec.size_bytes,
            duration_seconds=rec.duration_seconds,
            started_at=rec.started_at,
            chunk_urls=[storage.presigned_get_url(k) for k in keys],
        ))
    return out
