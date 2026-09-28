"""Short-lived STUN/TURN credentials from Cloudflare Realtime.

Flow (before every call):
    app  ── GET /api/config ──►  backend  ── POST generate-ice-servers ──►  Cloudflare
    app  ◄── iceServers (STUN + TURN, username/credential valid for TTL) ──┘

* The TURN key id + API token stay on the backend. If a credential leaks from an
  app, it expires after TURN_CREDENTIAL_TTL_SECONDS, so nobody can run up the bill.
* STUN is free; only audio actually RELAYED through TURN is billed, and only when
  a direct peer-to-peer path fails.
* Credentials are cached per user and reused while they still have at least
  2/3 of their lifetime left, so an issued credential always outlasts a call
  that starts with it (with the default 4 h TTL: at least ~2.7 h left).
"""

import logging
import threading
import time

import httpx

from app.config import settings

log = logging.getLogger("turn")

_CLOUDFLARE_URL = "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
_cache: dict[int, tuple[float, list[dict]]] = {}  # user_id → (issued_at, ice_servers)
_lock = threading.Lock()


def ice_servers_for(user_id: int) -> tuple[list[dict], str]:
    """Returns (ice_servers, source) where source is "cloudflare" or "fallback"."""
    if not (settings.cloudflare_turn_key_id and settings.cloudflare_turn_api_token):
        return settings.ice_servers, "fallback"

    ttl = settings.turn_credential_ttl_seconds
    with _lock:
        cached = _cache.get(user_id)
    if cached and time.monotonic() - cached[0] < ttl / 3:
        return cached[1], "cloudflare"

    try:
        r = httpx.post(
            _CLOUDFLARE_URL.format(key_id=settings.cloudflare_turn_key_id),
            headers={"Authorization": f"Bearer {settings.cloudflare_turn_api_token}"},
            json={"ttl": ttl},
            timeout=5,
        )
        r.raise_for_status()
        servers = _normalize(r.json()["iceServers"])
    except (httpx.HTTPError, KeyError, ValueError) as e:
        log.warning("⚠ Cloudflare TURN credentials failed (%s); falling back to STUN only", e)
        return settings.ice_servers, "fallback"

    with _lock:
        _cache[user_id] = (time.monotonic(), servers)
    log.info("🔑 issued TURN credentials to user %s (valid %d h)", user_id, ttl // 3600)
    return servers, "cloudflare"


def _normalize(ice_servers) -> list[dict]:
    """Always a list, and without port-53 URLs (browsers block/time out on them)."""
    if isinstance(ice_servers, dict):
        ice_servers = [ice_servers]
    out = []
    for server in ice_servers:
        urls = server["urls"] if isinstance(server["urls"], list) else [server["urls"]]
        urls = [u for u in urls if ":53?" not in u and not u.endswith(":53")]
        if urls:
            out.append({**server, "urls": urls})
    return out
