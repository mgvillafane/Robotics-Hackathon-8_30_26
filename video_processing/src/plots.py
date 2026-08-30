"""Standalone matplotlib figure of the gripper signal stages."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

from events import GripperEvent

STATE_TO_INT = {
    "CLOSED": 0,
    "CLOSING": 1,
    "OPENING": 2,
    "OPEN": 3,
    "UNKNOWN": np.nan,
}
STATE_COLORS = {
    "CLOSED": "#d62728",
    "CLOSING": "#ff7f0e",
    "OPENING": "#2ca02c",
    "OPEN": "#1f77b4",
    "UNKNOWN": "#7f7f7f",
}


def plot_signal(
    path: str | Path,
    *,
    timestamps: Sequence[float],
    raw_normalized: Sequence[float],
    smoothed: Sequence[float],
    gripper_values: Sequence[float],
    states: Sequence[str],
    events: Sequence[GripperEvent],
    closed_threshold: float,
    open_threshold: float,
) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.asarray(timestamps, dtype=np.float64)
    raw = np.asarray(raw_normalized, dtype=np.float64)
    sm = np.asarray(smoothed, dtype=np.float64)
    gv = np.asarray(gripper_values, dtype=np.float64)

    fig, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True, constrained_layout=True)

    axes[0].plot(t, raw, color="#9ecae1", linewidth=1.0, label="raw normalized")
    axes[0].plot(t, sm, color="#08519c", linewidth=1.6, label="smoothed")
    axes[0].axhline(closed_threshold, color="#d62728", linestyle="--", linewidth=1, label="closed")
    axes[0].axhline(open_threshold, color="#2ca02c", linestyle="--", linewidth=1, label="open")
    axes[0].set_ylabel("thumb-index / scale")
    axes[0].legend(loc="upper right", fontsize=8)
    axes[0].set_title("Normalized thumb-index distance")

    axes[1].plot(t, gv, color="#6a3d9a", linewidth=1.6, label="gripper value")
    axes[1].set_ylim(-0.05, 1.05)
    axes[1].set_ylabel("0 closed / 1 open")
    axes[1].legend(loc="upper right", fontsize=8)
    axes[1].set_title("Continuous gripper value")

    state_y = np.array([STATE_TO_INT[s] if s in STATE_TO_INT else np.nan for s in states], dtype=np.float64)
    axes[2].step(t, state_y, where="post", color="#333333", linewidth=1.2)
    axes[2].set_yticks([0, 1, 2, 3])
    axes[2].set_yticklabels(["CLOSED", "CLOSING", "OPENING", "OPEN"])
    axes[2].set_ylabel("state")
    axes[2].set_xlabel("time (s)")
    axes[2].set_title("Discrete gripper state")

    for ev in events:
        color = "#d62728" if ev.event == "GRASP_START" else "#2ca02c" if ev.event == "GRASP_RELEASE" else "#ffbb78"
        for ax in axes:
            ax.axvline(ev.timestamp, color=color, alpha=0.55, linewidth=1.0)
        axes[2].annotate(
            ev.event,
            xy=(ev.timestamp, 3.05),
            xytext=(0, 6),
            textcoords="offset points",
            rotation=90,
            fontsize=7,
            color=color,
            ha="center",
        )

    fig.savefig(path, dpi=140)
    plt.close(fig)
    return path
