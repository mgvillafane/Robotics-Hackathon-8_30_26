"""MediaPipe hand landmark detection behind a narrow tracker protocol."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np

from config import TrackingConfig

LANDMARK_NAMES = (
    "wrist",
    "thumb_cmc",
    "thumb_mcp",
    "thumb_ip",
    "thumb_tip",
    "index_mcp",
    "index_pip",
    "index_dip",
    "index_tip",
    "middle_mcp",
    "middle_pip",
    "middle_dip",
    "middle_tip",
    "ring_mcp",
    "ring_pip",
    "ring_dip",
    "ring_tip",
    "pinky_mcp",
    "pinky_pip",
    "pinky_dip",
    "pinky_tip",
)

WRIST = 0
THUMB_TIP = 4
INDEX_MCP = 5
INDEX_TIP = 8
MIDDLE_MCP = 9
MIDDLE_TIP = 12
PINKY_MCP = 17

HAND_CONNECTIONS = (
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (0, 9), (9, 10), (10, 11), (11, 12),
    (0, 13), (13, 14), (14, 15), (15, 16),
    (0, 17), (17, 18), (18, 19), (19, 20),
    (5, 9), (9, 13), (13, 17),
)


@dataclass
class HandObservation:
    label: str
    handedness_score: float
    detection_confidence: float
    tracking_confidence: float
    landmarks: np.ndarray
    world_landmarks: np.ndarray | None = None

    def point(self, index: int) -> np.ndarray:
        return self.landmarks[index]


@dataclass
class FrameObservation:
    frame_index: int
    timestamp_s: float
    hands: list[HandObservation] = field(default_factory=list)

    @property
    def hand_detected(self) -> bool:
        return bool(self.hands)


class HandTracker(Protocol):
    def process(
        self,
        frame_bgr: np.ndarray,
        frame_index: int,
        timestamp_s: float,
    ) -> FrameObservation: ...

    def close(self) -> None: ...


def _landmarks_to_array(landmarks: object) -> np.ndarray:
    rows = []
    for lm in landmarks:
        rows.append((float(lm.x), float(lm.y), float(getattr(lm, "z", 0.0))))
    return np.asarray(rows, dtype=np.float64)


class MediaPipeHandTracker:
    """VIDEO-mode Hand Landmarker with a legacy Hands fallback."""

    def __init__(self, config: TrackingConfig, model_path: Path) -> None:
        self.config = config
        self.model_path = Path(model_path)
        self._mode = "tasks"
        self._landmarker = None
        self._legacy = None
        self._legacy_mp = None
        if self.model_path.exists() and self.model_path.stat().st_size > 0:
            self._init_tasks()
        else:
            self._init_legacy()

    def _init_tasks(self) -> None:
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision

        options = vision.HandLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=str(self.model_path)),
            running_mode=vision.RunningMode.VIDEO,
            num_hands=self.config.num_hands,
            min_hand_detection_confidence=self.config.min_detection_confidence,
            min_hand_presence_confidence=self.config.min_presence_confidence,
            min_tracking_confidence=self.config.min_tracking_confidence,
        )
        self._landmarker = vision.HandLandmarker.create_from_options(options)
        self._mp = mp
        self._mode = "tasks"

    def _init_legacy(self) -> None:
        import mediapipe as mp

        if not hasattr(mp, "solutions") or not hasattr(mp.solutions, "hands"):
            raise RuntimeError(
                "Hand Landmarker model is missing and this MediaPipe build "
                "has no mediapipe.solutions.hands fallback. Run scripts/fetch_model.py"
            )
        self._legacy_mp = mp
        self._legacy = mp.solutions.hands.Hands(
            static_image_mode=False,
            max_num_hands=self.config.num_hands,
            min_detection_confidence=self.config.min_detection_confidence,
            min_tracking_confidence=self.config.min_tracking_confidence,
            model_complexity=1,
        )
        self._mode = "legacy"

    def process(
        self,
        frame_bgr: np.ndarray,
        frame_index: int,
        timestamp_s: float,
    ) -> FrameObservation:
        if self._mode == "tasks":
            return self._process_tasks(frame_bgr, frame_index, timestamp_s)
        return self._process_legacy(frame_bgr, frame_index, timestamp_s)

    def _process_tasks(
        self,
        frame_bgr: np.ndarray,
        frame_index: int,
        timestamp_s: float,
    ) -> FrameObservation:
        import cv2

        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        if not rgb.flags["C_CONTIGUOUS"]:
            rgb = np.ascontiguousarray(rgb)
        if rgb.dtype != np.uint8:
            rgb = rgb.astype(np.uint8, copy=False)
        image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        timestamp_ms = max(0, int(round(timestamp_s * 1000.0)))
        result = self._landmarker.detect_for_video(image, timestamp_ms)
        hands: list[HandObservation] = []
        if not result.hand_landmarks:
            return FrameObservation(frame_index, timestamp_s, hands)
        for i, landmarks in enumerate(result.hand_landmarks):
            handed = result.handedness[i][0] if result.handedness else None
            label = (handed.category_name or "Unknown").upper() if handed else "UNKNOWN"
            if label in {"LEFT", "RIGHT", "UNKNOWN"}:
                pass
            else:
                label = label.capitalize()
                if label.lower() == "left":
                    label = "LEFT"
                elif label.lower() == "right":
                    label = "RIGHT"
            score = float(handed.score) if handed else 0.0
            world = None
            if result.hand_world_landmarks:
                world = _landmarks_to_array(result.hand_world_landmarks[i])
            hands.append(
                HandObservation(
                    label=label,
                    handedness_score=score,
                    detection_confidence=score,
                    tracking_confidence=score,
                    landmarks=_landmarks_to_array(landmarks),
                    world_landmarks=world,
                )
            )
        return FrameObservation(frame_index, timestamp_s, hands)

    def _process_legacy(
        self,
        frame_bgr: np.ndarray,
        frame_index: int,
        timestamp_s: float,
    ) -> FrameObservation:
        import cv2

        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False
        result = self._legacy.process(rgb)
        hands: list[HandObservation] = []
        if not result.multi_hand_landmarks:
            return FrameObservation(frame_index, timestamp_s, hands)
        handedness = result.multi_handedness or []
        worlds = result.multi_hand_world_landmarks or []
        for i, landmarks in enumerate(result.multi_hand_landmarks):
            handed = handedness[i].classification[0] if i < len(handedness) else None
            label = (handed.label or "Unknown").upper() if handed else "UNKNOWN"
            score = float(handed.score) if handed else 0.0
            world = _landmarks_to_array(worlds[i].landmark) if i < len(worlds) else None
            hands.append(
                HandObservation(
                    label=label,
                    handedness_score=score,
                    detection_confidence=score,
                    tracking_confidence=score,
                    landmarks=_landmarks_to_array(landmarks.landmark),
                    world_landmarks=world,
                )
            )
        return FrameObservation(frame_index, timestamp_s, hands)

    def close(self) -> None:
        if self._landmarker is not None:
            self._landmarker.close()
            self._landmarker = None
        if self._legacy is not None:
            self._legacy.close()
            self._legacy = None


class NullHandTracker:
    """Always-empty tracker used by tests."""

    def process(
        self,
        frame_bgr: np.ndarray,
        frame_index: int,
        timestamp_s: float,
    ) -> FrameObservation:
        return FrameObservation(frame_index, timestamp_s, [])

    def close(self) -> None:
        return None
