#!/usr/bin/env python3
"""claude-anywhere PreToolUse hook.

Claude Code spawns this script before every tool call (when configured via
``--settings``). It reads the tool payload from stdin, asks the claude-anywhere
backend whether to allow the call, and emits a hook JSON response that CC
honours as the permission decision.

Exit / output contract (CC PreToolUse):
* stdout JSON ``{"hookSpecificOutput": {"hookEventName":"PreToolUse",
  "permissionDecision":"allow"|"deny", "permissionDecisionReason":"..."}}``
* exit 0 always (we never want CC to abort the run).

Env vars set by the spawning Python backend:
* CLAUDE_ANYWHERE_BACKEND: e.g. ``http://127.0.0.1:21580``
* CLAUDE_ANYWHERE_API_KEY: the X-API-Key the backend trusts
* CLAUDE_ANYWHERE_SESSION_ID: which session this turn belongs to
* CLAUDE_ANYWHERE_PERM_MODE: ``default``|``acceptEdits`` (we don't run for bypass)
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid

import urllib.error
import urllib.request


EDIT_TOOLS = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit"})

LONG_POLL_TIMEOUT = 25  # seconds per /decision call (server-side)
TOTAL_DEADLINE = 600  # 10-minute hard cap waiting for human


def _emit(decision: str, reason: str | None = None) -> None:
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
        }
    }
    if reason:
        out["hookSpecificOutput"]["permissionDecisionReason"] = reason
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()


def main() -> int:
    backend = os.environ.get("CLAUDE_ANYWHERE_BACKEND")
    api_key = os.environ.get("CLAUDE_ANYWHERE_API_KEY")
    session_id = os.environ.get("CLAUDE_ANYWHERE_SESSION_ID")
    perm_mode = os.environ.get("CLAUDE_ANYWHERE_PERM_MODE", "default")

    if not (backend and api_key and session_id):
        # Hook ran outside our context — let CC fall back to its native rules.
        sys.exit(0)

    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = payload.get("tool_name") or payload.get("toolName") or ""
    tool_input = payload.get("tool_input") or payload.get("toolInput") or {}

    # In acceptEdits mode, edits go through silently — no card needed.
    if perm_mode == "acceptEdits" and tool_name in EDIT_TOOLS:
        _emit("allow", "auto-allowed by acceptEdits mode")
        return 0

    request_id = str(uuid.uuid4())

    # Step 1: register the request with the backend.
    try:
        _post_json(
            f"{backend}/api/internal/permission-request",
            api_key,
            {
                "request_id": request_id,
                "session_id": session_id,
                "tool_name": tool_name,
                "tool_input": tool_input,
            },
        )
    except Exception as exc:  # noqa: BLE001
        _emit(
            "deny",
            f"claude-anywhere: failed to reach permission backend: {exc}",
        )
        return 0

    # Step 2: long-poll for a decision until deadline.
    deadline = time.time() + TOTAL_DEADLINE
    while time.time() < deadline:
        try:
            body = _get_json(
                f"{backend}/api/internal/permission-decision/{request_id}",
                api_key,
                timeout=LONG_POLL_TIMEOUT + 5,
            )
        except urllib.error.HTTPError as e:
            if e.code in (408, 504):
                continue  # server-side timeout, retry
            _emit("deny", f"claude-anywhere: HTTP {e.code} from backend")
            return 0
        except Exception:
            time.sleep(1)
            continue

        decision = (body or {}).get("decision")
        reason = (body or {}).get("reason")
        if decision in ("allow", "deny"):
            _emit(decision, reason or "The user declined this tool call without further feedback.")
            return 0

    _emit("deny", "claude-anywhere: approval timed out")
    return 0


def _post_json(url: str, api_key: str, body: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-API-Key": api_key,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def _get_json(url: str, api_key: str, *, timeout: int) -> dict:
    req = urllib.request.Request(
        url,
        headers={"X-API-Key": api_key},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


if __name__ == "__main__":
    sys.exit(main())
