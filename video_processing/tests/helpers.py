from __future__ import annotations

import numpy as np

from hand_tracking import FrameObservation, HandObservation


def make_landmarks(
    *,
    wrist=(0.40, 0.70, 0.0),
    thumb_tip=(0.30, 0.40, 0.0),
    index_tip=(0.50, 0.40, 0.0),
    index_mcp=(0.45, 0.55, 0.0),
    middle_mcp=(0.40, 0.52, 0.0),
    pinky_mcp=(0.32, 0.55, 0.0),
) -> np.ndarray:
    pts = np.zeros((21, 3), dtype=np.float64)
    pts[0] = wrist
    pts[4] = thumb_tip
    pts[5] = index_mcp
    pts[8] = index_tip
    pts[9] = middle_mcp
    pts[12] = (middle_mcp[0], middle_mcp[1] - 0.12, 0.0)
    pts[17] = pinky_mcp
    return pts


def make_hand(
    label: str = "RIGHT",
    score: float = 0.9,
    **kwargs,
) -> HandObservation:
    return HandObservation(
        label=label,
        handedness_score=score,
        detection_confidence=score,
        tracking_confidence=score,
        landmarks=make_landmarks(**kwargs),
        world_landmarks=None,
    )


def make_obs(frame: int, *hands: HandObservation, timestamp: float | None = None) -> FrameObservation:
    return FrameObservation(frame, timestamp if timestamp is not None else frame / 30.0, list(hands))
