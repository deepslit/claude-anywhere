from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..sessions import SessionRegistry

router = APIRouter()


class CreateSessionBody(BaseModel):
    dir: str
    permission_mode: str = "default"


@router.get("")
def list_sessions(request: Request, dir: str | None = None) -> dict:
    registry: SessionRegistry = request.app.state.sessions
    cfg = request.app.state.config

    if dir is not None:
        target = cfg.find_dir(dir)
        if target is None:
            raise HTTPException(status_code=400, detail="dir not in allowed list")
        previews = registry.list_for(target)
    else:
        previews = registry.list_all()

    return {
        "sessions": [
            {
                "id": p.id,
                "working_dir": str(p.working_dir),
                "dir_name": p.dir_name,
                "title": p.title,
                "mtime": p.mtime,
                "size": p.size,
            }
            for p in previews
        ]
    }


@router.post("")
def create_session(request: Request, body: CreateSessionBody) -> dict:
    registry: SessionRegistry = request.app.state.sessions
    valid_modes = {"default", "acceptEdits", "bypassPermissions", "plan"}
    if body.permission_mode not in valid_modes:
        raise HTTPException(
            status_code=400,
            detail=f"permission_mode must be one of {sorted(valid_modes)}",
        )
    try:
        meta = registry.create(body.dir, permission_mode=body.permission_mode)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "id": meta.id,
        "working_dir": str(meta.working_dir),
        "dir_name": meta.dir_name,
        "permission_mode": meta.permission_mode,
    }


@router.get("/{session_id}")
def get_session(request: Request, session_id: str) -> dict:
    registry: SessionRegistry = request.app.state.sessions
    try:
        meta = registry.get(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found")

    transcript = _read_transcript(meta.working_dir, session_id)

    # Expose whether a turn is currently running (or recently finished) so
    # the client can decide whether to subscribe via GET /messages?since=N.
    manager = getattr(request.app.state, "turns", None)
    active_turn = None
    if manager is not None:
        runner = manager.get(session_id)
        if runner is not None:
            active_turn = {
                "turn_id": runner.turn_id,
                "done": runner.done,
                "cancelled": runner.cancelled,
                "last_event_id": runner.last_event_id,
            }

    return {
        "id": meta.id,
        "working_dir": str(meta.working_dir),
        "dir_name": meta.dir_name,
        "permission_mode": meta.permission_mode,
        "events": transcript,
        "active_turn": active_turn,
    }


def _read_transcript(working_dir: Path, session_id: str) -> list[dict]:
    """Stream the JSONL transcript and re-emit events in the same shape used
    by the live SSE stream so the frontend can use a single renderer."""
    from ..claude_proc import slug_for, CLAUDE_PROJECTS, _translate
    import json

    path = CLAUDE_PROJECTS / slug_for(working_dir.resolve()) / f"{session_id}.jsonl"
    if not path.exists():
        return []

    out: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                evt = json.loads(raw)
            except json.JSONDecodeError:
                continue
            t = evt.get("type")
            if t == "user":
                msg = evt.get("message") or {}
                content = msg.get("content")
                if isinstance(content, str):
                    out.append({"type": "user_message", "text": content})
                elif isinstance(content, list):
                    text_parts = []
                    tool_results = []
                    for blk in content:
                        if not isinstance(blk, dict):
                            continue
                        if blk.get("type") == "text":
                            text_parts.append(str(blk.get("text", "")))
                        elif blk.get("type") == "tool_result":
                            tool_results.append({
                                "tool_use_id": blk.get("tool_use_id"),
                                "is_error": bool(blk.get("is_error")),
                                "content": blk.get("content"),
                            })
                    if text_parts:
                        out.append({"type": "user_message", "text": "\n".join(text_parts)})
                    if tool_results:
                        out.append({"type": "tool_result", "results": tool_results})
            elif t == "assistant":
                msg = evt.get("message") or {}
                for blk in msg.get("content", []) or []:
                    if not isinstance(blk, dict):
                        continue
                    btype = blk.get("type")
                    if btype == "text":
                        out.append({"type": "assistant_text", "text": blk.get("text", "")})
                    elif btype == "thinking":
                        out.append({"type": "assistant_thinking", "text": blk.get("thinking", "")})
                    elif btype == "tool_use":
                        out.append({
                            "type": "tool_use",
                            "id": blk.get("id"),
                            "name": blk.get("name"),
                            "input": blk.get("input"),
                        })
            elif t == "result":
                translated = _translate(evt)
                if translated:
                    out.append(translated)
    return out
