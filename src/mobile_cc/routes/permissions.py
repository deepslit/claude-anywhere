from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..permissions import PermissionBroker
from ..sessions import SessionRegistry

internal_router = APIRouter()
session_router = APIRouter()


class RegisterBody(BaseModel):
    request_id: str
    session_id: str
    tool_name: str
    tool_input: dict


class DecisionBody(BaseModel):
    request_id: str
    decision: str  # "allow" | "allow_always" | "deny"
    reason: str | None = None
    # Optional: switch the session's permission_mode at the same time as
    # submitting the decision. Used by "Approve plan (auto-accept edits)" to
    # flip the session into acceptEdits in one click.
    set_mode: str | None = None


@internal_router.post("/permission-request")
async def internal_register(request: Request, body: RegisterBody) -> dict:
    broker: PermissionBroker = request.app.state.permissions
    registry: SessionRegistry = request.app.state.sessions
    try:
        registry.get(body.session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found")

    await broker.register_request(
        request_id=body.request_id,
        session_id=body.session_id,
        tool_name=body.tool_name,
        tool_input=body.tool_input,
    )
    return {"ok": True}


@internal_router.get("/permission-decision/{request_id}")
async def internal_await(request: Request, request_id: str) -> dict:
    broker: PermissionBroker = request.app.state.permissions
    result = await broker.await_decision(request_id, timeout=25.0)
    if result is None:
        raise HTTPException(status_code=408, detail="timeout, retry")
    broker.cleanup_request(request_id)
    return result


@session_router.post("/{session_id}/permissions")
async def user_decide(
    request: Request, session_id: str, body: DecisionBody
) -> dict:
    broker: PermissionBroker = request.app.state.permissions
    registry: SessionRegistry = request.app.state.sessions
    try:
        registry.get(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found")
    if body.decision not in ("allow", "allow_always", "deny"):
        raise HTTPException(
            status_code=400,
            detail="decision must be allow|allow_always|deny",
        )
    if body.set_mode is not None:
        valid_modes = {"default", "acceptEdits", "bypassPermissions", "plan"}
        if body.set_mode not in valid_modes:
            raise HTTPException(
                status_code=400,
                detail=f"set_mode must be one of {sorted(valid_modes)}",
            )
        registry.update_permission_mode(session_id, body.set_mode)
    if not broker.set_decision(body.request_id, body.decision, reason=body.reason):
        raise HTTPException(status_code=404, detail="request_id unknown or already decided")
    return {
        "ok": True,
        "session_allowlist": sorted(broker.session_allowlist(session_id)),
        "permission_mode": registry.get(session_id).permission_mode,
    }
