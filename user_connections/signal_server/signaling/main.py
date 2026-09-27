"""Signal server: WebSocket endpoint for the apps + internal HTTP for the backend.

Run from user_connections/signal_server:
    uv run uvicorn signaling.main:app --reload --port 8001
"""

import asyncio
import json
import logging
import secrets
from contextlib import asynccontextmanager
from typing import Annotated

import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from signaling import backend_client
from signaling.config import settings
from signaling.hub import Client, hub

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s | %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("signal")


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await backend_client.close()


app = FastAPI(title="user_connections signal server", lifespan=lifespan)


# ============================================================ WebSocket


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    """One WebSocket per logged-in app.

    1. Browser connects to /ws.
    2. Its FIRST message must be {"type": "auth", "token": "<JWT from backend login>"}.
       (Not in the URL: URLs end up in proxy/ngrok logs.)
    3. After that it's JSON messages both ways until the socket closes.
    """
    await ws.accept()

    try:
        first = json.loads(await asyncio.wait_for(ws.receive_text(), settings.auth_timeout_seconds))
        if first.get("type") != "auth":
            raise ValueError("first message must be auth")
        claims = jwt.decode(first.get("token", ""), settings.jwt_secret, algorithms=["HS256"])
    except (asyncio.TimeoutError, ValueError, jwt.PyJWTError, WebSocketDisconnect) as e:
        log.info("rejected connection: %s", e or type(e).__name__)
        try:
            await ws.send_text(json.dumps({"type": "auth.error", "message": "Invalid or missing token", "trace": []}))
            await ws.close(code=4401)
        except Exception:
            pass
        return

    client = Client(user_id=int(claims["sub"]), username=claims["username"], ws=ws)
    try:
        await hub.connect(client)
        log.info("🟢 %s connected (%d online)", client.username, len(hub.clients))
        while True:
            raw = await ws.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await hub.error(client, "bad_json", "Message is not valid JSON")
                continue
            if message.get("type") != "ping":
                log.info("⬅ %s: %s", client.username, message.get("type"))
            await hub.handle(client, message)
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(client)
        log.info("🔴 %s disconnected (%d online)", client.username, len(hub.clients))


# ============================================ internal HTTP (backend only)


def require_internal_key(x_internal_key: Annotated[str | None, Header()] = None) -> None:
    if not x_internal_key or not secrets.compare_digest(x_internal_key, settings.internal_api_key):
        raise HTTPException(403, "Internal endpoint")


class NotifyIn(BaseModel):
    user_id: int
    event: str
    data: dict = {}


@app.get("/internal/presence", dependencies=[Depends(require_internal_key)])
def presence(user_ids: str = "") -> dict:
    ids = [int(x) for x in user_ids.split(",") if x.strip().isdigit()]
    return {"online": [i for i in ids if hub.is_online(i)]}


@app.post("/internal/notify", dependencies=[Depends(require_internal_key)])
async def notify(body: NotifyIn) -> dict:
    return {"delivered": await hub.notify(body.user_id, body.event, body.data)}


@app.get("/health")
def health() -> dict:
    return {"ok": True, "online_users": len(hub.clients), "active_calls": len(hub.calls)}
