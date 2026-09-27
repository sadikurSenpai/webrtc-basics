"""Recording uploads, called by the device during a call.

The device never sends media bytes to us. It asks for presigned S3 URLs in
batches, PUTs each 10-second chunk straight to S3, then reports completion.
Per participant that's ~3 small requests for a 10-minute call.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import storage
from app.config import settings
from app.deps import DB, CurrentUser
from app.models import Call, CallRecording, CallStatus, RecordingStatus
from app.schemas import RecordingCompleteIn, RecordingStartIn, RecordingStartOut, UploadUrl

log = logging.getLogger("recordings")
router = APIRouter(prefix="/recordings", tags=["recordings"])

# A recording still "recording" this long after its call ended was abandoned.
ABANDONED_AFTER = timedelta(seconds=90)


@router.post("", response_model=RecordingStartOut)
def start_recording(body: RecordingStartIn, user: CurrentUser, db: DB) -> RecordingStartOut:
    call = db.get(Call, body.call_id)
    if call is None or user.id not in (call.caller_id, call.callee_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such call")
    if call.status != CallStatus.accepted:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Call is {call.status.value}, not in progress")

    prefix = storage.recording_prefix(call.id, user.id)
    rec = CallRecording(
        call_id=call.id,
        user_id=user.id,
        s3_prefix=prefix,
        file_ext=storage.extension_for(body.mime_type),
        mime_type=body.mime_type.split(";")[0],
        status=RecordingStatus.recording,
    )
    db.add(rec)
    try:
        db.commit()
    except IntegrityError:
        raise HTTPException(status.HTTP_409_CONFLICT, "Already recording this call")

    urls = storage.presigned_put_urls(prefix, rec.file_ext, 0, settings.recording_url_batch)
    log.info("🎙 recording started  call %s  user %s  (%s)  → s3://%s/%s",
             str(call.id)[:8], user.username, body.mime_type, settings.s3_bucket, prefix)
    log.info("🔗 issued %d upload URLs (chunks 0–%d) to %s", len(urls), len(urls) - 1, user.username)
    return RecordingStartOut(recording_id=rec.id, upload_urls=[UploadUrl(**u) for u in urls])


def _own_recording(db: Session, recording_id: uuid.UUID, user_id: int) -> CallRecording:
    rec = db.get(CallRecording, recording_id)
    if rec is None or rec.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such recording")
    return rec


@router.post("/{recording_id}/urls", response_model=list[UploadUrl])
def more_urls(recording_id: uuid.UUID, user: CurrentUser, db: DB, start: int = 0) -> list[UploadUrl]:
    rec = _own_recording(db, recording_id, user.id)
    if rec.status != RecordingStatus.recording:
        raise HTTPException(status.HTTP_409_CONFLICT, "Recording already finished")
    urls = storage.presigned_put_urls(rec.s3_prefix, rec.file_ext, start, settings.recording_url_batch)
    log.info("🔗 issued %d upload URLs (chunks %d–%d) to %s", len(urls), start, start + len(urls) - 1, user.username)
    return [UploadUrl(**u) for u in urls]


@router.post("/{recording_id}/complete")
def complete_recording(recording_id: uuid.UUID, body: RecordingCompleteIn, user: CurrentUser, db: DB) -> dict:
    rec = _own_recording(db, recording_id, user.id)
    if rec.status != RecordingStatus.recording:
        return {"status": rec.status.value}

    # Trust but verify: one LIST request tells us what actually reached S3.
    chunks = storage.list_chunks(rec.s3_prefix)
    rec.chunk_count = len(chunks)
    rec.size_bytes = sum(c["size"] for c in chunks)
    rec.duration_seconds = body.duration_seconds
    rec.completed_at = func.now()
    if not chunks:
        rec.status = RecordingStatus.failed
    elif len(chunks) >= body.chunk_count:
        rec.status = RecordingStatus.complete
    else:
        rec.status = RecordingStatus.partial
    db.commit()

    icon = {"complete": "✅", "partial": "⚠", "failed": "❌"}[rec.status.value]
    log.info("%s recording %s  call %s  user %s: %d/%d chunks in S3, %.1f MB, %s",
             icon, rec.status.value, str(rec.call_id)[:8], user.username, len(chunks), body.chunk_count,
             rec.size_bytes / 1e6, _fmt_duration(body.duration_seconds))
    return {"status": rec.status.value}


def reconcile_abandoned(db: Session, rec: CallRecording) -> None:
    """A device that crashed never calls /complete. Decide from what's in S3.

    Done lazily (when an admin looks), so no background worker is needed.
    """
    if rec.status != RecordingStatus.recording:
        return
    call = rec.call
    if call.ended_at is None or datetime.now(UTC) - call.ended_at < ABANDONED_AFTER:
        return  # call still running, or the device may still be uploading
    chunks = storage.list_chunks(rec.s3_prefix)
    rec.chunk_count = len(chunks)
    rec.size_bytes = sum(c["size"] for c in chunks)
    rec.status = RecordingStatus.partial if chunks else RecordingStatus.failed
    rec.completed_at = func.now()
    db.commit()
    log.info("⚠ recording %s (abandoned)  call %s  user %s: %d chunks found in S3",
             rec.status.value, str(rec.call_id)[:8], rec.user.username, len(chunks))


def _fmt_duration(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 60}:{s % 60:02d}"
