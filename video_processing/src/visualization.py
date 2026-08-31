"""Overlay MediaPipe skeleton, HUD, gripper bar, and a live signal strip."""

from __future__ import annotations

from collections import deque
from collections.abc import Sequence

import cv2
import numpy as np

from config import VisualizationConfig
from events import GripperEvent
from hand_tracking import HAND_CONNECTIONS, HandObservation

STATE_COLORS = {
    "OPEN": (60, 200, 80),
    "CLOSING": (40, 180, 220),
    "CLOSED": (40, 80, 230),
    "OPENING": (220, 180, 40),
    "UNKNOWN": (160, 160, 160),
}


def _relative_depth(point: np.ndarray, wrist_z: float) -> float:
    """MediaPipe image z: smaller values are closer to the camera."""
    if point.size < 3:
        return 0.0
    return float(wrist_z - point[2])


def _project_point(
    point: np.ndarray,
    width: int,
    height: int,
    wrist_z: float,
    *,
    depth_cue: bool,
    y_shift: float,
) -> tuple[tuple[int, int], float]:
    x = float(point[0])
    y = float(point[1])
    rel = _relative_depth(point, wrist_z)
    scale = 1.0
    if depth_cue:
        scale = float(np.clip(1.0 + rel * 10.0, 0.55, 1.45))
        y -= rel * y_shift
    px = int(np.clip(x, 0.0, 1.0) * (width - 1))
    py = int(np.clip(y, 0.0, 1.0) * (height - 1))
    return (px, py), scale


