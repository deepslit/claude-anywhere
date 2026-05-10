from __future__ import annotations

import os
import secrets
from pathlib import Path

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

API_KEY_HEADER = "X-API-Key"
API_KEY_FILENAME = ".api-key"

# Routes that don't require an API key. Static files and the SPA shell are
# served separately and also unauthenticated (the SPA prompts for the key
# client-side).
PUBLIC_API_PATHS = frozenset({"/api/health"})


def ensure_api_key(project_root: Path) -> str:
    """Return the API key, generating + persisting one on first run."""
    key_file = project_root / API_KEY_FILENAME
    if key_file.exists():
        return key_file.read_text(encoding="utf-8").strip()

    key = secrets.token_urlsafe(32)
    key_file.write_text(key, encoding="utf-8")
    try:
        os.chmod(key_file, 0o600)
    except OSError:
        pass
    print("=" * 60)
    print(f"🔑 New API key generated → {key_file}")
    print(f"   {key}")
    print("   保存好这个 key，浏览器首次访问时需要输入。")
    print("=" * 60)
    return key


class APIKeyMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, *, expected_key: str) -> None:
        super().__init__(app)
        self._expected = expected_key

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if not path.startswith("/api/") or path in PUBLIC_API_PATHS:
            return await call_next(request)

        provided = request.headers.get(API_KEY_HEADER, "")
        if not provided or not secrets.compare_digest(provided, self._expected):
            return JSONResponse(
                status_code=401,
                content={"detail": "invalid or missing API key"},
            )
        return await call_next(request)
