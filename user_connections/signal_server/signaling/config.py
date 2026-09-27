"""Signal server settings, loaded from signal_server/.env (see .env.example)."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SIGNAL_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=SIGNAL_DIR / ".env", extra="ignore")

    # Same secret as the backend: lets us verify login tokens ourselves.
    jwt_secret: str
    # Same key as the backend: authenticates our calls to /internal/* and theirs to us.
    internal_api_key: str
    backend_url: str = "http://localhost:8000"

    # How long a call rings before it becomes "missed".
    ring_timeout_seconds: int = 30
    # How long a new WebSocket has to send its {"type": "auth"} message.
    auth_timeout_seconds: int = 10


settings = Settings()
