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
    parser.add_argument("--reload", action="store_true", help="reload on code change (dev)")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    app = create_app(project_root)
    cfg = app.state.config

    host = args.host or cfg.host
    port = args.port or cfg.port

    print(f"📡 mobile-cc listening on http://{host}:{port}")
    print(f"   working dirs available: {', '.join(d.name for d in cfg.allowed_dirs)}")

    uvicorn.run(
        app if not args.reload else "mobile_cc.server:create_app",
        host=host,
        port=port,
        reload=args.reload,
        factory=args.reload,
    )


if __name__ == "__main__":
    main()
