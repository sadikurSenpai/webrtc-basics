# One Dockerfile, one target per service (docker-compose.yml picks the target).
# Secrets are NOT baked in: .dockerignore excludes every .env; compose passes
# them at runtime with env_file.

# ---------------------------------------------------------------- python base
FROM ghcr.io/astral-sh/uv:python3.11-bookworm-slim AS python-base
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 PATH="/app/.venv/bin:$PATH"
WORKDIR /app
# Dependencies first, so code changes don't reinstall them.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

# -------------------------------------------------------------------- backend
FROM python-base AS backend
COPY backend ./backend
COPY alembic ./alembic
WORKDIR /app/backend
# Apply migrations, then serve. Bound to 127.0.0.1: only the frontend proxy
# (same host) and the signal server need to reach it.
CMD ["sh", "-c", "cd /app/alembic && alembic upgrade head && cd /app/backend && exec uvicorn app.main:app --host 127.0.0.1 --port 8000"]

# -------------------------------------------------------------- signal server
FROM python-base AS signal
COPY signal_server ./signal_server
WORKDIR /app/signal_server
CMD ["uvicorn", "signaling.main:app", "--host", "127.0.0.1", "--port", "8001"]

# ------------------------------------------------------------------- frontend
FROM node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
# Vite dev server: serves the app and proxies /api and /ws (see vite.config.js).
CMD ["npm", "run", "dev"]
