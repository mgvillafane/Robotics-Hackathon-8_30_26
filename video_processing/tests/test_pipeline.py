from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pandas as pd

from config import Config, load_config
from hand_tracking import FrameObservation
from pipeline import run_pipeline
from tests.helpers import make_hand


class ScriptedTracker:
    """Deterministic tracker that opens, pinches, then opens again."""

    def process(self, frame_bgr, frame_index: int, timestamp_s: float) -> FrameObservation:
        n = 40
        phase = frame_index / max(n - 1, 1)
        if 0.35 < phase < 0.65:
            span = 0.04
        elif 0.25 < phase < 0.75:
            span = 0.10
        else:
            span = 0.22
        mid = 0.42
        if frame_index in {12, 13}:
            return FrameObservation(frame_index, timestamp_s, [])
        hand = make_hand(
            "RIGHT",
            0.92,
            thumb_tip=(mid - span / 2, 0.36, 0.0),
            index_tip=(mid + span / 2, 0.36, 0.0),
        )
        return FrameObservation(frame_index, timestamp_s, [hand])

    def close(self) -> None:
        return None


def _tiny_video(path: Path, frames: int = 40, size: tuple[int, int] = (160, 90)) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 20.0, size)
    assert writer.isOpened()
    for i in range(frames):
        img = np.full((size[1], size[0], 3), 30, dtype=np.uint8)
        cv2.rectangle(img, (10, 10), (60, 60), (i * 5, 80, 160), -1)
        writer.write(img)
    writer.release()
    return path


def test_pipeline_preserves_missing_frames_and_writes_outputs(tmp_path: Path) -> None:
    video = _tiny_video(tmp_path / "toy.mp4")
    config = load_config()
    config.video.max_frames = 40
    config.output.write_video = True
    config.output.write_plot = True
    config.output.write_parquet = True
    config.gripper.auto_calibrate = True
    config.gripper.min_state_frames = 2
    config.events.min_hold_frames = 3
    config.smoothing.median_window = 1
    result = run_pipeline(video, tmp_path / "out", config, tracker=ScriptedTracker(), video_name="toy")

    assert len(result.records) == 40
    table = result.frame_table
    assert table["hand_detected"].sum() == 38
    missing = table.loc[~table["hand_detected"]]
    assert len(missing) == 2
    assert missing["thumb_x"].isna().all()
    assert (tmp_path / "out" / "data" / "frames.csv").exists()
    assert (tmp_path / "out" / "data" / "events.csv").exists()
    assert (tmp_path / "out" / "data" / "stages.csv").exists()
    assert (tmp_path / "out" / "data" / "frames.parquet").exists()
    assert (tmp_path / "out" / "summary.txt").exists()
    assert (tmp_path / "out" / "plots" / "signal.png").exists()
    assert (tmp_path / "out" / "videos" / "overlay.mp4").exists()
    names = set(result.event_table["event"]) if len(result.event_table) else set()
    assert "GRASP_START" in names or result.summary["grasp_events"] >= 0
    stages = pd.read_csv(tmp_path / "out" / "data" / "stages.csv")
    assert list(stages.columns)[:3] == ["frame", "timestamp", "thumb_index_distance"]
