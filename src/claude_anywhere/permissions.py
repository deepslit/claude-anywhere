"""In-process permission-request broker.

Three actors talk to this module:

1. The PreToolUse hook (running as a Python child of the ``claude``
   subprocess) calls ``register_request`` then ``await_decision`` to long-poll
   until the user clicks a card on the web UI.
2. The chat SSE stream fans out new requests to the browser by reading the
   per-session ``request_queue``.
3. The /api/sessions/:id/permissions HTTP route calls ``set_decision`` with
   the user's choice.

State is in-memory, scoped to one running server process. Each session also
holds an ``allowlist`` (set of tool names): once the user picks "allow always
in this session" for a tool, future hook calls for that tool short-circuit
to ``allow`` and never bother the UI.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .sessions import SessionRegistry


# Plan files live here. Writes/edits inside this directory are part of CC's
# plan-mode bookkeeping (the model writes its plan markdown here before
# calling ExitPlanMode). CC's native plan mode auto-allows these — we mirror
# that so the user isn't asked to approve a step that's structurally
# CC-internal.
_PLAN_DIR = Path("~/.claude/plans").expanduser().resolve()
_FS_WRITE_TOOLS = frozenset({"Write", "Edit", "MultiEdit", "NotebookEdit"})

# Tools that never need user permission — they're either model-internal state
# (TodoWrite), bookkeeping the user themselves drove (TaskStop on a task we
# started, TaskOutput on the same), or mode-flip ops (EnterPlanMode). Match
# CC's interactive behaviour, which doesn't prompt for these either.
_AUTO_ALLOW_TOOLS = frozenset({
    "TodoWrite",
    "TaskStop",
    "TaskOutput",
    "EnterPlanMode",
    "CronList",
})


def _is_plan_file_op(tool_name: str, tool_input: dict) -> bool:
    if tool_name not in _FS_WRITE_TOOLS:
        return False
    fp = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not isinstance(fp, str) or not fp:
        return False
    try:
        target = Path(fp).expanduser().resolve()
    except (OSError, RuntimeError):
        return False
    try:
        target.relative_to(_PLAN_DIR)
        return True
    except ValueError:
        return False


@dataclass
class PendingRequest:
    request_id: str
    session_id: str
    tool_name: str
    tool_input: dict
    decision: str | None = None  # "allow" | "deny"
    reason: str | None = None
    event: asyncio.Event = field(default_factory=asyncio.Event)


class PermissionBroker:
    def __init__(self, *, sessions: "SessionRegistry | None" = None) -> None:
        self._pending: dict[str, PendingRequest] = {}
        self._session_queues: dict[str, asyncio.Queue] = {}
        self._allowlists: dict[str, set[str]] = {}
        self._sessions = sessions  # late-binding allowed via attach_sessions

    def attach_sessions(self, sessions: "SessionRegistry") -> None:
        self._sessions = sessions

    def _session_perm_mode(self, session_id: str) -> str:
        if self._sessions is None:
            return "default"
        try:
            return self._sessions.get(session_id).permission_mode
        except KeyError:
            return "default"

    # ── chat SSE side ────────────────────────────────────────────────────

    def queue_for(self, session_id: str) -> asyncio.Queue:
        return self._session_queues.setdefault(session_id, asyncio.Queue())

    def discard_queue(self, session_id: str) -> None:
        self._session_queues.pop(session_id, None)

    def session_allowlist(self, session_id: str) -> set[str]:
        return set(self._allowlists.get(session_id, set()))

    # ── hook side ────────────────────────────────────────────────────────

    # Tools whose semantics require user *content* (not just allow/deny).
    # We never auto-allow these from the session allowlist — every call must
    # show the special answer card so the user can provide answers / approve
    # the proposed plan.
    _ALWAYS_INTERACTIVE = frozenset({"AskUserQuestion", "ExitPlanMode"})

    async def register_request(
        self,
        *,
        request_id: str,
        session_id: str,
        tool_name: str,
        tool_input: dict,
    ) -> PendingRequest:
        req = PendingRequest(
            request_id=request_id,
            session_id=session_id,
            tool_name=tool_name,
            tool_input=tool_input,
        )
        self._pending[request_id] = req

        # 1. Tools that never need approval (TodoWrite, TaskStop, etc.).
        if tool_name in _AUTO_ALLOW_TOOLS:
            req.decision = "allow"
            req.reason = f"auto-allowed ({tool_name} is non-prompting in CC)"
            req.event.set()
            return req

        # Auto-allow plan-file writes (matches CC's native plan-mode behaviour).
        if _is_plan_file_op(tool_name, tool_input):
            req.decision = "allow"
            req.reason = "auto-allowed (CC plan-file write)"
            req.event.set()
            return req

        # Auto-allow edit tools when the session is currently in acceptEdits
        # mode. This handles the case where the user just approved a plan and
        # switched the session into acceptEdits — the current claude turn keeps
        # spawning hook children with stale env vars, but we still want edits
        # to flow silently.
        if (
            tool_name in _FS_WRITE_TOOLS
            and self._session_perm_mode(session_id) == "acceptEdits"
        ):
            req.decision = "allow"
            req.reason = "auto-allowed (session is in acceptEdits)"
            req.event.set()
            return req

        # Auto-allow if the session has previously chosen "allow always" for
        # this tool, EXCEPT for tools whose UX is the answer card itself.
        if (
            tool_name in self._allowlists.get(session_id, set())
            and tool_name not in self._ALWAYS_INTERACTIVE
        ):
            req.decision = "allow"
            req.reason = "auto-allowed (session allowlist)"
            req.event.set()
            return req

        q = self.queue_for(session_id)
        await q.put(
            {
                "type": "permission_request",
                "request_id": request_id,
                "tool_name": tool_name,
                "tool_input": tool_input,
            }
        )
        return req

    async def await_decision(
        self, request_id: str, *, timeout: float
    ) -> dict | None:
        """Block up to ``timeout`` seconds; return ``{"decision":..., "reason":...}`` or None."""
        req = self._pending.get(request_id)
        if req is None:
            return None
        if not req.event.is_set():
            try:
                await asyncio.wait_for(req.event.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                return None
        if req.decision is None:
            return None
        return {"decision": req.decision, "reason": req.reason}

    # ── decision side ───────────────────────────────────────────────────

    def set_decision(
        self,
        request_id: str,
        decision: str,
        *,
        reason: str | None = None,
    ) -> bool:
        if decision not in ("allow", "allow_always", "deny"):
            return False
        req = self._pending.get(request_id)
        if req is None:
            return False
        if decision == "allow_always":
            self._allowlists.setdefault(req.session_id, set()).add(req.tool_name)
            req.decision = "allow"
            req.reason = reason or f"allowed; {req.tool_name} added to session allowlist"
        else:
            req.decision = decision
            req.reason = reason
        req.event.set()

        q = self._session_queues.get(req.session_id)
        if q is not None:
            try:
                q.put_nowait(
                    {
                        "type": "permission_decided",
                        "request_id": request_id,
                        # Show the user-facing decision (allow_always remains
                        # distinct from allow so the UI can render the chip).
                        "decision": decision,
                        "reason": reason,
                    }
                )
            except asyncio.QueueFull:
                pass
        return True

    def cleanup_request(self, request_id: str) -> None:
        self._pending.pop(request_id, None)