def _blend_toward_white(color: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    amount = float(np.clip(amount, 0.0, 1.0))
    return tuple(int(c + (255 - c) * amount) for c in color)


def draw_hand(
    frame: np.ndarray,
    hand: HandObservation,
    color: tuple[int, int, int],
    *,
    depth_cue: bool = True,
    depth_y_shift: float = 0.12,
) -> None:
    h, w = frame.shape[:2]
    wrist_z = float(hand.landmarks[0, 2]) if hand.landmarks.shape[1] >= 3 else 0.0
    pts: list[tuple[int, int]] = []
    scales: list[float] = []
    for lm in hand.landmarks:
        (px, py), scale = _project_point(
            lm,
            w,
            h,
            wrist_z,
            depth_cue=depth_cue,
            y_shift=depth_y_shift,
        )
        pts.append((px, py))
        scales.append(scale)

    rel_depths = [_relative_depth(lm, wrist_z) for lm in hand.landmarks]
    zmin = min(rel_depths)
    zmax = max(rel_depths)
    zspan = max(zmax - zmin, 1e-6)

    for a, b in HAND_CONNECTIONS:
        rel = 0.5 * (rel_depths[a] + rel_depths[b])
        t = (rel - zmin) / zspan
        line_color = _blend_toward_white(color, 0.35 * (1.0 - t)) if depth_cue else color
        thickness = max(1, int(round(2 * 0.5 * (scales[a] + scales[b]))))
        cv2.line(frame, pts[a], pts[b], line_color, thickness, cv2.LINE_AA)

    for i, ((px, py), scale) in enumerate(zip(pts, scales)):
        t = (rel_depths[i] - zmin) / zspan
        pt_color = _blend_toward_white(color, 0.25 * (1.0 - t)) if depth_cue else color
        radius = max(2, int(round(3 * scale)))
        cv2.circle(frame, (px, py), radius, pt_color, -1, cv2.LINE_AA)

    for idx in (4, 8):
        radius = max(4, int(round(6 * scales[idx])))
        cv2.circle(frame, pts[idx], radius, (0, 255, 255), 2, cv2.LINE_AA)
    cv2.line(frame, pts[4], pts[8], (0, 255, 255), max(1, int(round(2 * scales[4]))), cv2.LINE_AA)


def draw_hud(
    frame: np.ndarray,
    *,
    hand_label: str,
    gripper_value: float,
    state: str,
    detected: bool,
    scale: float = 1.0,
) -> None:
    color = STATE_COLORS.get(state, STATE_COLORS["UNKNOWN"])
    value_txt = "nan" if not np.isfinite(gripper_value) else f"{gripper_value:.2f}"
    lines = [
        f"HAND: {hand_label if detected else 'NONE'}",
        f"GRIPPER: {value_txt}",
        f"STATE: {state}",
    ]
    x, y = int(12 * scale), int(28 * scale)
    font = cv2.FONT_HERSHEY_SIMPLEX
    for i, line in enumerate(lines):
        yy = y + int(i * 26 * scale)
        cv2.putText(frame, line, (x + 1, yy + 1), font, 0.65 * scale, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(frame, line, (x, yy), font, 0.65 * scale, color, 2, cv2.LINE_AA)

    bar_x, bar_y = int(12 * scale), int(110 * scale)
    bar_w, bar_h = int(180 * scale), int(16 * scale)
    cv2.rectangle(frame, (bar_x, bar_y), (bar_x + bar_w, bar_y + bar_h), (30, 30, 30), -1)
    if np.isfinite(gripper_value):
        fill = int(np.clip(gripper_value, 0, 1) * bar_w)
        cv2.rectangle(frame, (bar_x, bar_y), (bar_x + fill, bar_y + bar_h), color, -1)
    cv2.rectangle(frame, (bar_x, bar_y), (bar_x + bar_w, bar_y + bar_h), (230, 230, 230), 1)


class SignalStrip:
    def __init__(self, window_s: float, fps: float) -> None:
        self.capacity = max(16, int(window_s * max(fps, 1.0)))
        self.values: deque[float] = deque(maxlen=self.capacity)
        self.events: deque[tuple[int, str]] = deque(maxlen=self.capacity)
        self._index = 0

    def push(self, value: float, event_name: str | None = None) -> None:
        self.values.append(value)
        if event_name:
            self.events.append((self._index, event_name))
        self._index += 1

    def draw(self, frame: np.ndarray) -> None:
        h, w = frame.shape[:2]
        plot_h = max(60, h // 5)
        x0, y0 = 10, h - plot_h - 10
        x1, y1 = w - 10, h - 10
        overlay = frame.copy()
        cv2.rectangle(overlay, (x0, y0), (x1, y1), (20, 20, 20), -1)
        cv2.addWeighted(overlay, 0.55, frame, 0.45, 0, frame)
        cv2.rectangle(frame, (x0, y0), (x1, y1), (200, 200, 200), 1)
        cv2.putText(
            frame,
            "normalized thumb-index",
            (x0 + 8, y0 + 16),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (220, 220, 220),
            1,
            cv2.LINE_AA,
        )
        vals = np.asarray(self.values, dtype=np.float64)
        if vals.size < 2:
            return
        finite = vals[np.isfinite(vals)]
        if finite.size == 0:
            return
        vmin = float(np.min(finite))
        vmax = float(np.max(finite))
        if vmax - vmin < 1e-4:
            vmax = vmin + 1e-4
        pts = []
        width = x1 - x0
        height = y1 - y0 - 22
        for i, value in enumerate(vals):
            if not np.isfinite(value):
                if pts:
                    cv2.polylines(frame, [np.asarray(pts, dtype=np.int32)], False, (80, 220, 255), 2, cv2.LINE_AA)
                    pts = []
                continue
            x = x0 + int(i / max(len(vals) - 1, 1) * width)
            y = y1 - 4 - int((value - vmin) / (vmax - vmin) * height)
            pts.append((x, y))
        if pts:
            cv2.polylines(frame, [np.asarray(pts, dtype=np.int32)], False, (80, 220, 255), 2, cv2.LINE_AA)
        first_idx = self._index - len(vals)
        for ev_idx, name in self.events:
            rel = ev_idx - first_idx
            if rel < 0 or rel >= len(vals):
                continue
            x = x0 + int(rel / max(len(vals) - 1, 1) * width)
            if name == "GRASP_RELEASE":
                color = (40, 220, 80)
            elif name == "GRASP_START":
                color = (40, 80, 255)
            else:
                color = (200, 200, 40)
            cv2.line(frame, (x, y0 + 20), (x, y1 - 2), color, 1, cv2.LINE_AA)


def render_overlay_frame(
    frame: np.ndarray,
    *,
    primary: HandObservation | None,
    others: Sequence[HandObservation],
    hand_label: str,
    gripper_value: float,
    state: str,
    normalized: float,
    events: Sequence[str],
    strip: SignalStrip,
    config: VisualizationConfig,
) -> np.ndarray:
    out = frame.copy()
    for hand in others:
        draw_hand(
            out,
            hand,
            (180, 140, 80),
            depth_cue=config.depth_cue,
            depth_y_shift=config.depth_y_shift,
        )
    if primary is not None:
        draw_hand(
            out,
            primary,
            (80, 220, 80),
            depth_cue=config.depth_cue,
            depth_y_shift=config.depth_y_shift,
        )
    draw_hud(
        out,
        hand_label=hand_label,
        gripper_value=gripper_value,
        state=state,
        detected=primary is not None,
        scale=config.hud_scale,
    )
    event_name = events[0] if events else None
    strip.push(normalized, event_name)
    strip.draw(out)
    return out


def events_for_frame(events: Sequence[GripperEvent], frame_index: int) -> list[str]:
    return [e.event for e in events if e.frame == frame_index]
