#!/usr/bin/env python3
"""
mediapipe_to_trajectory.py

Converts MediaPipe Pose output into the trajectory.json schema the Retarget
Console expects (Load trajectory (.json) button). This is "Retargeting v1"
from the plan: simple geometric IK from landmark positions, not a learned
model -- a starting point to iterate on once you know your arm's real joint
semantics and limits.

------------------------------------------------------------------------
STEP 1 -- get your MediaPipe output into one simple intermediate format
------------------------------------------------------------------------
This script reads a JSONL file (one JSON object per line), one line per
sampled video frame:

    {"t": 0.000, "landmarks": [{"x":0.51,"y":0.38,"z":-0.12,"visibility":0.99}, ... 33 total]}
    {"t": 0.033, "landmarks": [...]}
    ...

`landmarks` is the standard 33-point MediaPipe Pose list, in MediaPipe's
own index order, with x/y normalized to [0,1] against the frame (MediaPipe's
own convention) and z roughly in "hip-depth" units. `visibility` is optional.

If you're running MediaPipe Tasks (PoseLandmarker) in Python, producing this
file is a handful of lines, e.g.:

    import json, cv2
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision

    options = vision.PoseLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path="pose_landmarker.task"),
        running_mode=vision.RunningMode.VIDEO,
    )
    landmarker = vision.PoseLandmarker.create_from_options(options)

    cap = cv2.VideoCapture("packaging_line.mp4")
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_i = 0
    with open("landmarks.jsonl", "w") as out:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            t_ms = int(frame_i * 1000 / fps)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame)
            result = landmarker.detect_for_video(mp_image, t_ms)
            if result.pose_landmarks:
                lm = result.pose_landmarks[0]
                out.write(json.dumps({
                    "t": frame_i / fps,
                    "landmarks": [{"x": p.x, "y": p.y, "z": p.z,
                                    "visibility": getattr(p, "visibility", 1.0)} for p in lm],
                }) + "\n")
            frame_i += 1

If you're already further along than this (e.g. you have MediaPipe Holistic
output, or your own saved landmark arrays), just write a short adapter that
emits the same JSONL shape -- that's the only contract this script needs.

------------------------------------------------------------------------
STEP 2 -- run this script
------------------------------------------------------------------------
    python3 mediapipe_to_trajectory.py landmarks.jsonl trajectory.json --side right

------------------------------------------------------------------------
STEP 3 -- upload trajectory.json in the console
------------------------------------------------------------------------
"Load trajectory (.json)" button, left panel. The console will drive the
skeleton overlay and the simulation directly from it.

------------------------------------------------------------------------
What's solid here vs. what's a placeholder
------------------------------------------------------------------------
shoulder_pitch, elbow_pitch  -- direct geometric angles from the shoulder/
                                 elbow/wrist landmarks. Reasonable starting
                                 values.
wrist_pitch                  -- geometric, from wrist -> index-finger
                                 landmark. Noisier than the two above
                                 (that landmark is small and easily
                                 occluded) -- expect to smooth or discard it
                                 depending on your footage.
base_yaw                     -- APPROXIMATION. Derived from shoulder-line
                                 rotation in the image plane, which only
                                 loosely maps to your arm's actual base
                                 rotation. This is exactly the "human and
                                 robot don't share a coordinate frame" risk
                                 called out in the plan -- needs a real
                                 calibration pass once you're working
                                 against the physical mount.
wrist_roll                   -- PLACEHOLDER (constant 0). Not observable
                                 from body-pose landmarks alone; needs hand
                                 landmarks (MediaPipe Hands / Holistic) if
                                 you want this to be real.
gripper                      -- PLACEHOLDER, driven by wrist-to-index
                                 landmark distance as a rough open/closed
                                 proxy. Replace with a real signal (hand
                                 landmarks, or task-specific logic) once
                                 available.

All angles are smoothed (simple moving average) and resampled to a fixed
rate so every downstream consumer gets uniform timing, per the plan's
"mismatched frame rates" risk.
"""

import json
import sys
import math
import argparse

# MediaPipe Pose landmark indices (BlazePose 33-point topology)
LM = {
    "left_shoulder": 11, "right_shoulder": 12,
    "left_elbow": 13, "right_elbow": 14,
    "left_wrist": 15, "right_wrist": 16,
    "left_index": 19, "right_index": 20,
    "left_hip": 23, "right_hip": 24,
}

JOINT_NAMES = ["base_yaw", "shoulder_pitch", "elbow_pitch", "wrist_pitch", "wrist_roll", "gripper"]


def load_jsonl(path):
    frames = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            frames.append(json.loads(line))
    return frames


def deg(rad):
    return rad * 180.0 / math.pi


def angle_deg(p_from, p_to):
    """Angle in degrees of the vector p_from -> p_to, image-plane convention
    (x right, y down) -- matches the console's own forward-kinematics."""
    return deg(math.atan2(p_to["y"] - p_from["y"], p_to["x"] - p_from["x"]))


