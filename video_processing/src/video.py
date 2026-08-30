"""OpenCV video IO with index-based timestamps."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass(frozen=True)
class VideoInfo:
    path: Path
    fps: float
    frame_count: int
    width: int
    height: int
    out_width: int
    out_height: int

    @property
    def duration_s(self) -> float:
        if self.fps <= 0:
            return 0.0
        return self.frame_count / self.fps

    @property
    def aspect(self) -> float:
        return self.out_width / max(self.out_height, 1)


def _resize_bgr(frame: np.ndarray, resize_width: int | None) -> np.ndarray:
    if resize_width is None or frame.shape[1] == resize_width:
        return frame
    height, width = frame.shape[:2]
    new_h = max(1, int(round(height * (resize_width / width))))
    return cv2.resize(frame, (resize_width, new_h), interpolation=cv2.INTER_AREA)


class VideoReader:
    """Yield (frame_index, timestamp_s, bgr) using the original frame index for time."""

    def __init__(
        self,
        path: str | Path,
        *,
        resize_width: int | None = None,
        stride: int = 1,
        max_frames: int | None = None,
    ) -> None:
        self.path = Path(path)
        if not self.path.exists():
            raise FileNotFoundError(self.path)
        if stride < 1:
            raise ValueError("stride must be >= 1")
        self.resize_width = resize_width
        self.stride = stride
        self.max_frames = max_frames
        cap = cv2.VideoCapture(str(self.path))
        if not cap.isOpened():
            cap.release()
            raise RuntimeError(f"Could not open video: {self.path}")
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        if fps <= 1e-3:
            fps = 30.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        out_w = resize_width if resize_width else width
        out_h = int(round(height * (out_w / max(width, 1)))) if resize_width else height
        self.info = VideoInfo(
            path=self.path,
            fps=fps,
            frame_count=frame_count,
            width=width,
            height=height,
            out_width=out_w,
            out_height=out_h,
        )
        cap.release()

    def frames(self) -> Iterator[tuple[int, float, np.ndarray]]:
        cap = cv2.VideoCapture(str(self.path))
        if not cap.isOpened():
            raise RuntimeError(f"Could not open video: {self.path}")
        try:
            emitted = 0
            index = 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if index % self.stride != 0:
                    index += 1
                    continue
                frame = _resize_bgr(frame, self.resize_width)
                timestamp_s = index / self.info.fps
                yield index, timestamp_s, frame
                emitted += 1
                index += 1
                if self.max_frames is not None and emitted >= self.max_frames:
                    break
        finally:
            cap.release()


class VideoWriter:
    def __init__(self, path: str | Path, fps: float, size: tuple[int, int]) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        self._writer = cv2.VideoWriter(str(self.path), fourcc, fps, size)
        if not self._writer.isOpened():
            raise RuntimeError(f"Could not open writer: {self.path}")

    def write(self, frame: np.ndarray) -> None:
        self._writer.write(frame)

    def close(self) -> None:
        self._writer.release()

    def __enter__(self) -> VideoWriter:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
