#!/usr/bin/env python3
"""
frames_csv_to_trajectory.py

Adapter: the ../video_processing pipeline's `data/frames.csv`  ->  the
`trajectory.json` schema the Retarget Console loads ("Load trajectory (.json)"
button, left panel). No changes to the console; you upload the result.

------------------------------------------------------------------------
WHAT video_processing GIVES US -- AND WHAT IT DOESN'T
------------------------------------------------------------------------
`video_processing` is MediaPipe *Hands* only. Per emitted frame, frames.csv
carries the primary hand's landmarks in normalized image coordinates
(`wrist_x/y`, `index_mcp_x/y`, `middle_mcp_x/y`, ...), a calibrated
`gripper_value` in [0,1] (1 = open, 0 = closed), and a `gripper_state` label.

It never sees the shoulder or the elbow, so it cannot *measure* the arm's
joint angles. This adapter turns what IS observed into the console's six
channels [base_yaw, shoulder_pitch, elbow_pitch, wrist_pitch, wrist_roll,
gripper], and is honest about which is which:

  gripper         SOLID       - `gripper_value` remapped to the console's
                                degrees. open -> --gripper-open-deg,
                                closed -> --gripper-closed-deg. Higher deg =
                                more closed, matching the console's sample.
  wrist_pitch     OK-ISH      - hand orientation in the image plane
                                (wrist -> middle_mcp), made relative to the
                                forearm. Noisy when the palm faces the camera.
  shoulder_pitch  INFERRED    - 2-link planar IK (see --arm-mode below). A
  elbow_pitch     INFERRED      *plausible* arm that tracks the hand's motion,
                                not a measurement.
  base_yaw        PLACEHOLDER - 0 unless --base-yaw-gain is set, which swings
                                the base with the hand's horizontal screen
                                position. Not a real base rotation.
  wrist_roll      PLACEHOLDER - constant 0. Not observable from one hand in
                                this fisheye / foreshortened footage.

--arm-mode:
  workspace (default) - map the wrist's own bounding box over the clip into
                        the arm's reachable envelope, then IK. Always in
                        range; the arm sweeps as the hand sweeps. Tune the
                        envelope with --reach-x-min/max, --reach-y-min/max.
  image               - IK straight off the raw wrist image position against
                        the console's shoulder origin. Only meaningful if the
                        person's hand and the robot's shoulder share a frame
                        (they usually don't) -- expect clipping otherwise.
  fixed               - hold a neutral arm (--rest-shoulder-deg /
                        --rest-elbow-deg); only gripper and wrist_pitch move.
                        The honest choice when you only trust the gripper.

Frames with `hand_detected == False` (NaN landmarks) are filled by holding the
last good value. All six channels are smoothed (centered moving average) and
resampled to a fixed rate so the console gets uniform timing.

------------------------------------------------------------------------
USAGE
------------------------------------------------------------------------
    python frames_csv_to_trajectory.py \
        ../video_processing/outputs/my_video/data/frames.csv \
        trajectory.json

    # then: "Load trajectory (.json)" in the console, left panel.

Common tuning:
    --hand right              retarget only the right arm (see note below)
    --rate 30                 output sample rate (Hz)
    --smooth-window 7         moving-average window (samples)
    --elbow-sign neg|pos      which way the elbow bends
    --gripper-open-deg 10     gripper angle when the hand is fully open
    --gripper-closed-deg 80   gripper angle when the hand is fully closed
    --base-yaw-gain 20        deg of base yaw per full-frame horizontal swing
    --stage-aspect 1.333      width/height of your console's source panel

The defaults for --l1/--l2/--origin-x/--origin-y mirror the console's own
forward-kinematics in drawSkeleton() (L1 = 0.26h, L2 = 0.22h, origin at
0.32w / 0.62h), so the retargeted arm lands where the overlay expects it.

--hand (one arm only):
  video_processing locks onto ONE primary hand per frame and only that hand
  carries full landmarks + a gripper signal. `--hand right` keeps just the
  frames where the primary lock is labelled RIGHT (the rest are treated as
  no-detection and hold-filled); `--hand left` likewise; `--hand any`
  (default) takes whichever hand was primary. If your footage has the target
  hand as the primary lock most of the time this is all you need -- otherwise
  re-run video_processing with its hand-selection config favouring that hand.
"""

