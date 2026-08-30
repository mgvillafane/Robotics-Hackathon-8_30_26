#!/usr/bin/env python3
"""Process every clip of a World Context task (preview or full)."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

from config import load_config  # noqa: E402
from dataset import list_task_clips, resolve_clip  # noqa: E402
from process_video import apply_overrides, ensure_model  # noqa: E402
from pipeline import run_pipeline  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--dataset-root", type=Path, default=None)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--resize-width", type=int)
    parser.add_argument("--max-frames", type=int)
    parser.add_argument("--no-video", action="store_true")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    config = apply_overrides(load_config(args.config), args)
    ensure_model(config)
    preview = not args.full
    clips = list_task_clips(args.task, args.dataset_root)
    if args.limit:
        clips = clips[: args.limit]
    if not clips:
        raise SystemExit(f"No clips for task {args.task}")
    print(f"Processing {len(clips)} clips from {args.task}")
    for row in clips:
        clip = resolve_clip(
            clip_id=row["clip_id"],
            preview=preview,
            dataset_root=args.dataset_root,
        )
        dest = args.output_dir / clip.clip_id
        print(f"\n=== {clip.clip_id} ===")
        run_pipeline(clip.path, dest, config, video_name=clip.clip_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
