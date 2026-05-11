from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from .server import create_app


def main() -> None:
    parser = argparse.ArgumentParser(prog="mobile-cc")
    parser.add_argument("--host", help="bind host (overrides config)")
    parser.add_argument("--port", type=int, help="bind port (overrides config)")
    parser.add_argument(
        "--project-root",
        default=str(Path.cwd()),
        help="project root (default: cwd)",
    )
    parser.add_argument(
        "--ssl-certfile",
        help="path to TLS cert (PEM). Pair with --ssl-keyfile to serve HTTPS.",
    )
    parser.add_argument(
        "--ssl-keyfile",
        help="path to TLS private key (PEM).",
    )
    parser.add_argument("--reload", action="store_true", help="reload on code change (dev)")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    app = create_app(project_root)
    cfg = app.state.config

    host = args.host or cfg.host
    port = args.port or cfg.port
    ssl_certfile = args.ssl_certfile or cfg.ssl_certfile
    ssl_keyfile = args.ssl_keyfile or cfg.ssl_keyfile
    use_tls = bool(ssl_certfile and ssl_keyfile)
    scheme = "https" if use_tls else "http"

    print(f"📡 mobile-cc listening on {scheme}://{host}:{port}")
    print(f"   working dirs available: {', '.join(d.name for d in cfg.allowed_dirs)}")
    if host not in ("127.0.0.1", "localhost", "::1") and not use_tls:
        print()
        print("⚠️  Public bind without TLS — the API key is sent over plain HTTP.")
        print("    Add TLS via `--ssl-certfile/--ssl-keyfile` (Let's Encrypt or self-")
        print("    signed) or put a reverse proxy in front (Caddy auto-TLS). README →")
        print("    Security has copy-pasteable recipes.")

    uvicorn.run(
        app if not args.reload else "mobile_cc.server:create_app",
        host=host,
        port=port,
        reload=args.reload,
        factory=args.reload,
        ssl_certfile=ssl_certfile,
        ssl_keyfile=ssl_keyfile,
    )


if __name__ == "__main__":
    main()
