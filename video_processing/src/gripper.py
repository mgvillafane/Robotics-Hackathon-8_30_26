"""Map a normalized distance to a continuous gripper value and a discrete state."""

from __future__ import annotations

from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from config import GripperConfig

STATES = ("OPEN", "CLOSING", "CLOSED", "OPENING", "UNKNOWN")


@dataclass
class GripperCalibration:
    closed_threshold: float
    open_threshold: float
    auto: bool


class GripperMapper:
    def __init__(self, config: GripperConfig) -> None:
        self.config = config
        self.closed_threshold = config.closed_threshold
        self.open_threshold = config.open_threshold

    def calibrate(self, values: Sequence[float]) -> GripperCalibration:
        finite = np.asarray(values, dtype=np.float64)
        finite = finite[np.isfinite(finite)]
        if self.config.auto_calibrate and finite.size >= 8:
            lo = float(np.percentile(finite, self.config.auto_p_low))
            hi = float(np.percentile(finite, self.config.auto_p_high))
            if hi - lo > 1e-4:
                self.closed_threshold = lo
                self.open_threshold = hi
                return GripperCalibration(lo, hi, True)
        self.closed_threshold = self.config.closed_threshold
        self.open_threshold = self.config.open_threshold
        return GripperCalibration(self.closed_threshold, self.open_threshold, False)

    def value(self, normalized_distance: float) -> float:
        return map_gripper_value(
            normalized_distance,
            self.closed_threshold,
            self.open_threshold,
        )

    def map_series(self, values: Sequence[float]) -> np.ndarray:
        return np.asarray([self.value(v) for v in values], dtype=np.float64)


def map_gripper_value(
    normalized_distance: float,
    closed_threshold: float,
    open_threshold: float,
) -> float:
    if not np.isfinite(normalized_distance):
        return float("nan")
    span = open_threshold - closed_threshold
    if abs(span) < 1e-9:
        return 0.0 if normalized_distance <= closed_threshold else 1.0
    raw = (normalized_distance - closed_threshold) / span
    return float(np.clip(raw, 0.0, 1.0))


class GripperStateMachine:
    """Hysteresis + dwell time + velocity so stationary noise does not chatter."""

    def __init__(self, config: GripperConfig) -> None:
        self.config = config
        self.state = "UNKNOWN"
        self._hold = 0
        self._missing = 0
        self._pending: str | None = None
        self._pending_hold = 0
        self._history: deque[float] = deque(maxlen=max(2, config.velocity_window))

    def reset(self) -> None:
        self.state = "UNKNOWN"
        self._hold = 0
        self._missing = 0
        self._pending = None
        self._pending_hold = 0
        self._history.clear()

    def step(self, gripper_value: float) -> str:
        if not np.isfinite(gripper_value):
            self._missing += 1
            if self._missing > self.config.max_missing_frames:
                self._set("UNKNOWN")
            return self.state

        self._missing = 0
        self._history.append(float(gripper_value))
        velocity = self._velocity()
        proposed = self._propose(float(gripper_value), velocity)
        if proposed == self.state:
            self._hold += 1
            self._pending = None
            self._pending_hold = 0
            return self.state
        if self._pending == proposed:
            self._pending_hold += 1
        else:
            self._pending = proposed
            self._pending_hold = 1
        if self._pending_hold >= self.config.min_state_frames:
            self._set(proposed)
        return self.state

    def apply(self, values: Sequence[float]) -> list[str]:
        self.reset()
        return [self.step(v) for v in values]

    def _set(self, state: str) -> None:
        self.state = state
        self._hold = 0
        self._pending = None
        self._pending_hold = 0

    def _velocity(self) -> float:
        if len(self._history) < 2:
            return 0.0
        return float(self._history[-1] - self._history[0]) / max(len(self._history) - 1, 1)

    def _propose(self, value: float, velocity: float) -> str:
        cfg = self.config
        if value <= cfg.enter_closed:
            return "CLOSED"
        if value >= cfg.enter_open:
            return "OPEN"
        if self.state == "UNKNOWN":
            if value < 0.5:
                return "CLOSING" if velocity <= 0 else "OPENING"
            return "OPENING" if velocity >= 0 else "CLOSING"
        if self.state == "OPEN":
            if value < cfg.exit_open or velocity <= cfg.closing_velocity:
                return "CLOSING"
            return "OPEN"
        if self.state == "CLOSED":
            if value > cfg.exit_closed or velocity >= cfg.opening_velocity:
                return "OPENING"
            return "CLOSED"
        if self.state == "CLOSING":
            if velocity >= cfg.opening_velocity and value > cfg.exit_closed:
                return "OPENING"
            if value > cfg.exit_open and velocity >= 0:
                return "OPEN"
            return "CLOSING"
        if self.state == "OPENING":
            if velocity <= cfg.closing_velocity and value < cfg.exit_open:
                return "CLOSING"
            if value < cfg.exit_closed and velocity <= 0:
                return "CLOSED"
            return "OPENING"
        return "UNKNOWN"
