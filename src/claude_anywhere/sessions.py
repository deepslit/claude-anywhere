"""In-memory + filesystem-backed session registry.

Sessions are uniquely identified by UUID. Persisted state for a session lives
in two places:

* ``~/.claude/projects/<slug>/<uuid>.jsonl`` — Claude Code's own transcript.
  This is the authoritative event log.
* In-memory ``SessionMeta`` — current binding of UUID → working directory plus
  cached metadata (slash commands, skills) from the last init event.

The in-memory map is rebuilt at process start by scanning the projects dir for
each allowed working directory.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .claude_proc import CLAUDE_PROJECTS, slug_for
from .config import AllowedDir, Config


@dataclass
class SessionMeta:
    id: str
    working_dir: Path
    dir_name: str
    permission_mode: str = "default"
    slash_commands: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    agents: list[str] = field(default_factory=list)


@dataclass
class SessionPreview:
    id: str
    working_dir: Path
    dir_name: str
    title: str
    mtime: float
    size: int


class SessionRegistry:
    def __init__(self, config: Config) -> None:
        self._config = config
        self._sessions: dict[str, SessionMeta] = {}
        self._rebuild()

    def _rebuild(self) -> None:
        for d in self._config.allowed_dirs:
            project_dir = CLAUDE_PROJECTS / slug_for(d.path.resolve())
            if not project_dir.is_dir():
                continue
            for f in project_dir.glob("*.jsonl"):
                sid = f.stem
                if sid not in self._sessions:
                    self._sessions[sid] = SessionMeta(
                        id=sid,
                        working_dir=d.path,
                        dir_name=d.name,
                    )

    # --- create / lookup ---------------------------------------------------

    def create(self, dir_path: str | Path, *, permission_mode: str = "default") -> SessionMeta:
        d = self._config.find_dir(dir_path)
        if d is None:
            raise ValueError(f"directory not in allowed list: {dir_path}")
        sid = str(uuid.uuid4())
        meta = SessionMeta(
            id=sid,
            working_dir=d.path,
            dir_name=d.name,
            permission_mode=permission_mode,
        )
        self._sessions[sid] = meta
        return meta

    def get(self, session_id: str) -> SessionMeta:
        if session_id in self._sessions:
            return self._sessions[session_id]
        # Try filesystem rehydration in case it was created in another process.
        for d in self._config.allowed_dirs:
            f = CLAUDE_PROJECTS / slug_for(d.path.resolve()) / f"{session_id}.jsonl"
            if f.exists():
                meta = SessionMeta(id=session_id, working_dir=d.path, dir_name=d.name)
                self._sessions[session_id] = meta
                return meta
        raise KeyError(session_id)

    def update_init(self, session_id: str, *, slash_commands: list[str], skills: list[str], agents: list[str]) -> None:
        if session_id in self._sessions:
            m = self._sessions[session_id]
            self._sessions[session_id] = SessionMeta(
                id=m.id,
                working_dir=m.working_dir,
                dir_name=m.dir_name,
                permission_mode=m.permission_mode,
                slash_commands=list(slash_commands),
                skills=list(skills),
                agents=list(agents),
            )

    def update_permission_mode(self, session_id: str, mode: str) -> None:
        if session_id in self._sessions:
            m = self._sessions[session_id]
            self._sessions[session_id] = SessionMeta(
                id=m.id,
                working_dir=m.working_dir,
                dir_name=m.dir_name,
                permission_mode=mode,
                slash_commands=list(m.slash_commands),
                skills=list(m.skills),
                agents=list(m.agents),
            )

    # --- listing -----------------------------------------------------------

    def list_for(self, allowed_dir: AllowedDir) -> list[SessionPreview]:
        project_dir = CLAUDE_PROJECTS / slug_for(allowed_dir.path.resolve())
        if not project_dir.is_dir():
            return []
        out: list[SessionPreview] = []
        for f in project_dir.glob("*.jsonl"):
            stat = f.stat()
            title = _first_user_message_preview(f) or "(空会话)"
            out.append(
                SessionPreview(
                    id=f.stem,
                    working_dir=allowed_dir.path,
                    dir_name=allowed_dir.name,
                    title=title,
                    mtime=stat.st_mtime,
                    size=stat.st_size,
                )
            )
        out.sort(key=lambda s: s.mtime, reverse=True)
        return out

    def list_all(self) -> list[SessionPreview]:
        all_: list[SessionPreview] = []
        for d in self._config.allowed_dirs:
            all_.extend(self.list_for(d))
        all_.sort(key=lambda s: s.mtime, reverse=True)
        return all_


def _first_user_message_preview(jsonl_path: Path, max_len: int = 80) -> str | None:
    try:
        with jsonl_path.open(encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "user":
                    continue
                msg = obj.get("message") or {}
                content = msg.get("content")
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    parts: list[str] = []
                    for blk in content:
                        if isinstance(blk, dict) and blk.get("type") == "text":
                            parts.append(str(blk.get("text", "")))
                        elif isinstance(blk, dict) and blk.get("type") == "tool_result":
                            return None  # tool result isn't a user prompt
                    text = " ".join(parts).strip()
                else:
                    continue
                if not text:
                    continue
                # Skip CC-TUI internal slash-command markers (the
                # `<local-command-caveat>...<command-name>/clear</command-name>`
                # blocks). They're not real user prompts.
                stripped = text.lstrip()
                if stripped.startswith("<local-command-caveat>") or stripped.startswith(
                    "<command-name>"
                ):
                    continue
                if len(text) > max_len:
                    return text[:max_len] + "…"
                return text
    except OSError:
        return None
    return None
