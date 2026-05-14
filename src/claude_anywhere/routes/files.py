"""Read files from a session's working directory for the in-chat file viewer.

Hard rules:
* Path is resolved against the session's working_dir; absolute paths are
  accepted but must still be inside the working_dir (anti path-traversal).
* Files larger than ``MAX_BYTES`` are refused — the viewer is not a download
  manager, the user can pull the file off-server if they really need it.
* Binary content returns ``content: null`` plus a small head-bytes hex dump
  so the UI can show "binary, N bytes" without leaking content.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from ..sessions import SessionRegistry

router = APIRouter()

MAX_BYTES = 1_000_000  # 1 MB

# Map common extensions to a syntax-highlight language hint. The frontend
# uses this for hljs / react-markdown code-block class.
_LANG_BY_EXT: dict[str, str] = {
    ".py": "python",
    ".pyi": "python",
    ".js": "javascript",
    ".jsx": "jsx",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".json": "json",
    ".jsonl": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".md": "markdown",
    ".markdown": "markdown",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".fish": "fish",
    ".rs": "rust",
    ".go": "go",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".hpp": "cpp",
    ".java": "java",
    ".kt": "kotlin",
    ".swift": "swift",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "scss",
    ".sass": "sass",
    ".sql": "sql",
    ".xml": "xml",
    ".csv": "csv",
    ".txt": "plaintext",
    ".log": "plaintext",
    ".ini": "ini",
    ".env": "bash",
    ".dockerfile": "dockerfile",
    ".makefile": "makefile",
}

# Anything outside this set is shown as plaintext (still allowed) unless it
# fails the UTF-8 decode, in which case it's treated as binary.


def _resolve_safe(working_dir: Path, raw: str) -> Path:
    p = Path(raw)
    if not p.is_absolute():
        p = working_dir / raw
    p = p.resolve()
    root = working_dir.resolve()
    try:
        p.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=403, detail="path is outside the working directory")
    return p


@router.get("/{session_id}/file")
def read_file(request: Request, session_id: str, path: str) -> dict:
    registry: SessionRegistry = request.app.state.sessions
    try:
        meta = registry.get(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found")

    abs_path = _resolve_safe(meta.working_dir, path)

    if not abs_path.is_file():
        raise HTTPException(status_code=404, detail="not a file")

    size = abs_path.stat().st_size
    if size > MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large ({size} bytes; cap is {MAX_BYTES})",
        )

    raw = abs_path.read_bytes()
    is_binary = b"\0" in raw[:8192]
    text: str | None
    try:
        text = None if is_binary else raw.decode("utf-8")
    except UnicodeDecodeError:
        text = None
        is_binary = True

    ext = abs_path.suffix.lower()
    # Special-case files without an extension by name (Dockerfile, Makefile).
    name = abs_path.name.lower()
    if ext == "" and name in ("dockerfile", "makefile", "rakefile"):
        ext = "." + name
    language = _LANG_BY_EXT.get(ext, "plaintext")

    rel = str(abs_path.relative_to(meta.working_dir.resolve()))
    return {
        "path": str(abs_path),
        "relative_path": rel,
        "size": size,
        "is_binary": is_binary,
        "content": text,
        "language": language,
    }
