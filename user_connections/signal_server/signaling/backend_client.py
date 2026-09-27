"""Signal server → backend calls.

The signal server has no database. It asks the backend two kinds of things:
  * permission: "may alice call bob?" (are they friends?)
  * bookkeeping: "save this call / update its status" (call history)
"""

import logging

import httpx

from signaling.config import settings

log = logging.getLogger("signal.backend")

_client = httpx.AsyncClient(
    base_url=settings.backend_url,
    headers={"X-Internal-Key": settings.internal_api_key},
    timeout=3,
)


async def can_call(caller_id: int, callee_id: int) -> tuple[bool, str | None]:
    try:
        r = await _client.get("/internal/can-call", params={"caller_id": caller_id, "callee_id": callee_id})
        r.raise_for_status()
        data = r.json()
        return data["allowed"], data.get("reason")
    except httpx.HTTPError as e:
        log.warning("can-call failed: %s", e)
        return False, "backend_unavailable"


async def friend_ids(user_id: int) -> list[int]:
    try:
        r = await _client.get(f"/internal/friends/{user_id}")
        r.raise_for_status()
        return r.json()["friend_ids"]
    except httpx.HTTPError as e:
        log.warning("friends lookup failed: %s", e)
        return []


async def create_call(call_id: str, caller_id: int, callee_id: int, media: str) -> bool:
    try:
        r = await _client.post(
            "/internal/calls",
            json={"id": call_id, "caller_id": caller_id, "callee_id": callee_id, "media": media},
        )
        r.raise_for_status()
        return True
    except httpx.HTTPError as e:
        log.warning("create_call failed: %s", e)
        return False


async def update_call(call_id: str, status: str, end_reason: str | None = None) -> bool:
    try:
        r = await _client.patch(f"/internal/calls/{call_id}", json={"status": status, "end_reason": end_reason})
        r.raise_for_status()
        return True
    except httpx.HTTPError as e:
        log.warning("update_call failed: %s", e)
        return False


async def close() -> None:
    await _client.aclose()
