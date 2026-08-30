#!/usr/bin/env python3
"""
make_clip.py

One command -> a matched set for the Retarget Console's SOURCE panel, all cut
to the SAME real-time window:

  * <name>.json        - trajectory, built by frames_csv_to_trajectory.py,
                         with the perception figure embedded as a data: URI
  * <name>.mp4         - the overlay video, cut to the window
  * <name>.signal.png  - the MediaPipe gripper-analysis figure for the window
                         (also embedded in the JSON; kept as a file too)

Load the .mp4 first ("Load video (.mp4)") then the .json ("Load trajectory
(.json)"). The console follows video.currentTime and samples the trajectory
at `t % traj.duration`, so the two only stay in sync if they cover the same
window -- which is exactly what this script guarantees: the video is cut to
start at --start-s and to run for the trajectory's own resampled duration,
so they can't drift. Loading the JSON also fills the console's "perception
signal" panel with the figure and a playhead that tracks the clock.

------------------------------------------------------------------------
USAGE
------------------------------------------------------------------------
    python make_clip.py \
        ../mediapipe_clip_wvfbz4si644dk/frames.csv \
        ~/Downloads/overlay.mp4 \
        ../mediapipe_clip_wvfbz4si644dk/clips \
        --start-s 10 --end-s 40 --name pick_demo

Any extra flags are forwarded verbatim to frames_csv_to_trajectory.py, e.g.:

    python make_clip.py frames.csv overlay.mp4 out --start-s 10 --end-s 40 \
        --arm-mode fixed --gripper-closed-deg 85

ffmpeg: uses the system `ffmpeg` if on PATH, else the one bundled with the
`imageio-ffmpeg` pip package.
"""

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTER = os.path.join(HERE, "frames_csv_to_trajectory.py")


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        raise SystemExit(
            "no ffmpeg found. Install one:  pip install imageio-ffmpeg   "
            "(or put ffmpeg on PATH)"
        )


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("frames_csv", help="video_processing .../data/frames.csv")
    ap.add_argument("overlay_mp4", help="the matching overlay.mp4 (same timeline as frames.csv)")
    ap.add_argument("out_dir", help="directory for <name>.json and <name>.mp4")
    ap.add_argument("--name", default="clip", help="basename for the output pair (default: clip)")
    ap.add_argument("--start-s", type=float, default=0.0, help="window start in the video's own seconds (default 0)")
    ap.add_argument("--end-s", type=float, default=None, help="window end (default: end of data)")
    ap.add_argument("--crf", type=int, default=20, help="x264 quality, lower = better (default 20)")
    ap.add_argument("--keep-audio", action="store_true", help="keep the audio track (default: drop it)")
    ap.add_argument("--no-plot", action="store_true",
                    help="skip the MediaPipe 'perception signal' figure (otherwise it is rendered "
                         "for this window and embedded in the JSON so the console shows it)")
    args, passthrough = ap.parse_known_args()

    for p in (args.frames_csv, args.overlay_mp4):
        if not os.path.isfile(p):
            raise SystemExit(f"not found: {p}")
    os.makedirs(args.out_dir, exist_ok=True)
    json_path = os.path.join(args.out_dir, args.name + ".json")
    mp4_path = os.path.join(args.out_dir, args.name + ".mp4")

    # 1) build the trajectory for this window
    adapter_cmd = [
        sys.executable, ADAPTER, args.frames_csv, json_path,
        "--start-s", repr(args.start_s),
    ]
    if args.end_s is not None:
        adapter_cmd += ["--end-s", repr(args.end_s)]
    adapter_cmd += passthrough
    print("$", " ".join(adapter_cmd))
    subprocess.run(adapter_cmd, check=True)

    # 2) read back the trajectory's real resampled duration
    traj = json.load(open(json_path))
    if not traj.get("frames"):
        raise SystemExit("adapter produced no frames")
    duration = float(traj["frames"][-1]["t"])

    # 3) cut the video to [start-s, start-s + duration] so it matches exactly
    ffmpeg = find_ffmpeg()
    ff_cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-i", args.overlay_mp4,
        "-ss", f"{args.start_s:.3f}", "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", str(args.crf),
        "-pix_fmt", "yuv420p",
    ]
    ff_cmd += ["-an"] if not args.keep_audio else ["-c:a", "aac"]
    ff_cmd += [mp4_path]
    print("$", " ".join(ff_cmd))
    subprocess.run(ff_cmd, check=True)

    # 4) render the MediaPipe "perception signal" figure for this window and
    #    embed it (as a data: URI) in the JSON so the console shows it aligned.
    png_path = os.path.join(args.out_dir, args.name + ".signal.png")
    if not args.no_plot:
        try:
            import plot_window
        except Exception as e:
            print(f"  (skipping plot: {e})")
        else:
            events_csv = os.path.join(os.path.dirname(os.path.abspath(args.frames_csv)), "events.csv")
            plot_window.render(
                args.frames_csv, png_path,
                start_s=args.start_s, end_s=args.start_s + duration,
                events_csv=events_csv if os.path.isfile(events_csv) else None,
            )
            with open(png_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("ascii")
            traj["signal_png"] = "data:image/png;base64," + b64
            traj["signal_x"] = [plot_window.PLOT_MARGINS["left"], plot_window.PLOT_MARGINS["right"]]
            with open(json_path, "w") as f:
                json.dump(traj, f)  # compact: the data URI makes indent wasteful
            print(f"  signal   -> {png_path}  (embedded in JSON)")

    print()
    print(f"  window   : {args.start_s:.2f}s .. {args.start_s + duration:.2f}s of {os.path.basename(args.overlay_mp4)}")
    print(f"  duration : {duration:.2f}s  ({len(traj['frames'])} trajectory frames)")
    print(f"  video    -> {mp4_path}")
    print(f"  traj     -> {json_path}")
    print("  in the console: Load video (.mp4) first, then Load trajectory (.json).")


if __name__ == "__main__":
    main()
