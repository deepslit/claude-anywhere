from __future__ import annotations

import os
import secrets
import time
from collections import deque
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

# Failed-auth rate limit. Brute-forcing a 32-byte url-safe key isn't feasible
# (256 bits of entropy) but the cap shuts up log spam and slow scanners.
_FAIL_WINDOW_SECONDS = 60.0
_FAIL_MAX_PER_WINDOW = 20


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
        # per-IP rolling window of failed attempt timestamps
        self._fails: dict[str, deque[float]] = {}

    def _client_ip(self, request: Request) -> str:
        # Honour reverse-proxy headers only on loopback connections so an
        # external client can't spoof its source IP for the rate limiter.
        peer = request.client.host if request.client else "unknown"
        if peer in ("127.0.0.1", "::1") or peer.startswith("127."):
            xff = request.headers.get("x-forwarded-for", "")
            if xff:
                return xff.split(",")[0].strip() or peer
        return peer

    def _record_failure(self, ip: str) -> int:
        now = time.monotonic()
        q = self._fails.setdefault(ip, deque())
        cutoff = now - _FAIL_WINDOW_SECONDS
        while q and q[0] < cutoff:
            q.popleft()
        q.append(now)
        return len(q)

    def _reset_failures(self, ip: str) -> None:
        self._fails.pop(ip, None)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if not path.startswith("/api/") or path in PUBLIC_API_PATHS:
            return await call_next(request)

        ip = self._client_ip(request)

        # If this IP has already burned through the budget, refuse without
        # even comparing the key. This lets log scanners give up quickly.
        existing = self._fails.get(ip)
        if existing:
            now = time.monotonic()
            cutoff = now - _FAIL_WINDOW_SECONDS
            while existing and existing[0] < cutoff:
                existing.popleft()
            if len(existing) >= _FAIL_MAX_PER_WINDOW:
                return JSONResponse(
                    status_code=429,
                    content={
                        "detail": "too many failed auth attempts; cool down "
                        f"for {int(_FAIL_WINDOW_SECONDS)}s",
                    },
                    headers={"Retry-After": str(int(_FAIL_WINDOW_SECONDS))},
                )

        provided = request.headers.get(API_KEY_HEADER, "")
        if not provided or not secrets.compare_digest(provided, self._expected):
            count = self._record_failure(ip)
            print(f"⛔ auth fail from {ip} ({count}/{_FAIL_MAX_PER_WINDOW} in window) → {path}")
            return JSONResponse(
                status_code=401,
                content={"detail": "invalid or missing API key"},
            )
        self._reset_failures(ip)
        return await call_next(request)
