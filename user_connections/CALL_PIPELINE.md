# 1-to-1 Call Pipeline: blueprint

How this project's calling system is built, written so the same pipeline can be
reused in another product. `user_connections/` is the working reference
implementation; project-specific parts (push provider, auth system, UI) are marked
as such.

---

## 1. The one rule

**Servers carry small control messages. They never carry audio or video.**

| Traffic | Goes through | Size |
|---|---|---|
| Login, friends, history, config | Backend (REST) | small |
| Ringing, accept, offer/answer, ICE candidates | Signal server (WebSocket) | small |
| **Call media** | **Phone ⇄ phone directly**, or Cloudflare TURN if direct fails | large |
| **Recording chunks** | **Phone → S3 directly** (presigned URLs) | large |

Following this rule keeps backend and signal-server costs flat no matter how many
people are talking.

## 2. Components

```
                    YOUR SERVERS (e.g. Railway)
   ┌──────────────────────────────────────────────────────────┐
   │ backend        accounts, contacts, call history,         │
   │                TURN credentials, recording metadata,     │
   │                push sender (project-specific)            │
   │ signal server  presence, call state machine, relays      │
   │                offer / answer / ICE, ring timeout        │
   │ PostgreSQL                                               │
   └──────────────────────────────────────────────────────────┘
          ▲ REST + WebSocket (small JSON only)
          │
   Phone A ◄════════ audio, direct (most calls) ════════► Phone B
      │                                                     │
      └──────► Cloudflare STUN (free) + TURN (fallback) ◄───┘
      │
      └──────► S3 / Spaces (recording chunks)
```

| Component | Owns | Talks to |
|---|---|---|
| **Backend** | Users, contacts, `calls`, `call_recordings`, TURN credentials, presigned URLs | PostgreSQL, Cloudflare API, S3 API, signal server (`/internal`) |
| **Signal server** | Live connections, call state (ringing → active → ended), relaying | Backend (`/internal`) |
| **Cloudflare Realtime** | STUN and TURN | Phones only (backend only asks it for credentials) |
| **S3 / Spaces** | Recording chunks | Phones (upload), admin page (download) |
| **Push (project-specific)** | Waking a closed app to ring | Backend → FCM / APNs |

Backend and signal server authenticate each other with a shared `INTERNAL_API_KEY`
header. The signal server verifies user JWTs **itself** (it shares `JWT_SECRET`), so
it never calls the backend per connection.

## 3. Call flow

```
Caller                      Signal server                     Callee
 GET /api/config (STUN+TURN creds)
 getUserMedia
 call.invite ──────────────► check friends (backend /internal/can-call)
                             check busy, create call, save "ringing"
 ◄── call.ringing            ──── call.incoming ─────────────► (push if app closed*)
                                                              GET /api/config
                                                              getUserMedia
                                                              new RTCPeerConnection + addTrack
 ◄── call.accepted ◄──────── state = ACTIVE ◄──────────────── call.accept
 new RTCPeerConnection + addTrack
 createOffer / setLocalDescription
 webrtc.offer ─────────────── relayed unchanged ─────────────► setRemoteDescription
                                                              createAnswer / setLocalDescription
 setRemoteDescription ◄────── relayed unchanged ◄───────────── webrtc.answer
 webrtc.candidate ◄────────── relayed both ways ─────────────► webrtc.candidate
 ═══════════════ audio flows directly (or via TURN) ═══════════════
 recording starts on connectionState = "connected" (both sides)
 call.hangup ──────────────► save "ended" ──── call.ended ────► cleanup
```
\* Push for closed apps is not built in the reference implementation; see §10.

**Rules that avoid classic bugs**
* The **caller** creates the offer, and only after `call.accepted`. The callee
  prepares its `RTCPeerConnection` *before* sending `call.accept`.
* ICE candidates can arrive before the remote description: **queue them** and
  apply after `setRemoteDescription`.
