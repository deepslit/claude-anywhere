from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .auth import APIKeyMiddleware, ensure_api_key
from .config import Config, load_config
from .permissions import PermissionBroker
from .routes import (
    chat,
    completions as completions_routes,
    files as files_routes,
    meta,
    permissions as permissions_routes,
    sessions as sessions_routes,
)
from .sessions import SessionRegistry
from .turns import TurnManager


def create_app(project_root: Path | None = None) -> FastAPI:
    project_root = (project_root or Path.cwd()).resolve()
    config: Config = load_config(project_root)
    api_key = ensure_api_key(project_root)
    registry = SessionRegistry(config)
    broker = PermissionBroker()
    broker.attach_sessions(registry)
    turns = TurnManager()

    app = FastAPI(title="claude-anywhere", version="0.1.0")
    app.state.config = config
    app.state.api_key = api_key
    app.state.sessions = registry
    app.state.permissions = broker
    app.state.turns = turns
    app.state.project_root = project_root
    app.state.slash_cache_by_dir = {}
    app.state.slash_cache_locks = {}

    app.add_middleware(APIKeyMiddleware, expected_key=api_key)

    app.include_router(meta.router, prefix="/api")
    app.include_router(sessions_routes.router, prefix="/api/sessions")
    app.include_router(completions_routes.router, prefix="/api/sessions")
    app.include_router(files_routes.router, prefix="/api/sessions")
    app.include_router(permissions_routes.session_router, prefix="/api/sessions")
    app.include_router(permissions_routes.internal_router, prefix="/api/internal")
    app.include_router(chat.router, prefix="/api/sessions")

    web_dist = project_root / "web" / "dist"
    if web_dist.exists():
        app.mount(
            "/assets",
            StaticFiles(directory=web_dist / "assets"),
            name="assets",
        )

        @app.get("/{full_path:path}")
        def spa_fallback(full_path: str) -> FileResponse:  # noqa: ARG001
            index = web_dist / "index.html"
            return FileResponse(index)
    else:
        @app.get("/")
        def root() -> dict:
            return {
                "message": "claude-anywhere backend running. Frontend build not found at "
                f"{web_dist}. Run `npm run build` in web/ or use `npm run dev`.",
            }

    return app
