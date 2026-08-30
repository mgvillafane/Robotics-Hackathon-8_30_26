"""NaN-aware temporal smoothing. Gaps are never interpolated across."""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
from scipy.signal import savgol_filter

from config import SmoothingConfig


def _finite_segments(values: np.ndarray) -> list[tuple[int, int]]:
    segments: list[tuple[int, int]] = []
    start: int | None = None
    for i, ok in enumerate(np.isfinite(values)):
        if ok and start is None:
            start = i
        elif not ok and start is not None:
            segments.append((start, i))
            start = None
    if start is not None:
        segments.append((start, len(values)))
    return segments


def median_filter(values: Sequence[float], window: int) -> np.ndarray:
    x = np.asarray(values, dtype=np.float64)
    if window <= 1:
        return x.copy()
    if window % 2 == 0:
        window += 1
    out = np.full_like(x, np.nan)
    half = window // 2
    for start, end in _finite_segments(x):
        seg = x[start:end]
        filtered = np.empty_like(seg)
        for i in range(len(seg)):
            lo = max(0, i - half)
            hi = min(len(seg), i + half + 1)
            filtered[i] = float(np.median(seg[lo:hi]))
        out[start:end] = filtered
    return out


def ema_filter(values: Sequence[float], alpha: float, reset_gap_frames: int) -> np.ndarray:
    if not 0.0 < alpha <= 1.0:
        raise ValueError("ema_alpha must be in (0, 1]")
    x = np.asarray(values, dtype=np.float64)
    out = np.full_like(x, np.nan)
    state: float | None = None
    gap = 0
    for i, value in enumerate(x):
        if not np.isfinite(value):
            gap += 1
            if gap > reset_gap_frames:
                state = None
            continue
        if state is None or gap > reset_gap_frames:
            state = float(value)
        else:
            state = alpha * float(value) + (1.0 - alpha) * state
        out[i] = state
        gap = 0
    return out


def savgol_smooth(values: Sequence[float], window: int, polyorder: int) -> np.ndarray:
    x = np.asarray(values, dtype=np.float64)
    if window % 2 == 0:
        window += 1
    out = np.full_like(x, np.nan)
    for start, end in _finite_segments(x):
        seg = x[start:end]
        length = len(seg)
        if length < polyorder + 2:
            out[start:end] = seg
            continue
        win = min(window, length if length % 2 == 1 else length - 1)
        if win < polyorder + 2:
            out[start:end] = seg
            continue
        out[start:end] = savgol_filter(seg, window_length=win, polyorder=polyorder, mode="interp")
    return out


def smooth_series(values: Sequence[float], config: SmoothingConfig) -> np.ndarray:
    x = np.asarray(values, dtype=np.float64)
    if config.median_window and config.median_window > 1:
        x = median_filter(x, config.median_window)
    method = config.method.lower()
    if method == "ema":
        return ema_filter(x, config.ema_alpha, config.reset_gap_frames)
    if method == "savgol":
        return savgol_smooth(x, config.savgol_window, config.savgol_polyorder)
    if method == "median":
        return median_filter(x, config.median_window)
    raise ValueError(f"Unknown smoothing method: {config.method}")
