"""The heart of the signal server: who is connected, which calls exist, and
the call state machine.

    call.invite ──► RINGING ──call.accept──► ACTIVE ──call.hangup──► (ended)
                       │  └──call.decline──► (declined)
                       │  └──call.cancel───► (cancelled)
                       └──── timeout ──────► (missed)

While a call is ACTIVE, the server relays WebRTC messages (offer, answer,
ICE candidates, media state) between the two participants WITHOUT reading
them. It only checks that the sender really is in that call.

Every message we send carries a "trace": a list of what the server just did,
so the frontend can show the server's side of the story.

State lives in memory. That's fine for one process; with several signal
server instances you'd move it to Redis (and route messages via pub/sub).
"""

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field

from fastapi import WebSocket

from signaling import backend_client
from signaling.config import settings

log = logging.getLogger("signal.hub")

# Message types relayed unchanged between the two people in an active call.
RELAYED = {"webrtc.offer", "webrtc.answer", "webrtc.candidate", "media.state"}


@dataclass(eq=False)
class Client:
    user_id: int
    username: str
    ws: WebSocket
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, message: dict) -> bool:
        # One WebSocket may be written to from several tasks (relays, timers,
        # backend notifications), so serialize the writes.
        async with self._lock:
            try:
                await self.ws.send_text(json.dumps(message))
                return True
            except Exception:  # socket already closed
                return False


@dataclass(eq=False)
class CallSession:
    id: str
    caller_id: int
    callee_id: int
    caller_name: str
    callee_name: str
    media: str  # "audio" | "video"
    state: str = "ringing"  # "ringing" | "active"
    created_at: float = field(default_factory=time.monotonic)
    ring_timer: asyncio.Task | None = None

    def other(self, user_id: int) -> int:
        return self.callee_id if user_id == self.caller_id else self.caller_id

    def name_of(self, user_id: int) -> str:
        return self.caller_name if user_id == self.caller_id else self.callee_name


