"""Slash-command and @-file autocomplete sources.

* Slash commands & skills are obtained by briefly spawning ``claude -p`` in
  the session's working directory, capturing the first ``system/init`` line,
  and killing the process. The result is cached per-working-dir for the
  lifetime of the server, and refreshed whenever a live session emits its own
  init event (so adding a skill in CC's settings propagates after the next
  real turn in that dir).
* @ file completion walks the chosen working directory once per request,
  honouring ``.gitignore`` if present plus a small built-in skip list.
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path

import pathspec

# ───────────────────────── slash commands & skills ─────────────────────────


@dataclass
class SlashCache:
    slash_commands: list[str]
    skills: list[str]
    agents: list[str]


_DEFAULT_BUILTIN = ("clear",)

# Commands that don't work in web mode (sent as plain text to the model,
# not intercepted by the CLI in `-p stream-json` mode).
_WEB_UNSUPPORTED = frozenset({
    "compact", "context", "help", "init",
    "model", "cost", "permissions", "doctor",
    "config", "terminal-setup", "status-bar",
})


async def probe_init(claude_bin: str, working_dir: Path) -> SlashCache:
    """Spawn ``claude`` briefly in ``working_dir`` to capture the init event.

    We send a single trivial user message on stdin (just so the process
    doesn't immediately exit on empty input), but kill it as soon as we read
    the init line — so no LLM call actually happens beyond the request setup.
    Some api credits will still be charged for the requesting status, hence
    we cache the result.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            claude_bin,
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "default",
            cwd=str(working_dir),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError:
        return SlashCache(list(_DEFAULT_BUILTIN), [], [])

    user_event = {
        "type": "user",
        "message": {"role": "user", "content": [{"type": "text", "text": "."}]},
    }
    assert proc.stdin is not None
    proc.stdin.write((json.dumps(user_event) + "\n").encode())
    try:
        await proc.stdin.drain()
    except (BrokenPipeError, ConnectionResetError):
        pass

    try:
        assert proc.stdout is not None
        # First line of stream-json output is the system/init event.
        line = await asyncio.wait_for(proc.stdout.readline(), timeout=20.0)
        evt: dict | None = None
        if line:
            try:
                obj = json.loads(line.decode("utf-8", errors="replace"))
                if obj.get("type") == "system" and obj.get("subtype") == "init":
                    evt = obj
            except json.JSONDecodeError:
                evt = None
    except asyncio.TimeoutError:
        evt = None
    finally:
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

    if evt is None:
        return SlashCache(list(_DEFAULT_BUILTIN), [], [])
    raw_commands = evt.get("slash_commands") or []
    filtered = [c for c in raw_commands if c not in _WEB_UNSUPPORTED]
    if not filtered:
        filtered = list(_DEFAULT_BUILTIN)
    return SlashCache(
        slash_commands=filtered,
        skills=list(evt.get("skills") or []),
        agents=list(evt.get("agents") or []),
    )


def filter_slash(cache: SlashCache, query: str, *, limit: int = 30) -> list[dict]:
    q = query.lstrip("/").lower()
    out: list[dict] = []

    seen: set[tuple[str, str]] = set()
    for cmd in cache.slash_commands:
        key = ("command", cmd)
        if key in seen:
            continue
        if not q or q in cmd.lower():
            out.append({"kind": "command", "name": cmd})
            seen.add(key)
    for sk in cache.skills:
        key = ("skill", sk)
        if key in seen:
            continue
        if not q or q in sk.lower():
            out.append({"kind": "skill", "name": sk})
            seen.add(key)
    return out[:limit]


# ───────────────────────── @ file completion ─────────────────────────────

_DEFAULT_SKIPS = frozenset(
    {
        ".git",
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        ".mypy_cache",
        ".ruff_cache",
        ".pytest_cache",
        "dist",
        "build",
        "target",
        ".next",
        ".turbo",
    }
)


def list_files(working_dir: Path, query: str, *, limit: int = 50) -> list[dict]:
    if not working_dir.is_dir():
        return []
    spec = _load_gitignore(working_dir)
    q = query.lstrip("@").lower()

    out: list[dict] = []
    files_walked = 0
    MAX_FILES = 5000

    for root, dirs, files in os.walk(working_dir, followlinks=False):
        # In-place prune of ignored dirs.
        dirs[:] = [d for d in dirs if d not in _DEFAULT_SKIPS]
        if spec is not None:
            dirs[:] = [
                d
                for d in dirs
                if not spec.match_file(_relpath(Path(root) / d, working_dir) + "/")
            ]

        for name in files:
            files_walked += 1
            if files_walked > MAX_FILES:
                break
            full = Path(root) / name
            rel = _relpath(full, working_dir)
            if spec is not None and spec.match_file(rel):
                continue
            if not q or q in rel.lower():
                out.append({"path": rel})
                if len(out) >= limit:
                    return _sort_paths(out, q)
        if files_walked > MAX_FILES:
            break

    return _sort_paths(out, q)


def _relpath(p: Path, root: Path) -> str:
    return str(p.relative_to(root)).replace(os.sep, "/")


def _sort_paths(items: list[dict], q: str) -> list[dict]:
    """Prefer prefix matches over arbitrary substring hits."""
    if not q:
        items.sort(key=lambda i: i["path"])
        return items
    items.sort(
        key=lambda i: (
            0 if i["path"].lower().startswith(q) else 1,
            len(i["path"]),
            i["path"],
        )
    )
    return items


def _load_gitignore(root: Path) -> pathspec.PathSpec | None:
    gi = root / ".gitignore"
    if not gi.is_file():
        return None
    try:
        text = gi.read_text(encoding="utf-8")
    except OSError:
        return None
    return pathspec.PathSpec.from_lines("gitwildmatch", text.splitlines())