import argparse
import csv
import json
import math
import sys

JOINT_NAMES = ["base_yaw", "shoulder_pitch", "elbow_pitch", "wrist_pitch", "wrist_roll", "gripper"]

# frames.csv columns this adapter reads. Everything else in the file is ignored.
COL_T = "timestamp"
COL_DETECTED = "hand_detected"
COL_HAND_LABEL = "hand_label"  # "LEFT" / "RIGHT" for video_processing's primary hand
COL_WRIST = ("wrist_x", "wrist_y")
COL_HAND_DIR = ("middle_mcp_x", "middle_mcp_y")  # wrist -> here = hand pointing direction
COL_GRIPPER = "gripper_value"


def deg(rad):
    return rad * 180.0 / math.pi


def rad(d):
    return d * math.pi / 180.0


def wrap180(a):
    """Fold an angle in degrees into (-180, 180]."""
    a = (a + 180.0) % 360.0 - 180.0
    return a + 360.0 if a <= -180.0 else a


# ----------------------------------------------------------------------
# read + clean
# ----------------------------------------------------------------------
def _num(row, key):
    v = row.get(key, "")
    if v is None:
        return math.nan
    v = str(v).strip()
    if v == "" or v.lower() in ("nan", "none", "null"):
        return math.nan
    try:
        return float(v)
    except ValueError:
        return math.nan


def _truthy(v):
    return str(v).strip().lower() in ("true", "1", "yes", "t")


def load_frames_csv(path):
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise SystemExit(f"{path}: empty file")
        need = {COL_T, COL_WRIST[0], COL_WRIST[1], COL_GRIPPER}
        missing = need - set(reader.fieldnames)
        if missing:
            raise SystemExit(
                f"{path}: missing expected column(s): {', '.join(sorted(missing))}\n"
                f"Is this a video_processing frames.csv?"
            )
        rows = list(reader)
    if not rows:
        raise SystemExit(f"{path}: no data rows")
    return rows


def hold_fill(series, default):
    """Replace NaNs by carrying the last good value forward, then backward.
    A channel that is entirely NaN becomes `default` everywhere."""
    out = list(series)
    last = None
    for i, v in enumerate(out):
        if v is not None and not math.isnan(v):
            last = v
        elif last is not None:
            out[i] = last
    nxt = None
    for i in range(len(out) - 1, -1, -1):
        if out[i] is not None and not math.isnan(out[i]):
            nxt = out[i]
        elif nxt is not None:
            out[i] = nxt
    return [default if (v is None or math.isnan(v)) else v for v in out]


# ----------------------------------------------------------------------
# retarget
# ----------------------------------------------------------------------
def two_link_ik(tx, ty, ox, oy, l1, l2, elbow_sign):
    """Planar 2-link IK in the console's image-plane convention (x right, y
    down). Returns (shoulder_pitch_deg, elbow_pitch_deg) such that
        wrist = origin + L1*(cos s, sin s) + L2*(cos(s+e), sin(s+e))
    lands on (tx, ty), matching drawSkeleton()."""
    dx, dy = tx - ox, ty - oy
    dist = math.hypot(dx, dy)
    dist = max(abs(l1 - l2) + 1e-6, min(l1 + l2 - 1e-6, dist))
    cos_e = (dist * dist - l1 * l1 - l2 * l2) / (2.0 * l1 * l2)
    cos_e = max(-1.0, min(1.0, cos_e))
    elbow = elbow_sign * math.acos(cos_e)
    shoulder = math.atan2(dy, dx) - math.atan2(l2 * math.sin(elbow), l1 + l2 * math.cos(elbow))
    return deg(shoulder), deg(elbow)


