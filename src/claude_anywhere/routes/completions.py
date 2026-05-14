from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request

from ..completions import SlashCache, filter_slash, list_files, probe_init
from ..sessions import SessionRegistry

router = APIRouter()


@router.get("/{session_id}/completions/slash")
async def slash_completions(request: Request, session_id: str, q: str = "") -> dict:
    registry: SessionRegistry = request.app.state.sessions
    cache_by_dir: dict[str, SlashCache] = request.app.state.slash_cache_by_dir
    cache_locks: dict[str, asyncio.Lock] = request.app.state.slash_cache_locks
    cfg = request.app.state.config

    try:
        meta = registry.get(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found")

    # Prefer the freshest init this session has emitted, if any.
    if meta.slash_commands or meta.skills:
        sc = SlashCache(
            slash_commands=list(meta.slash_commands),
            skills=list(meta.skills),
            agents=list(meta.agents),
        )
        return {"items": filter_slash(sc, q)}

    key = str(meta.working_dir.resolve())
    lock = cache_locks.setdefault(key, asyncio.Lock())
    async with lock:
        if key not in cache_by_dir:
            cache_by_dir[key] = await probe_init(cfg.claude_bin, meta.working_dir)
    return {"items": filter_slash(cache_by_dir[key], q)}


@router.get("/{session_id}/completions/files")
def file_completions(
    request: Request, session_id: str, q: str = "", limit: int = 50
) -> dict:
    registry: SessionRegistry = request.app.state.sessions
    try:
        meta = registry.get(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found")
    return {"items": list_files(meta.working_dir, q, limit=limit)}
