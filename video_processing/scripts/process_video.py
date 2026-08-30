#!/usr/bin/env python3
"""Extract a gripper-state trajectory from one video."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

from config import Config, load_config  # noqa: E402
from dataset import resolve_clip  # noqa: E402
from fetch_model import default_model_path, fetch_model  # noqa: E402
from pipeline import run_pipeline  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--input", type=Path, help="Path to a video file")
    source.add_argument("--clip-id", help="World Context clip_id")
    parser.add_argument("--task", help="World Context task id (first clip if --clip-id omitted)")
    parser.add_argument("--preview", action="store_true", help="Use the 8s 360p preview asset")
    parser.add_argument("--full", action="store_true", help="Use the full 1080p clip")
    parser.add_argument("--dataset-root", type=Path, default=None)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--open-threshold", type=float)
    parser.add_argument("--closed-threshold", type=float)
    parser.add_argument("--auto-calibrate", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--smoothing", choices=("ema", "savgol", "median"))
    parser.add_argument("--ema-alpha", type=float)
    parser.add_argument("--min-detection-confidence", type=float)
    parser.add_argument("--min-tracking-confidence", type=float)
    parser.add_argument("--max-frames", type=int)
    parser.add_argument("--resize-width", type=int)
    parser.add_argument("--stride", type=int)
    parser.add_argument("--no-video", action="store_true")
    parser.add_argument("--no-plot", action="store_true")
    parser.add_argument("--streaming", action="store_true")
    parser.add_argument("--model-path", type=Path)
    return parser


def apply_overrides(config: Config, args: argparse.Namespace) -> Config:
    def opt(name: str, default=None):
        return getattr(args, name, default)

    if opt("open_threshold") is not None:
        config.gripper.open_threshold = args.open_threshold
    if opt("closed_threshold") is not None:
        config.gripper.closed_threshold = args.closed_threshold
    if opt("auto_calibrate") is not None:
        config.gripper.auto_calibrate = args.auto_calibrate
    if opt("smoothing") is not None:
        config.smoothing.method = args.smoothing
    if opt("ema_alpha") is not None:
        config.smoothing.ema_alpha = args.ema_alpha
    if opt("min_detection_confidence") is not None:
        config.tracking.min_detection_confidence = args.min_detection_confidence
    if opt("min_tracking_confidence") is not None:
        config.tracking.min_tracking_confidence = args.min_tracking_confidence
    if opt("max_frames") is not None:
        config.video.max_frames = args.max_frames
    if opt("resize_width") is not None:
        config.video.resize_width = args.resize_width
    if opt("stride") is not None:
        config.video.stride = args.stride
    if opt("no_video"):
        config.output.write_video = False
    if opt("no_plot"):
        config.output.write_plot = False
    if opt("streaming"):
        config.video.streaming = True
    if opt("model_path") is not None:
        config.tracking.model_path = str(args.model_path)
    if opt("dataset_root") is not None:
        config.dataset.root = str(args.dataset_root)
    return config


def resolve_input(args: argparse.Namespace) -> tuple[Path, str]:
    if args.input is not None:
        return args.input, args.input.stem
    if args.clip_id is None and args.task is None:
        raise SystemExit("Provide --input, --clip-id, or --task")
    preview = True
    if args.full:
        preview = False
    elif args.preview:
        preview = True
    clip = resolve_clip(
        clip_id=args.clip_id,
        task=args.task,
        preview=preview,
        dataset_root=args.dataset_root,
    )
    kind = "preview" if clip.is_preview else "full"
    print(f"Resolved {clip.clip_id} ({kind}) -> {clip.path}")
    return clip.path, clip.clip_id


def ensure_model(config: Config) -> None:
    path = config.resolve_model_path()
    if path.exists() and path.stat().st_size > 0:
        return
    dest = path if path.name.endswith(".task") else default_model_path()
    try:
        fetch_model(dest)
        config.tracking.model_path = str(dest)
    except Exception as exc:
        print(f"Model download failed ({exc}); falling back to mediapipe.solutions.hands")


def main() -> int:
    args = build_parser().parse_args()
    config = apply_overrides(load_config(args.config), args)
    ensure_model(config)
    input_path, name = resolve_input(args)
    print(f"Processing {input_path}")
    print(f"Output    {args.output_dir}")
    result = run_pipeline(input_path, args.output_dir, config, video_name=name)
    print(f"Wrote tables to {result.output_dir / 'data'}")
    if config.output.write_video:
        print(f"Wrote overlay to {result.output_dir / 'videos' / 'overlay.mp4'}")
    if config.output.write_plot:
        print(f"Wrote plot to {result.output_dir / 'plots' / 'signal.png'}")
    print(result.output_dir / "summary.txt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
