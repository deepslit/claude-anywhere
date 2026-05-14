"""Spawn Claude Code in `--print` stream-json mode and translate its NDJSON
event stream into compact, web-friendly events.

The CLI invocation looks like::

    claude -p \
        --input-format stream-json \
        --output-format stream-json \
        --include-partial-messages \
        --verbose \
        --permission-mode <mode> \
        --settings <inline JSON with PreToolUse hook> \
        (--session-id <uuid> | --resume <uuid>)

A single user turn is one subprocess. We write one user-message event on
stdin, close stdin, and stream stdout until we see a ``result`` event. While
the subprocess runs, the PreToolUse hook script may pause it and ask the web
UI for permission via the in-process ``PermissionBroker``.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator


CLAUDE_PROJECTS = Path("~/.claude/projects").expanduser()


def slug_for(path: str | Path) -> str:
    """Reproduce Claude Code's cwd → directory-slug rule.

    `/` and `.` are both rewritten to `-`. The leading slash also becomes `-`,
    so `/tmp/cctest` becomes `-tmp-cctest`.
    """
    return re.sub(r"[/.]", "-", str(path))


def transcript_path(session_id: str, working_dir: Path) -> Path:
    return CLAUDE_PROJECTS / slug_for(working_dir.resolve()) / f"{session_id}.jsonl"


def _build_argv(
    *,
    claude_bin: str,
    session_id: str,
    is_new: bool,
    permission_mode: str,
    settings_json: str | None,
) -> list[str]:
    argv = [
        claude_bin,
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--permission-mode", permission_mode,
    ]
    if is_new:
        argv += ["--session-id", session_id]
    else:
        argv += ["--resume", session_id]
    if settings_json:
        argv += ["--settings", settings_json]
    return argv


def _hook_settings(hook_path: Path) -> str:
    """Return the inline ``--settings`` JSON string that wires our
    PreToolUse hook into Claude Code."""
    return json.dumps(
        {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": ".*",
                        "hooks": [
                            {
                                "type": "command",
                                "command": str(hook_path),
                                "timeout": 600,
                            }
                        ],
                    }
                ]
            }
        }
    )


def _translate(evt: dict) -> dict | None:
    """Map a Claude Code NDJSON event onto a compact frontend event.

    Returns None when nothing should be forwarded.
    """
    t = evt.get("type")
    if t == "system":
        sub = evt.get("subtype")
        if sub == "init":
            return {
                "type": "session_init",
                "session_id": evt.get("session_id"),
                "model": evt.get("model"),
                "tools": evt.get("tools", []),
                "slash_commands": evt.get("slash_commands", []),
                "skills": evt.get("skills", []),
                "agents": evt.get("agents", []),
            }
        return None  # other status events ignored for now

    if t == "stream_event":
        inner = evt.get("event") or {}
        itype = inner.get("type")
        if itype == "content_block_start":
            block = inner.get("content_block") or {}
            btype = block.get("type")
            idx = inner.get("index")
            if btype == "text":
                return {"type": "text_start", "index": idx}
            if btype == "thinking":
                return {"type": "thinking_start", "index": idx}
            if btype == "tool_use":
                return {
                    "type": "tool_use_start",
                    "index": idx,
                    "id": block.get("id"),
                    "name": block.get("name"),
                }
            return None
        if itype == "content_block_delta":
            delta = inner.get("delta") or {}
            dtype = delta.get("type")
            idx = inner.get("index")
            if dtype == "text_delta":
                return {"type": "text_delta", "index": idx, "text": delta.get("text", "")}
            if dtype == "thinking_delta":
                return {
                    "type": "thinking_delta",
                    "index": idx,
                    "text": delta.get("thinking", ""),
                }
            if dtype == "input_json_delta":
                return {
                    "type": "tool_input_delta",
                    "index": idx,
                    "partial_json": delta.get("partial_json", ""),
                }
            return None
        if itype == "content_block_stop":
            return {"type": "block_stop", "index": inner.get("index")}
        if itype == "message_stop":
            return {"type": "message_stop"}
        return None

    if t == "assistant":
        # Full-message snapshot — we ignore because we've streamed deltas.
        return None

    if t == "user":
        # Look for tool_result blocks and surface them.
        msg = evt.get("message") or {}
        content = msg.get("content")
        if isinstance(content, list):
            results = []
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "tool_result":
                    results.append({
                        "tool_use_id": blk.get("tool_use_id"),
                        "is_error": bool(blk.get("is_error")),
                        "content": blk.get("content"),
                    })
            if results:
                return {"type": "tool_result", "results": results}
        return None

    if t == "result":
        usage = evt.get("usage") or {}
        return {
            "type": "done",
            "duration_ms": evt.get("duration_ms"),
            "is_error": bool(evt.get("is_error")),
            "stop_reason": evt.get("stop_reason"),
            "num_turns": evt.get("num_turns"),
            "result_text": evt.get("result"),
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
            "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
            "permission_denials": evt.get("permission_denials") or [],
        }

    if t == "hook":
        return {"type": "hook", "raw": evt}

    return None


async def run_turn(
    *,
    claude_bin: str,
    session_id: str,
    working_dir: Path,
    user_text: str,
    permission_mode: str = "default",
    perm_queue: asyncio.Queue | None = None,
    hook_path: Path | None = None,
    backend_url: str | None = None,
    api_key: str | None = None,
    on_proc_started: "callable | None" = None,
) -> AsyncIterator[dict]:
    """Run one user turn against Claude Code; yield translated SSE-shaped dicts.

    If ``perm_queue`` is provided we forward any permission events the broker
    pushes onto it into the same output stream — so the SSE handler stays a
    single async iterator from the route's point of view.

    ``on_proc_started`` lets the caller capture the spawned subprocess as
    soon as it exists, e.g. so a TurnRunner can implement cancel by
    terminating the proc from outside this generator.
    """
    is_new = not transcript_path(session_id, working_dir).exists()
    install_hook = (
        hook_path is not None
        and backend_url is not None
        and api_key is not None
        and permission_mode != "bypassPermissions"
    )
    settings_json = _hook_settings(hook_path) if install_hook else None
    argv = _build_argv(
        claude_bin=claude_bin,
        session_id=session_id,
        is_new=is_new,
        permission_mode=permission_mode,
        settings_json=settings_json,
    )

    env = dict(os.environ)
    if permission_mode == "bypassPermissions":
        # CC refuses --dangerously-skip-permissions under root unless this is
        # set; the user explicitly opted in by picking this mode.
        env.setdefault("IS_SANDBOX", "1")
    if install_hook:
        env["CLAUDE_ANYWHERE_BACKEND"] = backend_url
        env["CLAUDE_ANYWHERE_API_KEY"] = api_key
        env["CLAUDE_ANYWHERE_SESSION_ID"] = session_id
        env["CLAUDE_ANYWHERE_PERM_MODE"] = permission_mode

    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(working_dir),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    if on_proc_started is not None:
        try:
            on_proc_started(proc)
        except Exception:  # noqa: BLE001
            pass

    user_event = {
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": user_text}],
        },
    }
    assert proc.stdin is not None
    proc.stdin.write((json.dumps(user_event) + "\n").encode("utf-8"))
    await proc.stdin.drain()
    proc.stdin.close()

    yield {"type": "turn_started", "argv": " ".join(shlex.quote(a) for a in argv)}

    # Multiplex two sources (stdout + permission queue) into a single output.
    output_q: asyncio.Queue = asyncio.Queue()
    SENTINEL_DONE = object()

    async def pump_stdout() -> None:
        assert proc.stdout is not None
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                try:
                    evt = json.loads(text)
                except json.JSONDecodeError:
                    await output_q.put(
                        {"type": "log", "level": "warn", "message": f"unparsable line: {text[:200]}"}
                    )
                    continue
                translated = _translate(evt)
                if translated is not None:
                    await output_q.put(translated)
                if evt.get("type") == "result":
                    break
        finally:
            await output_q.put(SENTINEL_DONE)

    async def pump_perms() -> None:
        if perm_queue is None:
            return
        while True:
            evt = await perm_queue.get()
            await output_q.put(evt)

    stdout_task = asyncio.create_task(pump_stdout())
    perm_task = asyncio.create_task(pump_perms()) if perm_queue is not None else None

    try:
        while True:
            evt = await output_q.get()
            if evt is SENTINEL_DONE:
                break
            yield evt
    finally:
        stdout_task.cancel()
        if perm_task is not None:
            perm_task.cancel()
        if proc.returncode is None:
            try:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()
            except ProcessLookupError:
                pass
        # Drain stderr only if process exited with error so we can surface logs.
        if proc.returncode and proc.stderr is not None:
            try:
                err = (await proc.stderr.read()).decode("utf-8", errors="replace")
                if err.strip():
                    yield {"type": "log", "level": "error", "message": err.strip()[:2000]}
            except Exception:
                pass