* Attach tracks (`addTrack`) **before** creating the offer or answer.
* Fetch `/api/config` **before every call**, not once at login: TURN credentials expire.
* Mute = `track.enabled = false` (no renegotiation). Notify the other side with an
  app-level `media.state` message for the UI icon.

## 4. Signaling protocol (JSON over WebSocket)

The first message on a new socket must be `{"type":"auth","token":"<JWT>"}` (not
in the URL, which ends up in proxy logs).

| Message | Direction | Meaning |
|---|---|---|
| `auth` → `auth.ok` / `auth.error` | C→S, S→C | Authenticate the socket |
| `call.invite {to_user_id, media}` | caller→S | Ring someone |
| `call.ringing` / `call.incoming` | S→caller / S→callee | Call created (has `call_id`) |
| `call.accept` / `call.decline` / `call.cancel` | C→S | Answer / refuse / give up |
| `call.accepted {role}` | S→both | Start WebRTC; `role:"caller"` makes the offer |
| `webrtc.offer` / `webrtc.answer` / `webrtc.candidate` | C→S→C | Relayed unchanged |
| `media.state {audio, video}` | C→S→C | Mute / camera icons |
| `call.hangup` → `call.ended {status, reason, by}` | C→S→both | Call over, saved to DB |
| `presence {user_id, online}` | S→C | Contact came online / went offline |
| `error {code, message}` | S→C | `offline`, `busy`, `not_friends`, `invalid_call`, … |
| `ping` / `pong` | C↔S | Keep-alive every ~25 s (proxies close idle sockets) |

The server relays WebRTC messages **only** if the sender is a participant of that
call and the call is active. It never parses SDP.

## 5. Data model (PostgreSQL, via Alembic)

```
users            id, username, password_hash, is_admin, created_at, last_login_at
friendships      id, user_low_id, user_high_id, requested_by_id, status(pending|accepted|declined)
                 UNIQUE(user_low_id, user_high_id), CHECK(user_low_id < user_high_id)
calls            id (uuid, created by signal server), caller_id, callee_id, media,
                 status(ringing|accepted|ended|declined|missed|cancelled|failed),
                 end_reason, created_at, answered_at, ended_at
call_recordings  id, call_id, user_id, s3_prefix, file_ext, mime_type,
                 status(recording|complete|partial|failed), chunk_count, size_bytes,
                 duration_seconds, started_at, completed_at
                 UNIQUE(call_id, user_id)
```
In the main project, `users` / `friendships` map onto its existing account and
contact tables; `calls` and `call_recordings` carry over as-is.

## 6. APIs

**Backend, public (`/api`, JWT):**
`POST /auth/login` · `GET /auth/me` · `GET /config` (ICE servers) · `GET /calls` ·
friends endpoints · `POST /recordings` · `POST /recordings/{id}/urls?start=N` ·
`POST /recordings/{id}/complete` · admin: `GET /admin/recordings`,
`GET /admin/calls/{id}/recordings`

**Backend, internal (`/internal`, `X-Internal-Key`, never exposed publicly):**
`GET /can-call` · `GET /friends/{user_id}` · `POST /calls` · `PATCH /calls/{id}`

**Signal server, internal:** `GET /internal/presence?user_ids=` ·
`POST /internal/notify` (backend pushes events to a user's socket) · `GET /health`

## 7. STUN / TURN (Cloudflare Realtime)

**Why:** direct peer-to-peer fails behind symmetric NATs (mobile CGNAT), UDP-blocking
and HTTPS-only networks. TURN relays those calls. Expect roughly 10–30% relayed on
mobile-heavy user bases.

**How credentials flow (the key never leaves the backend):**
```
app ── GET /api/config ──► backend ── POST https://rtc.live.cloudflare.com/v1/turn/keys/<KEY_ID>/credentials/generate-ice-servers
                                        Authorization: Bearer <API_TOKEN>, {"ttl": 14400}
app ◄── {ice_servers: [STUN, TURN + username/credential], ice_source, ttl} ◄──┘
```
* **TTL** must outlast the longest call (default 4 h). Credentials are cached per
  user and reused only while ≥ 2/3 of the TTL remains.
* **Fallback:** if Cloudflare fails, return STUN only (`stun:stun.cloudflare.com:3478`)
  and log a warning. Calls still work wherever a direct path exists.
* Drop port-53 URLs from the response (browsers block them).
* Cloudflare returns TURN over UDP / TCP / TLS, including **443**, which passes
  almost any firewall.
* Don't self-host TURN on a PaaS without inbound UDP (e.g. Railway: TCP-only, random
  port); use Cloudflare, or coturn on a VM with a real public IP.

