from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..claude_proc import run_turn
from ..permissions import PermissionBroker
from ..sessions import SessionRegistry
from ..turns import TurnManager, TurnRunner

router = APIRouter()


class MessageBody(BaseModel):
    text: str
    permission_mode: str | None = None


VALID_MODES = {"default", "acceptEdits", "bypassPermissions", "plan"}


def _sse(payload: dict, *, event_id: int | None = None) -> str:
    data = json.dumps(payload, ensure_ascii=False)
    if event_id is not None:
        # The id: line lets browsers (or our own client) treat the stream as
        # a resumable log. We also embed `_id` in the payload so the client
        # can resume without depending on EventSource semantics.
        return f"id: {event_id}\ndata: {data}\n\n"
    return f"data: {data}\n\n"


async def _drive(
    runner: TurnRunner,
    *,
    cfg,
    registry: SessionRegistry,
    broker: PermissionBroker,
    project_root: Path,
    api_key: str,
    session_id: str,
    user_text: str,
    permission_mode: str,
) -> None:
    """Pump claude's translated events into the runner's log."""
    try:
        meta = registry.get(session_id)
    except KeyError:
        runner.append({"type": "error", "message": "session not found"})
        return

    perm_queue = broker.queue_for(session_id)
    hook_path = project_root / "scripts" / "permission-hook.py"
    backend_url = f"http://127.0.0.1:{cfg.port}"

    try:
        async for evt in run_turn(
            claude_bin=cfg.claude_bin,
            session_id=session_id,
            working_dir=meta.working_dir,
            user_text=user_text,
            permission_mode=permission_mode,
            perm_queue=perm_queue,
            hook_path=hook_path if hook_path.exists() else None,
            backend_url=backend_url,
            api_key=api_key,
            on_proc_started=lambda p: setattr(runner, "proc", p),
        ):
            if evt.get("type") == "session_init":
                registry.update_init(
                    session_id,
                    slash_commands=evt.get("slash_commands", []),
                    skills=evt.get("skills", []),
                    agents=evt.get("agents", []),
                )
            runner.append(evt)
    except Exception as exc:  # noqa: BLE001
        runner.append({"type": "error", "message": str(exc)})
    finally:
        broker.discard_queue(session_id)


async def _subscribe_response(runner: TurnRunner, *, since: int):
    """Build a StreamingResponse that mirrors the runner's events as SSE."""

    async def gen():
        async for env in runner.subscribe(since=since):
            yield _sse({**env.event, "_id": env.id}, event_id=env.id)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/{session_id}/messages")
async def post_message(request: Request, session_id: str, body: MessageBody):
    cfg = request.app.state.config
    registry: SessionRegistry = request.app.state.sessions
    broker: PermissionBroker = request.app.state.permissions
    manager: TurnManager = request.app.state.turns
    project_root: Path = request.app.state.project_root
    api_key: str = request.app.state.api_key

    try:
        meta = registry.get(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found")

    if body.permission_mode is not None:
        if body.permission_mode not in VALID_MODES:
            raise HTTPException(
                status_code=400,
                detail=f"permission_mode must be one of {sorted(VALID_MODES)}",
            )
        registry.update_permission_mode(session_id, body.permission_mode)
        permission_mode = body.permission_mode
    else:
        permission_mode = meta.permission_mode

    try:
        runner = await manager.start(
            session_id=session_id,
            driver=lambda r: _drive(
                r,
                cfg=cfg,
                registry=registry,
                broker=broker,
                project_root=project_root,
                api_key=api_key,
                session_id=session_id,
                user_text=body.text,
                permission_mode=permission_mode,
            ),
        )
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))

    return await _subscribe_response(runner, since=0)


@router.get("/{session_id}/messages")
async def resume_message(request: Request, session_id: str, since: int = 0):
    """Re-subscribe to the session's current (or most recently finished) turn.

    Used by the client when it comes back from background — pass the last
    event id we saw and we replay anything after that, then continue live if
    the turn is still running.
    """
    manager: TurnManager = request.app.state.turns
    runner = manager.get(session_id)
    if runner is None:
        raise HTTPException(status_code=404, detail="no turn for this session")
    return await _subscribe_response(runner, since=since)


@router.post("/{session_id}/messages/cancel")
async def cancel_message(request: Request, session_id: str) -> dict:
    manager: TurnManager = request.app.state.turns
    ok = await manager.cancel(session_id)
    return {"ok": ok}
