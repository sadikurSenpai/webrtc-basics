"""Backend → signal server calls (presence lookups, real-time notifications).

The backend never holds WebSockets itself; the signal server owns every live
connection. So when the backend needs to know "who is online" or wants to
push "you have a friend request", it asks the signal server.
"""

import logging

import httpx

from app.config import settings

log = logging.getLogger(__name__)
_HEADERS = {"X-Internal-Key": settings.internal_api_key}


def online_user_ids(user_ids: list[int]) -> set[int] | None:
    """Returns None if the signal server is unreachable (online status unknown)."""
    if not user_ids:
        return set()
    try:
        r = httpx.get(
            f"{settings.signal_server_url}/internal/presence",
            params={"user_ids": ",".join(map(str, user_ids))},
            headers=_HEADERS,
            timeout=2,
        )
        r.raise_for_status()
        return set(r.json()["online"])
    except httpx.HTTPError as e:
        log.warning("presence lookup failed: %s", e)
        return None


def notify(user_id: int, event: str, data: dict | None = None) -> None:
    """Fire-and-forget push to one user's open WebSocket (if any)."""
    try:
        httpx.post(
            f"{settings.signal_server_url}/internal/notify",
            json={"user_id": user_id, "event": event, "data": data or {}},
            headers=_HEADERS,
            timeout=2,
        )
    except httpx.HTTPError as e:
        log.warning("notify(%s, %s) failed: %s", user_id, event, e)
