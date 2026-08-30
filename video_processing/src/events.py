"""Detect grasp and release events from the discrete gripper-state sequence."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class GripperEvent:
    event: str
    frame: int
    timestamp: float
    confidence: float


def detect_events(
    states: Sequence[str],
    timestamps: Sequence[float],
    frames: Sequence[int],
    gripper_values: Sequence[float],
    detection_confidences: Sequence[float],
    *,
    min_hold_frames: int,
    min_event_separation_s: float,
) -> list[GripperEvent]:
    events: list[GripperEvent] = []
    last_event_t = -1e9
    grasp_open = False
    closing_seen = False
    opening_seen = False
    closed_run = 0
    hold_emitted = False
    start_idx = 0

    def confidence_at(index: int, lookback: int = 8) -> float:
        lo = max(0, index - lookback)
        conf = np.asarray(detection_confidences[lo : index + 1], dtype=np.float64)
        vals = np.asarray(gripper_values[lo : index + 1], dtype=np.float64)
        conf = conf[np.isfinite(conf)]
        vals = vals[np.isfinite(vals)]
        mean_conf = float(np.mean(conf)) if conf.size else 0.5
        contrast = float(np.ptp(vals)) if vals.size else 0.0
        return float(np.clip(0.5 * mean_conf + 0.5 * min(1.0, contrast * 2.0), 0.0, 1.0))

    def emit(name: str, index: int) -> None:
        nonlocal last_event_t
        t = float(timestamps[index])
        if name in {"GRASP_START", "GRASP_RELEASE"} and t - last_event_t < min_event_separation_s:
            return
        events.append(
            GripperEvent(
                event=name,
                frame=int(frames[index]),
                timestamp=t,
                confidence=confidence_at(index),
            )
        )
        if name != "GRASP_HOLD":
            last_event_t = t

    for i, state in enumerate(states):
        if state == "OPEN":
            grasp_open = True
            if opening_seen and closed_run >= min_hold_frames:
                emit("GRASP_RELEASE", i)
            closing_seen = False
            opening_seen = False
            closed_run = 0
            hold_emitted = False
        elif state == "CLOSING":
            if grasp_open:
                closing_seen = True
            opening_seen = False
            closed_run = 0
            hold_emitted = False
        elif state == "CLOSED":
            if closed_run == 0:
                start_idx = i
            closed_run += 1
            if (closing_seen or grasp_open) and closed_run == 1:
                emit("GRASP_START", start_idx)
            if closed_run == min_hold_frames and not hold_emitted:
                emit("GRASP_HOLD", i)
                hold_emitted = True
            opening_seen = False
        elif state == "OPENING":
            if closed_run >= 1 or hold_emitted:
                opening_seen = True
            closing_seen = False
        else:
            continue
    return events
