"""Main backend: accounts, friends, call history, client config.

Run from user_connections/backend:
    uv run uvicorn app.main:app --reload --port 8000
"""

import logging

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import admin, auth, calls, friends, internal, recordings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s | %(message)s", datefmt="%H:%M:%S")
# httpx logs full request URLs (e.g. the Cloudflare TURN key id): keep it quiet.
logging.getLogger("httpx").setLevel(logging.WARNING)

app = FastAPI(title="user_connections backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Everything the browser uses lives under /api (the Vite proxy forwards /api here).
api = APIRouter(prefix="/api")
api.include_router(auth.router)
api.include_router(friends.router)
api.include_router(calls.router)
api.include_router(recordings.router)
api.include_router(admin.router)
app.include_router(api)

# Server-to-server only.
app.include_router(internal.router)


@app.get("/health")
def health() -> dict:
    return {"ok": True}
