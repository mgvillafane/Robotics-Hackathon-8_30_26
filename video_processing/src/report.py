"""Quality metrics and a short text/JSON summary for each processed video."""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from pathlib import Path

import numpy as np
import pandas as pd

from config import QualityConfig
from events import GripperEvent


def build_summary(
    *,
    video_name: str,
    duration_s: float,
    fps: float,
    frames: int,
    frame_table: pd.DataFrame,
    events: Sequence[GripperEvent],
    quality: QualityConfig,
) -> dict:
    detected = frame_table["hand_detected"].astype(bool)
    detection_rate = float(detected.mean()) if len(frame_table) else 0.0
    conf = pd.to_numeric(frame_table.get("detection_confidence"), errors="coerce")
    mean_conf = float(conf[detected].mean()) if detected.any() else float("nan")
    states = frame_table["gripper_state"].fillna("UNKNOWN")
    counts = Counter(states)
    total = max(len(states), 1)
    pct = {name: 100.0 * counts.get(name, 0) / total for name in ("OPEN", "CLOSING", "CLOSED", "OPENING", "UNKNOWN")}
    n_grasp = sum(1 for e in events if e.event == "GRASP_START")
    n_release = sum(1 for e in events if e.event == "GRASP_RELEASE")
    n_hold = sum(1 for e in events if e.event == "GRASP_HOLD")

    switches = 0
    labels = frame_table["hand_label"].astype(str)
    prev = None
    for label, ok in zip(labels, detected):
        if not ok:
            continue
        if prev is not None and label != prev:
            switches += 1
        prev = label
    switch_rate = switches / max(int(detected.sum()), 1)

    signal = pd.to_numeric(frame_table.get("normalized_gripper_distance"), errors="coerce")
    finite = signal.to_numpy(dtype=np.float64)
    finite = finite[np.isfinite(finite)]
    signal_range = float(np.ptp(finite)) if finite.size else 0.0

    flags: list[str] = []
    if detection_rate < quality.min_detection_rate:
        flags.append("low_detection_rate")
    if switch_rate > quality.max_switch_rate:
        flags.append("excessive_hand_switching")
    if signal_range < quality.min_signal_range:
        flags.append("degenerate_signal_range")
    if not np.isfinite(mean_conf) or mean_conf < 0.4:
        flags.append("low_mean_confidence")

    return {
        "video": video_name,
        "duration_s": duration_s,
        "fps": fps,
        "frames": frames,
        "hand_detection_rate": detection_rate,
        "mean_detection_confidence": mean_conf,
        "grasp_events": n_grasp,
        "release_events": n_release,
        "hold_events": n_hold,
        "pct_open": pct["OPEN"],
        "pct_closing": pct["CLOSING"],
        "pct_closed": pct["CLOSED"],
        "pct_opening": pct["OPENING"],
        "pct_unknown": pct["UNKNOWN"],
        "hand_switch_rate": switch_rate,
        "signal_range": signal_range,
        "quality_flags": flags,
        "poor_tracking": bool(flags),
    }


def format_summary_text(summary: dict) -> str:
    flags = ", ".join(summary["quality_flags"]) if summary["quality_flags"] else "none"
    mean_conf = summary["mean_detection_confidence"]
    mean_conf_s = "nan" if not np.isfinite(mean_conf) else f"{mean_conf:.3f}"
    return (
        f"Video: {summary['video']}\n"
        f"Duration: {summary['duration_s']:.2f}s\n"
        f"FPS: {summary['fps']:.3f}\n"
        f"Frames: {summary['frames']}\n"
        f"\n"
        f"Hand detection rate: {100.0 * summary['hand_detection_rate']:.1f}%\n"
        f"Mean detection confidence: {mean_conf_s}\n"
        f"\n"
        f"Number of grasp events: {summary['grasp_events']}\n"
        f"Number of release events: {summary['release_events']}\n"
        f"\n"
        f"Percentage of time OPEN: {summary['pct_open']:.1f}%\n"
        f"Percentage of time CLOSED: {summary['pct_closed']:.1f}%\n"
        f"Percentage UNKNOWN: {summary['pct_unknown']:.1f}%\n"
        f"\n"
        f"Quality flags: {flags}\n"
    )


def write_summary(summary: dict, json_path: Path, text_path: Path) -> None:
    import json

    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(summary, indent=2) + "\n")
    text_path.write_text(format_summary_text(summary))