class Hub:
    def __init__(self) -> None:
        self.clients: dict[int, Client] = {}
        self.calls: dict[str, CallSession] = {}
        self.call_of_user: dict[int, str] = {}

    # ------------------------------------------------------------------ utils

    def is_online(self, user_id: int) -> bool:
        return user_id in self.clients

    async def send(self, to_user_id: int, type_: str, trace: list[str] | None = None, /, **data) -> bool:
        # Positional-only (/) so message fields like user_id=... can't collide with the parameters.
        client = self.clients.get(to_user_id)
        if client is None:
            return False
        return await client.send({"type": type_, **data, "trace": trace or []})

    async def error(self, client: Client, code: str, message: str, trace: list[str] | None = None, **data) -> None:
        log.info("  ✗ %s: %s", code, message)
        await client.send({"type": "error", "code": code, "message": message, **data, "trace": trace or []})

    # ------------------------------------------------------ connect/disconnect

    async def connect(self, client: Client) -> None:
        trace = [f"Verified the login token (JWT signature + expiry) → you are {client.username} (id {client.user_id})"]

        old = self.clients.get(client.user_id)
        if old is not None:
            # Same user opened the app somewhere else: newest connection wins.
            await old.send({"type": "session.replaced", "trace": ["You connected from another tab/device"]})
            try:
                await old.ws.close(code=4000)
            except Exception:
                pass  # already closed
            trace.append("Closed your previous connection (another tab/device)")
            if client.user_id in self.call_of_user:
                call = self.calls[self.call_of_user[client.user_id]]
                await self.end_call(call, "failed", "reconnected", client.user_id)
                trace.append("Ended the call your old connection was in")

        self.clients[client.user_id] = client
        trace.append("Registered you as ONLINE; friends are notified")
        await client.send({"type": "auth.ok", "user": {"id": client.user_id, "username": client.username}, "trace": trace})
        await self._broadcast_presence(client, online=True)

    async def disconnect(self, client: Client) -> None:
        if self.clients.get(client.user_id) is not client:
            return  # already replaced by a newer connection
        del self.clients[client.user_id]

        call_id = self.call_of_user.get(client.user_id)
        if call_id:
            call = self.calls[call_id]
            if call.state == "active":
                await self.end_call(call, "failed", "peer_disconnected", client.user_id)
            elif client.user_id == call.caller_id:
                await self.end_call(call, "cancelled", "caller_disconnected", client.user_id)
            else:
                await self.end_call(call, "missed", "callee_disconnected", client.user_id)

        await self._broadcast_presence(client, online=False)

    async def _broadcast_presence(self, client: Client, online: bool) -> None:
        for fid in await backend_client.friend_ids(client.user_id):
            await self.send(
                fid,
                "presence",
                [f"{client.username} {'connected to' if online else 'disconnected from'} the signal server"],
                user_id=client.user_id,
                online=online,
            )

    # ------------------------------------------------------------- dispatcher

    async def handle(self, client: Client, message: dict) -> None:
        type_ = message.get("type")
        if type_ in RELAYED:
            return await self.relay(client, message)
        handler = {
            "call.invite": self.on_invite,
            "call.accept": self.on_accept,
            "call.decline": self.on_decline,
            "call.cancel": self.on_cancel,
            "call.hangup": self.on_hangup,
            "ping": self.on_ping,
        }.get(type_)
        if handler is None:
            return await self.error(client, "unknown_type", f"Unknown message type {type_!r}")
        await handler(client, message)

    async def on_ping(self, client: Client, _: dict) -> None:
        await client.send({"type": "pong", "trace": []})

    # ------------------------------------------------------------ call flow

    async def on_invite(self, client: Client, msg: dict) -> None:
        callee_id = msg.get("to_user_id")
        media = "video" if msg.get("media") == "video" else "audio"
        trace = [f"Received call.invite from {client.username} → user {callee_id} ({media})"]

        if client.user_id in self.call_of_user:
            return await self.error(client, "busy_self", "You are already in a call", trace)
        if not isinstance(callee_id, int) or callee_id == client.user_id:
            return await self.error(client, "bad_request", "Invalid callee", trace)

        allowed, reason = await backend_client.can_call(client.user_id, callee_id)
        trace.append(f"Asked backend GET /internal/can-call → {'allowed (you are friends)' if allowed else reason}")
        if not allowed:
            return await self.error(client, reason or "not_allowed", "You can only call accepted friends", trace)

        callee = self.clients.get(callee_id)
        if callee is None:
            trace.append("Callee has no open WebSocket. (A real mobile backend would send a VoIP push notification here.)")
            return await self.error(client, "offline", "User is offline", trace)
        trace.append(f"{callee.username} is online")

        if callee_id in self.call_of_user:
            trace.append(f"{callee.username} is already in another call")
            return await self.error(client, "busy", f"{callee.username} is busy", trace)

        call = CallSession(
            id=str(uuid.uuid4()),
            caller_id=client.user_id,
            callee_id=callee_id,
            caller_name=client.username,
            callee_name=callee.username,
            media=media,
        )
        self.calls[call.id] = call
        self.call_of_user[client.user_id] = call.id
        self.call_of_user[callee_id] = call.id
        trace.append(f"Created call {call.id[:8]}… (state: RINGING); both users marked busy")

        saved = await backend_client.create_call(call.id, client.user_id, callee_id, media)
        trace.append("Saved call to backend DB (POST /internal/calls)" if saved else "⚠ Could not save call history (backend down?)")

        call.ring_timer = asyncio.create_task(self._ring_timeout(call))
        trace.append(f"Started {settings.ring_timeout_seconds}s ring timer")

        await self.send(
            callee_id,
            "call.incoming",
            [f"{client.username} is calling you; server created call {call.id[:8]}…",
             "Waiting for you to accept or decline"],
            call_id=call.id,
            media=media,
            from_user={"id": client.user_id, "username": client.username},
        )
        trace.append(f"Sent call.incoming to {callee.username}")
        await client.send({"type": "call.ringing", "call_id": call.id, "media": media,
                           "to_user": {"id": callee_id, "username": callee.username}, "trace": trace})
        log.info("📞 %s → %s ringing (%s, call %s)", client.username, callee.username, media, call.id[:8])

    async def _ring_timeout(self, call: CallSession) -> None:
        await asyncio.sleep(settings.ring_timeout_seconds)
        if self.calls.get(call.id) is call and call.state == "ringing":
            call.ring_timer = None  # this task is ending on its own
            await self.end_call(call, "missed", "no_answer", None)

    def _own_call(self, client: Client, msg: dict) -> CallSession | None:
        call = self.calls.get(msg.get("call_id", ""))
        if call is None or client.user_id not in (call.caller_id, call.callee_id):
            return None
        return call

    async def on_accept(self, client: Client, msg: dict) -> None:
        call = self._own_call(client, msg)
        if call is None or call.state != "ringing" or client.user_id != call.callee_id:
            return await self.error(client, "invalid_call", "No ringing call to accept")

        call.state = "active"
        self._stop_ring_timer(call)
        await backend_client.update_call(call.id, "accepted")
        common = [
            f"{call.callee_name} accepted call {call.id[:8]}… (state: ACTIVE)",
            "Stopped ring timer, updated call in backend DB",
            f"From now on I relay WebRTC messages between {call.caller_name} and {call.callee_name}",
        ]
        await self.send(call.caller_id, "call.accepted", common + ["You are the caller → create the OFFER now"],
                        call_id=call.id, role="caller")
        await self.send(call.callee_id, "call.accepted", common + ["You are the callee → wait for the OFFER"],
                        call_id=call.id, role="callee")
        log.info("✅ call %s accepted", call.id[:8])

    async def on_decline(self, client: Client, msg: dict) -> None:
        call = self._own_call(client, msg)
        if call is None or call.state != "ringing" or client.user_id != call.callee_id:
            return await self.error(client, "invalid_call", "No ringing call to decline")
        await self.end_call(call, "declined", "declined", client.user_id)

    async def on_cancel(self, client: Client, msg: dict) -> None:
        call = self._own_call(client, msg)
        if call is None or call.state != "ringing" or client.user_id != call.caller_id:
            return await self.error(client, "invalid_call", "No ringing call to cancel")
        await self.end_call(call, "cancelled", "caller_cancelled", client.user_id)

    async def on_hangup(self, client: Client, msg: dict) -> None:
        call = self._own_call(client, msg)
        if call is None:
            return await self.error(client, "invalid_call", "No such call")
        await self.end_call(call, "ended", msg.get("reason") or "hangup", client.user_id)

    async def end_call(self, call: CallSession, status: str, reason: str, by_user_id: int | None) -> None:
        if self.calls.pop(call.id, None) is None:
            return  # already ended
        self._stop_ring_timer(call)
        for uid in (call.caller_id, call.callee_id):
            if self.call_of_user.get(uid) == call.id:
                del self.call_of_user[uid]

        by = call.name_of(by_user_id) if by_user_id else "the server"
        saved = await backend_client.update_call(call.id, status, reason)
        trace = [
            f"Call {call.id[:8]}… finished: status={status}, reason={reason}, by {by}",
            "Removed the call from memory; both users are free again",
            "Saved final status to backend DB (PATCH /internal/calls)" if saved else "⚠ Could not update call history",
        ]
        for uid in (call.caller_id, call.callee_id):
            await self.send(uid, "call.ended", trace, call_id=call.id, status=status, reason=reason, by=by)
        log.info("📴 call %s %s (%s) by %s", call.id[:8], status, reason, by)

    def _stop_ring_timer(self, call: CallSession) -> None:
        if call.ring_timer is not None:
            call.ring_timer.cancel()
            call.ring_timer = None

    # ---------------------------------------------------------------- relay

    async def relay(self, client: Client, msg: dict) -> None:
        """Forward a WebRTC message to the other participant, unchanged."""
        call = self._own_call(client, msg)
        if call is None or call.state != "active":
            return await self.error(client, "invalid_call", f"Can't relay {msg['type']}: no active call")

        other_id = call.other(client.user_id)
        size = len(json.dumps(msg))
        # Pass the client's fields through, minus the ones the server sets itself.
        payload = {k: v for k, v in msg.items() if k not in ("type", "trace", "from_user_id")}
        delivered = await self.send(
            other_id,
            msg["type"],
            [
                f"Received {msg['type']} from {client.username} ({size:,} bytes)",
                f"Checked that {client.username} is in active call {call.id[:8]}…",
                f"Forwarded it to {call.name_of(other_id)} unchanged (the server never parses SDP or candidates)",
            ],
            **payload,
            from_user_id=client.user_id,
        )
        log.info("   ↪ %s → %s  %s (%s B)%s", client.username, call.name_of(other_id), msg["type"], size,
                 "" if delivered else "  [NOT DELIVERED]")

    # ------------------------------------------------ backend → user pushes

    async def notify(self, user_id: int, event: str, data: dict) -> bool:
        return await self.send(user_id, event, ["The backend asked me to push this event to you (POST /internal/notify)"], **data)


hub = Hub()