def _span_norm(vals, lo, hi, min_span):
    """Normalize each value to 0..1 across [min(vals), max(vals)]. If the span
    is smaller than `min_span` (hand barely moved on this axis), everything
    collapses to 0.5 so we don't amplify jitter."""
    vmin, vmax = min(vals), max(vals)
    if vmax - vmin < min_span:
        return [0.5] * len(vals)
    return [max(lo, min(hi, (v - vmin) / (vmax - vmin))) for v in vals]


def retarget(rows, args):
    aspect = args.stage_aspect
    ox = args.origin_x * aspect
    oy = args.origin_y
    l1, l2 = args.l1, args.l2
    reach = l1 + l2
    elbow_sign = -1.0 if args.elbow_sign == "neg" else 1.0

    t_raw = [_num(r, COL_T) for r in rows]
    good = [
        i for i, t in enumerate(t_raw)
        if not math.isnan(t)
        and (args.start_s is None or t >= args.start_s)
        and (args.end_s is None or t <= args.end_s)
    ]
    if not good:
        raise SystemExit("no usable timestamps in frames.csv (after --start-s/--end-s trim)")
    rows = [rows[i] for i in good]
    ts = [t_raw[i] for i in good]
    t0 = ts[0]
    ts = [t - t0 for t in ts]

    # A frame "counts" only if a hand was detected AND (when --hand is left/right)
    # video_processing's primary hand for that frame is the one we want. Frames
    # that don't match become no-detection and get hold-filled. Only the primary
    # hand carries full landmarks + gripper, so --hand right keeps the frames
    # where the right hand IS the primary lock.
    want = args.hand.lower()
    def row_ok(r):
        if not _truthy(r.get(COL_DETECTED, "true")):
            return False
        if want == "any":
            return True
        return str(r.get(COL_HAND_LABEL, "")).strip().lower() == want
    frame_ok = [row_ok(r) for r in rows]

    def channel(col):
        return [(_num(r, col) if ok else math.nan) for r, ok in zip(rows, frame_ok)]

    wx = hold_fill(channel(COL_WRIST[0]), 0.5)
    wy = hold_fill(channel(COL_WRIST[1]), 0.5)
    have_dir = COL_HAND_DIR[0] in rows[0] and COL_HAND_DIR[1] in rows[0]
    hx = hold_fill(channel(COL_HAND_DIR[0]) if have_dir else [math.nan] * len(rows), math.nan)
    hy = hold_fill(channel(COL_HAND_DIR[1]) if have_dir else [math.nan] * len(rows), math.nan)
    grip = hold_fill(channel(COL_GRIPPER), 1.0)  # default to "open" if never seen

    # per-clip normalization of the wrist path (used by --arm-mode workspace)
    nx = _span_norm(wx, 0.0, 1.0, args.min_span)
    ny = _span_norm(wy, 0.0, 1.0, args.min_span)

    def solve_arm(i):
        if args.arm_mode == "fixed":
            return args.rest_shoulder_deg, args.rest_elbow_deg
        if args.arm_mode == "image":
            tx, ty = wx[i] * aspect, wy[i]
        else:  # workspace
            fx = args.reach_x_min + (args.reach_x_max - args.reach_x_min) * nx[i]
            fy = args.reach_y_min + (args.reach_y_max - args.reach_y_min) * (1.0 - ny[i])
            tx = ox + reach * fx
            ty = oy - reach * fy
        return two_link_ik(tx, ty, ox, oy, l1, l2, elbow_sign)

    frames = []
    for i in range(len(rows)):
        shoulder, elbow = solve_arm(i)

        if not math.isnan(hx[i]) and not (hx[i] == wx[i] and hy[i] == wy[i]):
            a_hand = deg(math.atan2(hy[i] - wy[i], (hx[i] - wx[i]) * aspect))
            wrist_pitch = wrap180(a_hand - (shoulder + elbow))
        else:
            wrist_pitch = 0.0

        base_yaw = args.base_yaw_gain * (wx[i] - 0.5) * 2.0  # (-1..1) * gain

        g = max(0.0, min(1.0, grip[i]))
        gripper = args.gripper_open_deg + (1.0 - g) * (args.gripper_closed_deg - args.gripper_open_deg)
        gripper = max(0.0, min(90.0, gripper))

        frames.append([base_yaw, shoulder, elbow, wrist_pitch, 0.0, gripper])

    n_missing = sum(1 for ok in frame_ok if not ok)
    return ts, frames, len(rows), n_missing


