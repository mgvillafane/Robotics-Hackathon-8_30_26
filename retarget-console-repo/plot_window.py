#!/usr/bin/env python3
"""
plot_window.py

Render the MediaPipe gripper-analysis figure for ONE time window, on a
timeline that starts at 0 -- so it lines up with a trimmed clip's video and
trajectory in the Retarget Console's "perception signal" panel.

It is a windowed, de-cluttered restyle of video_processing's plots/signal.png
(which always spans the whole 5-minute clip). Reads frames.csv (+ events.csv
if present) and writes a PNG.

    python plot_window.py frames.csv signal.png --start-s 55 --end-s 80

Usually you don't call this directly -- make_clip.py runs it and embeds the
PNG in the trajectory JSON so the console shows it automatically.

The plot's data area sits at PLOT_MARGINS["left"] .. ["right"] as a fraction
of image width; the console uses those two numbers to place its playhead.
"""

import argparse
import csv
import math

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

# Fixed so the console's playhead math is exact (no constrained_layout).
PLOT_MARGINS = {"left": 0.115, "right": 0.985, "top": 0.900, "bottom": 0.140}

STATE_TO_INT = {"CLOSED": 0, "CLOSING": 1, "OPENING": 2, "OPEN": 3}
EVENT_COLOR = {"GRASP_START": "#d62728", "GRASP_RELEASE": "#2ca02c", "GRASP_HOLD": "#ffbb78"}


def _num(v):
    v = ("" if v is None else str(v)).strip()
    if v == "" or v.lower() in ("nan", "none", "null"):
        return math.nan
    try:
        return float(v)
    except ValueError:
        return math.nan


def _read_csv(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def render(frames_csv, out_png, start_s=0.0, end_s=None, events_csv=None, title=None):
    rows = _read_csv(frames_csv)
    t_all = [_num(r.get("timestamp")) for r in rows]
    if end_s is None:
        end_s = max(x for x in t_all if not math.isnan(x))

    keep = [
        i for i, t in enumerate(t_all)
        if not math.isnan(t) and start_s <= t <= end_s
    ]
    if not keep:
        raise SystemExit("plot_window: no rows in the requested window")

    t = np.array([t_all[i] - start_s for i in keep])  # timeline starts at 0
    raw = np.array([_num(rows[i].get("normalized_gripper_distance")) for i in keep])
    sm = np.array([_num(rows[i].get("smoothed_normalized_distance")) for i in keep])
    gv = np.array([_num(rows[i].get("gripper_value")) for i in keep])
    states = [str(rows[i].get("gripper_state", "")).strip().upper() for i in keep]
    dur = float(t[-1]) if len(t) else 0.0

    # thresholds aren't stored in frames.csv; approximate from the in-window
    # smoothed signal the same way video_processing's auto-calibration does.
    fin = sm[np.isfinite(sm)]
    closed_t = float(np.percentile(fin, 20)) if fin.size else math.nan
    open_t = float(np.percentile(fin, 80)) if fin.size else math.nan

    evs = []
    if events_csv:
        try:
            for e in _read_csv(events_csv):
                et = _num(e.get("timestamp"))
                if not math.isnan(et) and start_s <= et <= end_s:
                    evs.append((et - start_s, str(e.get("event", "")).strip().upper()))
        except FileNotFoundError:
            pass

    fig, axes = plt.subplots(3, 1, figsize=(15, 3.9), sharex=True)
    fig.subplots_adjust(hspace=0.5, **PLOT_MARGINS)
    for ax in axes:
        ax.tick_params(labelsize=6.5)

    axes[0].plot(t, raw, color="#9ecae1", lw=1.0, label="raw")
    axes[0].plot(t, sm, color="#08519c", lw=1.6, label="smoothed")
    if math.isfinite(closed_t):
        axes[0].axhline(closed_t, color="#d62728", ls="--", lw=1, label="closed ~p20")
        axes[0].axhline(open_t, color="#2ca02c", ls="--", lw=1, label="open ~p80")
    axes[0].set_ylabel("thumb-index / scale", fontsize=8)
    axes[0].legend(loc="upper right", fontsize=7, ncol=2)
    axes[0].set_title(title or "normalized thumb-index distance", fontsize=9)

    axes[1].plot(t, gv, color="#6a3d9a", lw=1.6)
    axes[1].set_ylim(-0.05, 1.05)
    axes[1].set_ylabel("gripper  0=closed 1=open", fontsize=8)

    sy = np.array([STATE_TO_INT.get(s, np.nan) for s in states], dtype=float)
    axes[2].step(t, sy, where="post", color="#333333", lw=1.3)
    axes[2].set_yticks([0, 1, 2, 3])
    axes[2].set_yticklabels(["CLOSED", "CLOSING", "OPENING", "OPEN"])
    axes[2].set_ylabel("state", fontsize=8)
    axes[2].set_xlabel("time (s, from clip start)", fontsize=8)
    axes[2].set_xlim(0, dur if dur > 0 else 1)

    seen = set()
    for et, name in evs:
        c = EVENT_COLOR.get(name, "#888888")
        for ax in axes:
            ax.axvline(et, color=c, alpha=0.5, lw=1.0)
        if name not in seen:
            axes[0].plot([], [], color=c, lw=1.0, label=name.replace("GRASP_", "").lower())
            seen.add(name)
    if seen:
        axes[0].legend(loc="upper right", fontsize=7, ncol=2)

    fig.savefig(out_png, dpi=130)
    plt.close(fig)
    return out_png


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("frames_csv")
    ap.add_argument("out_png")
    ap.add_argument("--start-s", type=float, default=0.0)
    ap.add_argument("--end-s", type=float, default=None)
    ap.add_argument("--events-csv", default=None, help="events.csv (default: sibling of frames.csv)")
    ap.add_argument("--title", default=None)
    args = ap.parse_args()

    events_csv = args.events_csv
    if events_csv is None:
        import os
        cand = os.path.join(os.path.dirname(os.path.abspath(args.frames_csv)), "events.csv")
        events_csv = cand if os.path.isfile(cand) else None

    out = render(args.frames_csv, args.out_png, args.start_s, args.end_s, events_csv, args.title)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
