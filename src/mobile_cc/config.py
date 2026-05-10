from __future__ import annotations

import shutil
import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AllowedDir:
    name: str
    path: Path


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    claude_bin: str
    allowed_dirs: tuple[AllowedDir, ...]
    project_root: Path

    def find_dir(self, path: str | Path) -> AllowedDir | None:
        target = Path(path).resolve()
        for d in self.allowed_dirs:
            if d.path.resolve() == target:
                return d
        return None


DEFAULT_CONFIG_PATHS = ("config.toml", "config.example.toml")


def load_config(project_root: Path) -> Config:
    raw: dict = {}
    for candidate in DEFAULT_CONFIG_PATHS:
        f = project_root / candidate
        if f.exists():
            raw = tomllib.loads(f.read_text(encoding="utf-8"))
            break

    host = str(raw.get("host", "0.0.0.0"))
    port = int(raw.get("port", 8788))
    claude_bin = str(raw.get("claude_bin") or shutil.which("claude") or "claude")

    dirs_raw = raw.get("allowed_dirs", [])
    dirs: list[AllowedDir] = []
    for entry in dirs_raw:
        path = Path(entry["path"]).expanduser()
        path.mkdir(parents=True, exist_ok=True)
        dirs.append(AllowedDir(name=str(entry["name"]), path=path))

    if not dirs:
        fallback = project_root / "workspaces"
        fallback.mkdir(parents=True, exist_ok=True)
        dirs.append(AllowedDir(name="默认工作区", path=fallback))

    return Config(
        host=host,
        port=port,
        claude_bin=claude_bin,
        allowed_dirs=tuple(dirs),
        project_root=project_root,
    )
