"""Geometry features: thumb-index distance, hand scale, normalized opening."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np

from config import FeaturesConfig
from hand_tracking import (
    INDEX_MCP,
    INDEX_TIP,
    MIDDLE_MCP,
    PINKY_MCP,
    THUMB_TIP,
    WRIST,
    HandObservation,
)

BONE_PAIRS = (
    (WRIST, MIDDLE_MCP),
    (INDEX_MCP, PINKY_MCP),
    (WRIST, INDEX_MCP),
    (WRIST, PINKY_MCP),
)


def aspect_corrected_points(landmarks: np.ndarray, aspect: float) -> np.ndarray:
    """Stretch x and z so normalized MediaPipe coords are isotropic in image space.

    MediaPipe x and z share the image-width normalization; y uses image height.
    """
    out = np.asarray(landmarks, dtype=np.float64).copy()
    if out.ndim != 2 or out.shape[1] < 2:
        raise ValueError("landmarks must be (N, 2+) ")
    out[:, 0] = out[:, 0] * aspect
    if out.shape[1] >= 3:
        out[:, 2] = out[:, 2] * aspect
    return out


def euclidean(a: np.ndarray, b: np.ndarray) -> float:
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    n = min(a.size, b.size, 3)
    return float(np.linalg.norm(a[:n] - b[:n]))


def select_source_landmarks(hand: HandObservation, source: str) -> tuple[np.ndarray, str]:
    if source in {"world_3d", "world"}:
        if hand.world_landmarks is not None:
            return hand.world_landmarks, "world_3d"
        return hand.landmarks, "image_3d"
    if source in {"normalized_3d", "image_3d", "normalized_2d"}:
        return hand.landmarks, "image_3d"
    raise ValueError(f"Unknown feature source: {source}")


def prepare_landmarks(hand: HandObservation, source: str, aspect: float) -> tuple[np.ndarray, str]:
    points, resolved = select_source_landmarks(hand, source)
    if resolved == "world_3d":
        return np.asarray(points, dtype=np.float64), resolved
    return aspect_corrected_points(points, aspect), resolved


def thumb_index_distance(points: np.ndarray) -> float:
    return euclidean(points[THUMB_TIP], points[INDEX_TIP])


def compute_hand_scale(points: np.ndarray, mode: str, min_scale: float) -> float:
    if mode == "wrist_middle_mcp":
        scale = euclidean(points[WRIST], points[MIDDLE_MCP])
    elif mode == "palm_width":
        scale = euclidean(points[INDEX_MCP], points[PINKY_MCP])
    elif mode == "bone_median":
        lengths = [euclidean(points[a], points[b]) for a, b in BONE_PAIRS]
        scale = float(np.median(lengths))
    else:
        raise ValueError(f"Unknown scale_mode: {mode}")
    if not np.isfinite(scale) or scale < min_scale:
        return float("nan")
    return scale


def normalized_gripper_distance(distance: float, scale: float) -> float:
    if not np.isfinite(distance) or not np.isfinite(scale) or scale == 0:
        return float("nan")
    return distance / scale


@dataclass
class HandFeatures:
    thumb_index_distance: float
    hand_scale: float
    hand_scale_raw: float
    normalized_gripper_distance: float
    thumb: np.ndarray
    index: np.ndarray
    wrist: np.ndarray
    index_mcp: np.ndarray
    middle_mcp: np.ndarray
    middle_tip: np.ndarray


class FeatureExtractor:
    """Per-frame geometry plus an optional rolling-median hand scale."""

    def __init__(self, config: FeaturesConfig, aspect: float = 1.0) -> None:
        self.config = config
        self.aspect = aspect
        window = max(1, int(config.scale_median_window))
        self._scale_hist: deque[float] = deque(maxlen=window)

    def reset(self) -> None:
        self._scale_hist.clear()

    def extract(self, hand: HandObservation | None) -> HandFeatures | None:
        if hand is None:
            return None
        try:
            points, _resolved = prepare_landmarks(hand, self.config.source, self.aspect)
        except ValueError:
            return None
        distance = thumb_index_distance(points)
        raw_scale = compute_hand_scale(points, self.config.scale_mode, self.config.min_scale)
        if np.isfinite(raw_scale):
            self._scale_hist.append(raw_scale)
        if self._scale_hist:
            scale = float(np.median(self._scale_hist))
        else:
            scale = raw_scale
        norm = normalized_gripper_distance(distance, scale)
        return HandFeatures(
            thumb_index_distance=distance,
            hand_scale=scale,
            hand_scale_raw=raw_scale,
            normalized_gripper_distance=norm,
            thumb=points[THUMB_TIP].copy(),
            index=points[INDEX_TIP].copy(),
            wrist=points[WRIST].copy(),
            index_mcp=points[INDEX_MCP].copy(),
            middle_mcp=points[MIDDLE_MCP].copy(),
            middle_tip=points[MIDDLE_MCP + 3].copy() if points.shape[0] > MIDDLE_MCP + 3 else points[MIDDLE_MCP].copy(),
        )
