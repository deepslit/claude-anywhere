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

    # Expose whether a turn is currently running (or recently finished) so
    # the client can decide whether to subscribe via GET /messages?since=N.
    manager = getattr(request.app.state, "turns", None)
    active_turn = None
    has_live_runner = False
    if manager is not None:
        runner = manager.get(session_id)
        if runner is not None:
            active_turn = {
                "turn_id": runner.turn_id,
                "done": runner.done,
                "cancelled": runner.cancelled,
                "last_event_id": runner.last_event_id,
            }
            has_live_runner = not runner.done

    # When an active TurnRunner exists, SSE resume will deliver the
    # in-flight turn's events.  In that case _read_transcript should
    # only emit completed-turn history + the user message that started
    # the in-flight turn (SSE never sends plain user text).  When no
    # runner exists we include everything so completed sessions render
    # fully even without SSE.
    transcript = _read_transcript(
        meta.working_dir, session_id,
        skip_in_flight=has_live_runner,
    )

    return {
        "id": meta.id,
        "working_dir": str(meta.working_dir),
        "dir_name": meta.dir_name,
        "permission_mode": meta.permission_mode,
        "events": transcript,
        "active_turn": active_turn,
    }


def _read_transcript(
    working_dir: Path,
    session_id: str,
    *,
    skip_in_flight: bool = False,
) -> list[dict]:
    """Read the JSONL transcript and emit events in the same shape used by the
    live SSE stream so the frontend can use a single renderer.

    ``skip_in_flight`` controls how events after the last completed turn are
    handled:

    * **False** (default): emit everything.  Used when there is no active
      TurnRunner — the JSONL is the sole source of truth.
    * **True**: only emit plain user-message text for the in-flight turn.
      Everything else (assistant text, tool_use, tool_result) is delivered
      live by the SSE resume stream, so including it here would duplicate
      every item on the timeline.
    """
    from ..claude_proc import slug_for, CLAUDE_PROJECTS, _translate
    import json

    path = CLAUDE_PROJECTS / slug_for(working_dir.resolve()) / f"{session_id}.jsonl"
    if not path.exists():
        return []

    lines: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                evt = json.loads(raw)
            except json.JSONDecodeError:
                continue
            lines.append(evt)

    # The last ``result`` event marks the end of a completed turn.
    last_result_idx = -1
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].get("type") == "result":
            last_result_idx = i
            break

    # Tools whose tool_use block is replaced by a permission_request card in
    # real-time.  In history there is no permission_request event, so the raw
    # tool_use JSON is meaningless clutter — the answer/decision is already
    # captured by the subsequent tool_result.
    _INTERACTIVE_TOOLS = frozenset({"AskUserQuestion", "ExitPlanMode"})

    def _user_text_only(content: object) -> str | None:
        """Extract plain text from a user event, ignoring tool_result blocks."""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "text":
                    parts.append(str(blk.get("text", "")))
            return "\n".join(parts) if parts else None
        return None

    out: list[dict] = []
    for i, evt in enumerate(lines):
        t = evt.get("type")
        is_in_flight = last_result_idx == -1 or i > last_result_idx

        # ── in-flight turn (SSE will deliver these) ────────────────────
        if is_in_flight and skip_in_flight:
            # SSE never sends plain user text — keep that so the timeline
            # shows what the user typed.  Drop everything else.
            if t == "user":
                text = _user_text_only((evt.get("message") or {}).get("content"))
                if text:
                    out.append({"type": "user_message", "text": text})
            continue

        # ── completed turns (or full read when no SSE) ─────────────────
        if t == "user":
            msg = evt.get("message") or {}
            content = msg.get("content")
            if isinstance(content, str):
                out.append({"type": "user_message", "text": content})
            elif isinstance(content, list):
                text_parts: list[str] = []
                tool_results: list[dict] = []
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
                    name = blk.get("name", "")
                    # Interactive tools are rendered as permission_request
                    # cards in real-time; in history only the tool_result
                    # answer matters, so skip the raw tool_use block.
                    if name in _INTERACTIVE_TOOLS:
                        continue
                    out.append({
                        "type": "tool_use",
                        "id": blk.get("id"),
                        "name": name,
                        "input": blk.get("input"),
                    })
        elif t == "result":
            translated = _translate(evt)
            if translated:
                out.append(translated)
    return out
