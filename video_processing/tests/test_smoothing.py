from __future__ import annotations

import numpy as np

from smoothing import ema_filter, median_filter, savgol_smooth, smooth_series
from config import SmoothingConfig


def test_median_does_not_bridge_nans() -> None:
    x = [1.0, 1.1, np.nan, np.nan, 2.0, 2.1]
    out = median_filter(x, 3)
    assert np.isnan(out[2]) and np.isnan(out[3])
    assert np.isfinite(out[0]) and np.isfinite(out[5])


def test_ema_resets_after_gap() -> None:
    x = [1.0, 1.0, 1.0, np.nan, np.nan, np.nan, 10.0]
    out = ema_filter(x, alpha=0.5, reset_gap_frames=1)
    assert np.isnan(out[3])
    assert out[6] == 10.0


def test_ema_reset_starts_fresh() -> None:
    x = [0.0, 0.0, np.nan, np.nan, np.nan, 4.0]
    out = ema_filter(x, alpha=0.5, reset_gap_frames=1)
    assert out[5] == 4.0


def test_savgol_preserves_gaps() -> None:
    x = np.linspace(0, 1, 20)
    x[8:12] = np.nan
    out = savgol_smooth(x, window=5, polyorder=2)
    assert np.all(np.isnan(out[8:12]))
    assert np.isfinite(out[0]) and np.isfinite(out[-1])


def test_smooth_series_ema() -> None:
    cfg = SmoothingConfig(method="ema", ema_alpha=1.0, median_window=1)
    x = [0.2, 0.4, 0.6]
    out = smooth_series(x, cfg)
    np.testing.assert_allclose(out, x)
