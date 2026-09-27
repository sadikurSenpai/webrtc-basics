"""Backend settings, loaded from backend/.env (see .env.example)."""

import json
from functools import cached_property
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    # e.g. postgresql+psycopg://user:password@localhost:5432/learning_webrtc
    database_url: str

    # Signs login tokens. The signal server has the SAME secret so it can
    # verify tokens on its own, without calling us for every connection.
    jwt_secret: str
    jwt_expire_hours: int = 12

    # Shared secret for server-to-server calls (backend <-> signal server).
    internal_api_key: str
    signal_server_url: str = "http://localhost:8001"

    # Only needed if the browser calls the backend directly (not through the Vite proxy).
    cors_origins: str = "http://localhost:5173"

    # STUN/TURN servers handed to clients. In production the backend would
    # also generate short-lived TURN credentials per user here.
    ice_servers_json: str = '[{"urls": "stun:stun.l.google.com:19302"}]'

    # Call recordings: devices upload chunks straight to S3 with presigned URLs,
    # so the backend only signs URLs and stores metadata (never the bytes).
    s3_endpoint: str
    s3_region: str
    s3_bucket: str
    s3_access_key_id: str
    s3_secret_access_key: str
    s3_recordings_prefix: str = "learn_webrtc/recordings"
    recording_url_batch: int = 60
    presigned_url_expire_seconds: int = 3600
    recording_cors_origins: str = "http://localhost:5173"

    @cached_property
    def ice_servers(self) -> list[dict]:
        return json.loads(self.ice_servers_json)


settings = Settings()
