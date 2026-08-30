"""Resolve World Context clip IDs to local video paths without importing worldcontext."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_DATASET_ROOT = Path(
    os.environ.get(
        "WORLD_CONTEXT_ROOT",
        "/home/pablo/code/robotics_hackathon/WORLD_CONTEXT_EXPLORER_V3",
    )
)


@dataclass(frozen=True)
class ResolvedClip:
    clip_id: str
    task_id: str
    path: Path
    is_preview: bool
    fps: float | None
    width: int | None
    height: int | None
    duration_s: float | None
    source_start_s: float | None = None


def find_dataset_root(explicit: str | Path | None = None) -> Path:
    if explicit is not None:
        root = Path(explicit).resolve()
        if not (root / "meta" / "clips.jsonl").exists():
            raise FileNotFoundError(f"No meta/clips.jsonl under {root}")
        return root
    env = os.environ.get("WORLD_CONTEXT_ROOT")
    if env:
        return find_dataset_root(env)
    cwd = Path.cwd().resolve()
    for candidate in (cwd, *cwd.parents):
        if (candidate / "meta" / "clips.jsonl").exists():
            return candidate
    if (DEFAULT_DATASET_ROOT / "meta" / "clips.jsonl").exists():
        return DEFAULT_DATASET_ROOT.resolve()
    raise FileNotFoundError(
        "Could not find a World Context package. Pass --dataset-root or set WORLD_CONTEXT_ROOT."
    )


def _read_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def resolve_clip(
    *,
    clip_id: str | None = None,
    task: str | None = None,
    preview: bool = True,
    dataset_root: str | Path | None = None,
) -> ResolvedClip:
    root = find_dataset_root(dataset_root)
    clips = _read_jsonl(root / "meta" / "clips.jsonl")
    if clip_id:
        matches = [row for row in clips if row.get("clip_id") == clip_id]
        if not matches:
            raise KeyError(f"Unknown clip_id: {clip_id}")
        row = matches[0]
    elif task:
        matches = [row for row in clips if row.get("canonical_task_id") == task]
        if not matches:
            raise KeyError(f"Unknown task: {task}")
        row = matches[0]
    else:
        raise ValueError("Provide clip_id or task")

    chosen_id = row["clip_id"]
    task_id = row["canonical_task_id"]
    if preview:
        previews = _read_jsonl(root / "meta" / "ui_previews.jsonl")
        preview_rows = [p for p in previews if p.get("clip_id") == chosen_id]
        if not preview_rows:
            raise FileNotFoundError(f"No UI preview for {chosen_id}")
        preview_row = preview_rows[0]
        rel = preview_row["relative_path"]
        path = root / rel
        if not path.exists():
            raise FileNotFoundError(path)
        return ResolvedClip(
            clip_id=chosen_id,
            task_id=task_id,
            path=path,
            is_preview=True,
            fps=preview_row.get("fps"),
            width=preview_row.get("width"),
            height=preview_row.get("height"),
            duration_s=preview_row.get("duration_s"),
            source_start_s=preview_row.get("source_start_s"),
        )

    rel = row["relative_path"]
    path = root / rel
    if not path.exists():
        raise FileNotFoundError(path)
    return ResolvedClip(
        clip_id=chosen_id,
        task_id=task_id,
        path=path,
        is_preview=False,
        fps=row.get("fps"),
        width=row.get("width"),
        height=row.get("height"),
        duration_s=row.get("duration_s"),
    )


def list_task_clips(task: str, dataset_root: str | Path | None = None) -> list[dict]:
    root = find_dataset_root(dataset_root)
    clips = _read_jsonl(root / "meta" / "clips.jsonl")
    return [row for row in clips if row.get("canonical_task_id") == task]