**Testing:** open the app with `?relay=1`. That sets
`iceTransportPolicy: 'relay'`, so every call **must** use TURN. The stats panel
should show `relay ⇄ relay`. If that fails, TURN is broken.

**Cost:** STUN free. TURN $0.05/GB of data sent from Cloudflare to clients, with the
first **1,000 GB/month free** (shared with Cloudflare's SFU).
Audio ≈ 1 MB per relayed call-minute, so the free tier ≈ 1 million relayed minutes/month.
`cost = max(0, relayed_minutes × MB_per_min / 1024 − 1000) × $0.05`

## 8. Recording pipeline

Each side records **its own camera (if any) + both voices mixed** (an AudioContext
mixes local mic + remote track), in **10-second chunks**, uploaded **directly to S3**.

```
connected ─► POST /api/recordings {call_id, mime_type} ─► row + 60 presigned PUT URLs
every 10 s ─► PUT chunk ─► S3  <prefix>/<call_id>/<user_id>/00000.webm, 00001.webm, …
URLs low  ─► POST /api/recordings/{id}/urls?start=N ─► 60 more
hang-up   ─► POST /api/recordings/{id}/complete ─► backend LISTs S3 → complete | partial | failed
crash     ─► no /complete; admin view reconciles later from S3 (no worker needed)
```
* No row per chunk; chunk keys are numbered.
* Low cost on the device: video 320×240 @ 15 fps at ~250 kbps, audio 32 kbps
  Opus; one upload at a time with retry; bounded memory.
* Each file contains the whole conversation's audio, so the two sides back each
  other up. For **audio-only** products, consider recording one side only to halve
  storage.
* Playback: download chunks, join them in order (they are pieces of one file), play.
* The bucket needs CORS allowing `PUT`/`GET` from the app origins (browsers only).
* **Mobile:** native WebRTC SDKs have no `MediaRecorder`. Capture and mix the audio
  natively (AVAssetWriter / AVAudioEngine on iOS, MediaCodec + MediaMuxer on
  Android); the chunk upload APIs stay identical.
* **Legal:** recording calls requires user consent in many jurisdictions. At
  minimum, state it in the terms and privacy policy.

## 9. Configuration

| Service | Variables |
|---|---|
| backend | `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRE_HOURS`, `INTERNAL_API_KEY`, `SIGNAL_SERVER_URL`, `CORS_ORIGINS`, `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`, `TURN_CREDENTIAL_TTL_SECONDS`, `ICE_SERVERS_JSON` (fallback), `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_RECORDINGS_PREFIX`, `RECORDING_URL_BATCH`, `PRESIGNED_URL_EXPIRE_SECONDS` |
| signal server | `JWT_SECRET` (= backend), `INTERNAL_API_KEY` (= backend), `BACKEND_URL`, `RING_TIMEOUT_SECONDS`, `AUTH_TIMEOUT_SECONDS` |
| web frontend | `VITE_API_BASE`, `VITE_SIGNAL_WS_URL` (production: real URLs; dev: Vite proxy) |

Secrets live only in server environment variables, never in app code, images or git.

## 10. Deploying (e.g. Railway + Cloudflare + Spaces)

* **Railway:** backend, signal server and PostgreSQL as three services. Run
  `alembic upgrade head` as the backend's pre-deploy/start step. Use Railway's
  private network for backend ↔ signal-server `/internal` calls, and **don't expose
  `/internal` publicly**.
* **Web frontend:** the Vite proxy exists only in development. In production, set
  `VITE_API_BASE` / `VITE_SIGNAL_WS_URL` to the public URLs and add the web origin
  to `CORS_ORIGINS`. Always use `https://` and `wss://`.
* **Cloudflare:** one TURN key per environment (dev / prod).
* **Spaces/S3:** one prefix per environment; bucket CORS for web uploads.

## 11. Production gaps (to build in the main project)

| # | Gap | Why it matters | Fix |
|---|---|---|---|
| 1 | **Push to ring closed apps** | Mobile apps are usually closed | Signal server asks backend to push when callee is offline; **Android: FCM high-priority + full-screen intent / ConnectionService; iOS: APNs VoIP push (PushKit) + CallKit** (FCM alone can't reliably ring a closed iPhone app). Send a "cancelled" push when the caller hangs up. Ring timeout ~45 s. `device_tokens` table. |
| 2 | **Reconnect grace period** | A WebSocket drop currently ends the call even though audio is fine | Keep the call ~30 s after a disconnect; let the client resume |
| 3 | **ICE restart** | Wi-Fi → 4G changes IP, and the call dies | On `disconnected`/`failed`, new offer with `iceRestart: true` via signaling |
| 4 | **Stale-call cleanup** | Redeploys leave calls "ringing"/"accepted" forever | On signal-server start, mark open calls `failed (server_restart)`; periodic sweep |
| 5 | **Shared state** | Call state lives in one process's memory | Redis for state + pub/sub before running >1 signal instance |
| 6 | **Multiple devices** | "Newest connection wins" today | Ring all devices; cancel others when one answers |
| 7 | **Glare** | Both call each other at once, and both get "busy" | Deterministic winner (e.g. lower user id) |
| 8 | **Call-quality telemetry** | Can't tell if calls work or predict TURN cost | Save per call: path (host/srflx/relay), time-to-connect, failure reason, RTT, loss |
| 9 | **Security** | | Rate-limit login; revocable/refreshable tokens; short TURN TTL; `wss://` only |
| 10 | **Phone audio** | | Earpiece/speaker/Bluetooth routing, GSM-call interruptions, proximity sensor, background audio mode |
| 11 | **Android permissions** | | `POST_NOTIFICATIONS` (13+), `USE_FULL_SCREEN_INTENT` (14+, calling apps), foreground service type `phoneCall`/`microphone` |

## 12. Load profile

| Part | Scales with | Cost driver |
|---|---|---|
| Backend | Logins, API calls; ~5 requests per call | Tiny |
| Signal server | Online users (one WebSocket each) + a few messages per call | Small; memory per connection |
| PostgreSQL | ~2 inserts + a few updates per call | Tiny |
| Cloudflare TURN | Relayed call-minutes | Free under 1 TB/month |
| S3 / Spaces | Recorded minutes | Storage + egress on playback |

## 13. Test checklist before release

- [ ] Same-network call connects (`host ⇄ host`)
- [ ] Different networks (Wi-Fi ⇄ 4G) connect (`srflx`)
- [ ] `?relay=1` (or the native equivalent) connects (`relay ⇄ relay`)
- [ ] Decline, cancel, missed (timeout), busy, offline
- [ ] Hang-up from either side ends both; history saved correctly
- [ ] Mute / unmute; the other side sees the indicator
- [ ] Network switch mid-call (after gap #3)
- [ ] Closed app rings via push, and stops ringing on cancel (after gap #1)
- [ ] Recording: complete after normal hang-up; partial after killing the app mid-call
- [ ] Signal-server redeploy during a call: clients reconnect; no stuck calls (gaps #2 and #4)
- [ ] No secrets in app bundle, images or logs