# ----------------------------------------------------------------------
# post: unwrap, smooth, resample  (matches mediapipe_to_trajectory.py)
# ----------------------------------------------------------------------
def unwrap_deg(series):
    if not series:
        return series
    out = [series[0]]
    for v in series[1:]:
        prev = out[-1]
        while v - prev > 180.0:
            v -= 360.0
        while v - prev < -180.0:
            v += 360.0
        out.append(v)
    return out


def unwrap_angle_channels(frames):
    n = len(frames[0])
    cols = list(zip(*frames))
    cols = list(cols)
    for c in range(n):
        if JOINT_NAMES[c] == "gripper":
            continue
        cols[c] = unwrap_deg(list(cols[c]))
    return [list(row) for row in zip(*cols)]


def smooth(series, window):
    n = len(series)
    if n == 0 or window <= 1:
        return series
    nch = len(series[0])
    half = window // 2
    out = []
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        acc = [0.0] * nch
        for j in range(lo, hi):
            for c in range(nch):
                acc[c] += series[j][c]
        cnt = hi - lo
        out.append([v / cnt for v in acc])
    return out


def resample(ts, angles, rate_hz):
    if not ts:
        return [], []
    duration = ts[-1]
    if duration <= 0:
        return [ts[0]], [angles[0]]
    n_out = max(2, int(duration * rate_hz) + 1)
    out_t = [i / rate_hz for i in range(n_out)]
    out_a = []
    j = 0
    for t in out_t:
        while j < len(ts) - 2 and ts[j + 1] < t:
            j += 1
        t0, t1 = ts[j], ts[min(j + 1, len(ts) - 1)]
        a0, a1 = angles[j], angles[min(j + 1, len(angles) - 1)]
        f = 0.0 if t1 <= t0 else (t - t0) / (t1 - t0)
        f = max(0.0, min(1.0, f))
        out_a.append([a0[k] + (a1[k] - a0[k]) * f for k in range(len(a0))])
    return out_t, out_a


# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("input_csv", help="video_processing .../data/frames.csv")
    ap.add_argument("output_json", help="trajectory.json to upload in the console")
    ap.add_argument("--rate", type=float, default=30.0, help="output sample rate, Hz (default 30)")
    ap.add_argument("--smooth-window", type=int, default=5, help="moving-average window, samples (default 5)")
    ap.add_argument("--hand", choices=["any", "left", "right"], default="any",
                    help="which arm to retarget: 'any' uses video_processing's primary hand each "
                         "frame; 'left'/'right' keeps only frames whose primary hand has that label "
                         "(others are hold-filled). Default any.")
    ap.add_argument("--start-s", type=float, default=None, help="trim: keep only frames at/after this timestamp (s)")
    ap.add_argument("--end-s", type=float, default=None, help="trim: keep only frames at/before this timestamp (s)")
    ap.add_argument("--arm-mode", choices=["workspace", "image", "fixed"], default="workspace",
                    help="how shoulder/elbow are derived (default workspace); see module docstring")
    ap.add_argument("--elbow-sign", choices=["neg", "pos"], default="pos",
                    help="which IK branch / elbow bend direction (default pos)")
    ap.add_argument("--min-span", type=float, default=0.03,
                    help="workspace: min wrist-path span per axis before it drives the arm (default 0.03)")
    ap.add_argument("--reach-x-min", type=float, default=-0.85,
                    help="workspace: target X at nx=0, in reach fractions from origin (default -0.85)")
    ap.add_argument("--reach-x-max", type=float, default=-0.15,
                    help="workspace: target X at nx=1 (default -0.15)")
    ap.add_argument("--reach-y-min", type=float, default=0.15,
                    help="workspace: target height at hand-low (default 0.15)")
    ap.add_argument("--reach-y-max", type=float, default=0.85,
                    help="workspace: target height at hand-high (default 0.85)")
    ap.add_argument("--rest-shoulder-deg", type=float, default=-120.0,
                    help="fixed mode: held shoulder_pitch (default -120)")
    ap.add_argument("--rest-elbow-deg", type=float, default=55.0,
                    help="fixed mode: held elbow_pitch (default 55)")
    ap.add_argument("--gripper-open-deg", type=float, default=10.0,
                    help="gripper angle for a fully open hand (default 10)")
    ap.add_argument("--gripper-closed-deg", type=float, default=80.0,
                    help="gripper angle for a fully closed hand (default 80)")
    ap.add_argument("--base-yaw-gain", type=float, default=0.0,
                    help="deg of base_yaw per full horizontal frame swing (default 0 = placeholder)")
    ap.add_argument("--l1", type=float, default=0.26, help="upper-arm length, height fractions (console: 0.26)")
    ap.add_argument("--l2", type=float, default=0.22, help="forearm length, height fractions (console: 0.22)")
    ap.add_argument("--origin-x", type=float, default=0.32, help="arm origin X, width fractions (console: 0.32)")
    ap.add_argument("--origin-y", type=float, default=0.62, help="arm origin Y, height fractions (console: 0.62)")
    ap.add_argument("--stage-aspect", type=float, default=4.0 / 3.0,
                    help="console source-panel width/height (default 1.333)")
    ap.add_argument("--source-video", default="", help="name to record in the output metadata")
    args = ap.parse_args()

    rows = load_frames_csv(args.input_csv)
    ts, frames, n_kept, n_missing = retarget(rows, args)
    frames = unwrap_angle_channels(frames)  # continuity for smoothing
    frames = smooth(frames, args.smooth_window)
    out_t, out_a = resample(ts, frames, args.rate)
    # fold the "pointing" channels back to (-180, 180] so the console's
    # readout is legible; shoulder/elbow stay continuous and are clamped to
    # the console's own joint limits on load.
    for angs in out_a:
        for c in (0, 3, 4):  # base_yaw, wrist_pitch, wrist_roll
            angs[c] = wrap180(angs[c])

    trajectory = {
        "version": "1.0",
        "source_video": args.source_video or args.input_csv,
        "sample_rate_hz": args.rate,
        "joint_names": JOINT_NAMES,
        "frames": [
            {"t": round(t, 4), "joint_angles_deg": [round(a, 2) for a in angs]}
            for t, angs in zip(out_t, out_a)
        ],
    }

    with open(args.output_json, "w") as f:
        json.dump(trajectory, f, indent=2)

    pct = 100.0 * n_missing / max(n_kept, 1)
    miss_label = "no usable hand" if args.hand == "any" else f"no {args.hand}-hand frame"
    print(f"wrote {len(trajectory['frames'])} frames, {out_t[-1]:.2f}s, to {args.output_json}")
    print(f"  arm: {args.hand}")
    print(f"  input: {n_kept} rows kept, {n_missing} ({pct:.0f}%) with {miss_label} (hold-filled)")
    if args.hand != "any" and pct > 60:
        print(f"  ! only {100 - pct:.0f}% of frames have the {args.hand} hand as the primary lock -- "
              f"the arm will be mostly static. Re-run video_processing with hand selection favouring "
              f"the {args.hand} hand, or use --hand any.")
    print("  channels: gripper=solid  wrist_pitch=approx  shoulder/elbow=inferred (IK)  "
          "base_yaw/wrist_roll=placeholder")


if __name__ == "__main__":
    main()