def dist(a, b):
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def retarget_frame(landmarks, side="right"):
    sh = landmarks[LM[f"{side}_shoulder"]]
    el = landmarks[LM[f"{side}_elbow"]]
    wr = landmarks[LM[f"{side}_wrist"]]
    idx = landmarks[LM[f"{side}_index"]]
    hip = landmarks[LM[f"{side}_hip"]]
    other_sh = landmarks[LM["left_shoulder" if side == "right" else "right_shoulder"]]

    a1 = angle_deg(sh, el)                 # shoulder_pitch, absolute
    a2 = angle_deg(el, wr)                 # absolute angle of forearm
    a3 = angle_deg(wr, idx)                # absolute angle of hand

    shoulder_pitch = a1
    elbow_pitch = a2 - a1                  # relative bend at elbow
    wrist_pitch = a3 - a2                  # relative bend at wrist

    # APPROXIMATION: shoulder-line rotation as a stand-in for base yaw.
    # Needs real calibration against the arm's physical mount -- see plan §5 (risks).
    base_yaw = deg(math.atan2(sh["y"] - other_sh["y"], sh["x"] - other_sh["x"])) * 0.4

    # PLACEHOLDER: not observable without hand landmarks.
    wrist_roll = 0.0

    # PLACEHOLDER proxy: wrist-to-index distance as an open/close signal,
    # normalized against shoulder-to-hip length so it's roughly scale-invariant.
    scale = max(dist(sh, hip), 1e-4)
    reach = dist(wr, idx) / scale
    gripper = max(0.0, min(90.0, 90.0 - reach * 300.0))

    return [base_yaw, shoulder_pitch, elbow_pitch, wrist_pitch, wrist_roll, gripper]


def smooth(series, window=5):
    """Simple centered moving average per channel."""
    n = len(series)
    if n == 0:
        return series
    n_channels = len(series[0])
    out = []
    half = window // 2
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        acc = [0.0] * n_channels
        for j in range(lo, hi):
            for c in range(n_channels):
                acc[c] += series[j][c]
        cnt = hi - lo
        out.append([v / cnt for v in acc])
    return out


def resample(frames_t, frames_angles, rate_hz):
    if not frames_t:
        return [], []
    duration = frames_t[-1]
    n_out = max(2, int(duration * rate_hz) + 1)
    out_t = [i / rate_hz for i in range(n_out)]
    out_angles = []
    j = 0
    for t in out_t:
        while j < len(frames_t) - 2 and frames_t[j + 1] < t:
            j += 1
        t0, t1 = frames_t[j], frames_t[min(j + 1, len(frames_t) - 1)]
        a0, a1 = frames_angles[j], frames_angles[min(j + 1, len(frames_angles) - 1)]
        f = 0.0 if t1 <= t0 else (t - t0) / (t1 - t0)
        f = max(0.0, min(1.0, f))
        out_angles.append([a0[k] + (a1[k] - a0[k]) * f for k in range(len(a0))])
    return out_t, out_angles


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input_jsonl", help="landmarks.jsonl -- see the module docstring for the shape")
    ap.add_argument("output_json", help="trajectory.json -- upload this in the console")
    ap.add_argument("--side", choices=["left", "right"], default="right", help="which arm to retarget (default: right)")
    ap.add_argument("--rate", type=float, default=30.0, help="output sample rate in Hz (default: 30)")
    ap.add_argument("--smooth-window", type=int, default=5, help="moving-average window in samples (default: 5)")
    ap.add_argument("--source-video", default="", help="optional: name of the source mp4, for the output file's metadata")
    args = ap.parse_args()

    raw = load_jsonl(args.input_jsonl)
    if not raw:
        print("no frames found in", args.input_jsonl, file=sys.stderr)
        sys.exit(1)

    ts = [f["t"] for f in raw]
    angles = [retarget_frame(f["landmarks"], side=args.side) for f in raw]
    angles = smooth(angles, window=args.smooth_window)
    out_t, out_angles = resample(ts, angles, args.rate)

    trajectory = {
        "version": "1.0",
        "source_video": args.source_video or args.input_jsonl,
        "sample_rate_hz": args.rate,
        "joint_names": JOINT_NAMES,
        "frames": [
            {"t": round(t, 4), "joint_angles_deg": [round(a, 2) for a in angs]}
            for t, angs in zip(out_t, out_angles)
        ],
    }

    with open(args.output_json, "w") as f:
        json.dump(trajectory, f, indent=2)

    print(f"wrote {len(trajectory['frames'])} frames, {out_t[-1]:.2f}s, to {args.output_json}")
    print("reminder: base_yaw, wrist_roll and gripper are approximations/placeholders -- see the module docstring")


if __name__ == "__main__":
    main()
