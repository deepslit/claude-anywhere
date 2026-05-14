from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/health")
def health() -> dict:
    return {"ok": True}


@router.get("/dirs")
def list_dirs(request: Request) -> dict:
    cfg = request.app.state.config
    return {
        "dirs": [
            {"name": d.name, "path": str(d.path)}
            for d in cfg.allowed_dirs
        ]
    }
