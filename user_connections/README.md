# user_connections: 1-to-1 WebRTC calls, with every step visible

Log in (first login creates the account), add friends by username, and call them with audio or video.
The right-hand panel shows **every step** of the call: media, signaling, SDP, ICE, connection
states, and what the **signal server** did at each step.

## Architecture

```
                         ┌───────────────────────────┐
  browser ── /api/* ───► │ backend        :8000      │── PostgreSQL (users, friendships, calls)
     │   (REST + JWT)    │ FastAPI                   │
     │                   └──────▲──────────┬─────────┘
     │                          │ /internal│/internal   (X-Internal-Key)
     │                   ┌──────┴──────────▼─────────┐
     └──── /ws ────────► │ signal_server  :8001      │  presence, ringing, relays
       (WebSocket)       │ FastAPI WebSocket         │  offer / answer / ICE
                         └───────────────────────────┘
  browser A ◄═══════════ audio/video (WebRTC, peer-to-peer) ═══════════► browser B
```

| Directory | What it is | Port | Config |
|---|---|---|---|
| `backend/` | Accounts, friends, call history, STUN/TURN config | 8000 | `backend/.env` |
| `signal_server/` | WebSocket: presence, call state machine, relays SDP/ICE | 8001 | `signal_server/.env` |
| `frontend/` | Vite app; **proxies** `/api` → backend and `/ws` → signal server | 5173 | `frontend/.env` |
| `alembic/` | Database migrations | – | `alembic/.env` |

Who talks to whom:
* **Browser → backend** (`/api`): login returns a JWT; friends; history; `GET /api/config` (ICE servers).
* **Browser → signal server** (`/ws`): first message `{"type":"auth","token":<JWT>}`. The signal server
  verifies the JWT **itself** (it has the same `JWT_SECRET`).
* **Signal server → backend** (`/internal/*`): "may alice call bob?", "save/update this call".
* **Backend → signal server** (`/internal/*`): "who is online?", "push a friend-request event to bob".
* **Browser ⇄ browser**: the actual audio/video, once connected. No server involved (unless TURN).

## Signaling protocol (JSON over the WebSocket)

| Message | Direction | Meaning |
|---|---|---|
| `auth` / `auth.ok` | C→S / S→C | Prove identity with the JWT |
| `call.invite {to_user_id, media}` | caller → S | Ring someone |
| `call.ringing` / `call.incoming` | S → caller / S → callee | It's ringing |
| `call.accept` / `call.decline` / `call.cancel` | C → S | Answer / refuse / give up |
| `call.accepted {role}` | S → both | Start WebRTC; `role: "caller"` creates the offer |
| `webrtc.offer`, `webrtc.answer`, `webrtc.candidate` | C → S → other C | Relayed unchanged |
| `media.state {audio, video}` | C → S → other C | Mute / camera icons |
| `call.hangup` → `call.ended {status, reason}` | C → S → both | Call over, saved to DB |
| `presence {user_id, online}` | S → C | A friend came online / went offline |
| `friend.request` / `friend.accepted` / … | S → C | Pushed by the backend via the signal server |

Every server→client message has a `trace` list: the steps the server took, shown in the UI.

---

## 1. One-time setup

```bash
cd user_connections

# Python deps (backend + signal server + alembic share one uv project)
uv sync

# Frontend deps
cd frontend && npm install && cd ..
```

**Database:** put your PostgreSQL user and password into **both** files:

```
backend/.env   DATABASE_URL=postgresql+psycopg://USER:PASSWORD@localhost:5432/learning_webrtc
alembic/.env   DATABASE_URL=postgresql+psycopg://USER:PASSWORD@localhost:5432/learning_webrtc
```

(`jdbc:postgresql://…` is Java's URL format; Python/SQLAlchemy needs `postgresql+psycopg://user:pass@…`.)

**Create the tables:**

```bash
cd alembic
uv run alembic upgrade head      # creates users, friendships, calls
uv run alembic current           # shows: 0001 (head)
```

Later, after changing `backend/app/models.py`:
`uv run alembic revision --autogenerate -m "what changed"` then `uv run alembic upgrade head`.

`JWT_SECRET` and `INTERNAL_API_KEY` are already generated and must be **identical** in
`backend/.env` and `signal_server/.env`.

## 2. Run (three terminals)

```bash
# Terminal 1: backend
cd user_connections/backend
uv run uvicorn app.main:app --reload --port 8000

# Terminal 2: signal server
cd user_connections/signal_server
uv run uvicorn signaling.main:app --reload --port 8001

# Terminal 3: frontend
cd user_connections/frontend
npm run dev
```

Open http://localhost:5173. To try it alone, use **two tabs** (each tab keeps its own login)
or a normal window + an incognito window.

Watch **terminal 2** during a call: it prints every ring, accept, relay and hang-up.

> If uv prints a `VIRTUAL_ENV … does not match` warning, it's harmless: another venv (e.g. the repo
> root's) is active in your shell, and uv correctly uses `user_connections/.venv`.

## 3. Share with colleagues (ngrok)

### Why a tunnel at all?

Your laptop is behind your router's NAT: colleagues can't reach `localhost:5173`. Even on the
same Wi-Fi, `http://192.168.x.x:5173` is **not enough**, because browsers only allow camera/mic on
**HTTPS** (or `localhost`). ngrok solves both: it gives you a public `https://…` URL and
forwards every request through an outgoing connection from your laptop to your local port.
That's what "port forwarding" means here:

```
colleague's browser ──https──► https://abc123.ngrok-free.app ──(ngrok tunnel)──► your laptop :5173
                                                                                     │ Vite proxy
                                                                     /api → :8000 ◄──┤
                                                                     /ws  → :8001 ◄──┘
```

### One tunnel is enough

Because the Vite dev server proxies `/api` and `/ws`, you only forward **the frontend port**.
The backend and signal server stay private on localhost. Their `/internal` endpoints are never
reachable from outside.

```bash
# once: connect ngrok to your account (token from dashboard.ngrok.com)
ngrok config add-authtoken <YOUR_TOKEN>

# Terminal 4, with the three servers running:
ngrok http 5173
```

Send colleagues the `https://….ngrok-free.app` URL ngrok prints. On the free plan they'll see
an ngrok warning page once: click **Visit Site**. `vite.config.js` already allows ngrok hosts.
The ngrok inspector at http://127.0.0.1:4040 shows every request going through the tunnel.

### Optional: expose backend + signal server directly

Only needed if something other than this frontend must reach them (e.g. the mobile app later).
See `ngrok.example.yml`, then set in `frontend/.env`:

```
VITE_API_BASE=https://<backend-tunnel>/api
VITE_SIGNAL_WS_URL=wss://<signal-tunnel>/ws
```

and add the frontend's public origin to `CORS_ORIGINS` in `backend/.env`.

### Will calls connect between colleagues?

| Situation | Result |
|---|---|
| Same office/home network | Usually yes (`host` candidates) |
| Different networks, normal home routers | Usually yes (`srflx` via the STUN server in `ICE_SERVERS_JSON`) |
| Strict corporate firewall / some mobile carriers | May **fail**: `connectionState → failed` in the panel. Needs a **TURN** server (Step 5) |

The live stats box shows which path was chosen (`host`, `srflx` or `relay`).

Note: anyone with the link can create an account (by design: login = sign-up). Stop ngrok
when you're done sharing.
