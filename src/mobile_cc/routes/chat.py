from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..claude_proc import run_turn
from ..permissions import PermissionBroker
from ..sessions import SessionRegistry

router = APIRouter()


class MessageBody(BaseModel):
    text: str
    permission_mode: str | None = None


VALID_MODES = {"default", "acceptEdits", "bypassPermissions", "plan"}


@router.post("/{session_id}/messages")
async def post_message(request: Request, session_id: str, body: MessageBody):
    cfg = request.app.state.config
    registry: SessionRegistry = request.app.state.sessions
    broker: PermissionBroker = request.app.state.permissions
    project_root: Path = request.app.state.project_root
    api_key: str = request.app.state.api_key

    try:
        meta = registry.get(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found")

    # Per-message mode override. Persisting onto the session meta means a later
    # GET /api/sessions/:id reflects what the user picked last.
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

    perm_queue = broker.queue_for(session_id)
    hook_path = project_root / "scripts" / "permission-hook.py"
    backend_url = f"http://127.0.0.1:{cfg.port}"

    async def event_stream():
        try:
            async for evt in run_turn(
                claude_bin=cfg.claude_bin,
                session_id=session_id,
                working_dir=meta.working_dir,
                user_text=body.text,
                permission_mode=permission_mode,
                perm_queue=perm_queue,
                hook_path=hook_path if hook_path.exists() else None,
                backend_url=backend_url,
                api_key=api_key,
            ):
                if evt.get("type") == "session_init":
                    registry.update_init(
                        session_id,
                        slash_commands=evt.get("slash_commands", []),
                        skills=evt.get("skills", []),
                        agents=evt.get("agents", []),
                    )
                yield _sse(evt)
        except Exception as exc:  # noqa: BLE001
            yield _sse({"type": "error", "message": str(exc)})
        finally:
            broker.discard_queue(session_id)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def _sse(payload: dict) -> str:
    data = json.dumps(payload, ensure_ascii=False)
    return f"data: {data}\n\n"
