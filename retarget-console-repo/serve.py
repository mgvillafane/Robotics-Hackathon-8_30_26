#!/usr/bin/env python3
"""
serve.py -- the Retarget Console with a video-processing backend.

Serves index.html (like `python -m http.server` did) AND exposes an endpoint
that runs the ../video_processing MediaPipe pipeline on an uploaded video,
then turns its output into a console trajectory (+ overlay video + windowed
perception-signal figure). The browser uploads a raw clip and gets back
everything the SOURCE panel needs.

    python serve.py                # http://localhost:8000/
    python serve.py --port 9000

Pipeline per upload (POST /api/process, multipart form):
    video            the clip                                  (required)
    start_s, end_s   trim the clip to this window first        (optional)
    hand             any | left | right  -> frames_csv_to_trajectory
    resize_width     downscale before tracking (blank/0 = native, best detection)
    stride           process every Nth frame (default 1; 2 = ~2x faster, coarser)

Response JSON: { ok, trajectory: {...}, overlay_url, summary }
The trajectory already has the signal figure embedded (signal_png / signal_x),
so the console shows it with no extra request.

Runs video_processing in ITS OWN venv (../video_processing/.venv); this
server only needs Flask. First upload downloads the hand-landmarker model if
missing.
"""

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid

from flask import Flask, jsonify, request, send_file, send_from_directory

HERE = os.path.dirname(os.path.abspath(__file__))
VP = os.path.normpath(os.path.join(HERE, "..", "video_processing"))
VENV_PY = os.path.join(VP, ".venv", "Scripts", "python.exe")
if not os.path.isfile(VENV_PY):  # non-Windows layout
    VENV_PY = os.path.join(VP, ".venv", "bin", "python")
ADAPTER = os.path.join(HERE, "frames_csv_to_trajectory.py")
JOBS = os.path.join(HERE, "jobs")
SIM_DIST = os.path.normpath(os.path.join(HERE, "..", "simulations", "dist"))

sys.path.insert(0, HERE)
import plot_window  # noqa: E402  (global python has matplotlib + pandas)

app = Flask(__name__, static_folder=None)
_pipeline_lock = threading.Lock()  # MediaPipe is heavy; one job at a time


def _ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def _run(cmd, **kw):
    print("$", " ".join(str(c) for c in cmd), flush=True)
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


# ---------------------------------------------------------------- static site
@app.get("/")
def index():
    return send_from_directory(HERE, "index.html")


@app.get("/<path:fname>")
def static_file(fname):
    # only serve files that actually sit next to this script
    full = os.path.normpath(os.path.join(HERE, fname))
    if not full.startswith(HERE) or not os.path.isfile(full):
        return ("not found", 404)
    return send_from_directory(HERE, fname)


# ---------------------------------------------------------------- Arm Simulator
# The ../simulations app, built (npm run build) to dist/, mounted at /sim/.
# vite base is './', so its own assets resolve under /sim/; the URDF + meshes it
# fetches from /robots/... are absolute, so they get their own route below.
_SIM_MISSING = (
    "Arm Simulator not built.\n"
    "  cd ../simulations && npm install && npm run build\n"
    "then restart this server.", 503,
)


def _send_from_dist(sub):
    full = os.path.normpath(os.path.join(SIM_DIST, sub))
    if not full.startswith(SIM_DIST) or not os.path.isfile(full):
        return None
    return send_from_directory(SIM_DIST, sub, conditional=True)


@app.get("/sim/")
@app.get("/sim/<path:sub>")
def sim_app(sub="index.html"):
    if not os.path.isdir(SIM_DIST):
        return _SIM_MISSING
    hit = _send_from_dist(sub)
    if hit is not None:
        return hit
    # SPA fallback
    return _send_from_dist("index.html") or _SIM_MISSING


@app.get("/robots/<path:sub>")
def sim_robot_assets(sub):
    # URDF + STL meshes the Arm Simulator loads by absolute path.
    hit = _send_from_dist(os.path.join("robots", sub))
    return hit if hit is not None else ("not found", 404)


@app.get("/sim-status")
def sim_status():
    return jsonify(built=os.path.isfile(os.path.join(SIM_DIST, "index.html")))


# ---------------------------------------------------------------- processing
@app.post("/api/process")
def process():
    if "video" not in request.files or request.files["video"].filename == "":
        return jsonify(ok=False, error="no video file in request"), 400

    def fnum(key):
        v = (request.form.get(key) or "").strip()
        try:
            return float(v) if v != "" else None
        except ValueError:
            return None

    start_s = fnum("start_s")
    end_s = fnum("end_s")
    hand = (request.form.get("hand") or "any").strip().lower()
    if hand not in ("any", "left", "right"):
        hand = "any"
    # 0 / blank = native resolution (what video_processing's own default does,
    # and what gives the best hand detection). Only downscale if asked.
    try:
        resize_width = int(request.form.get("resize_width") or 0)
    except ValueError:
        resize_width = 0
    try:
        stride = max(1, int(request.form.get("stride") or 1))
    except ValueError:
        stride = 1

    job = uuid.uuid4().hex[:12]
    jdir = os.path.join(JOBS, job)
    os.makedirs(jdir, exist_ok=True)
    src = os.path.join(jdir, "input.mp4")
    request.files["video"].save(src)

    t0 = time.time()
    if not _pipeline_lock.acquire(timeout=1):
        return jsonify(ok=False, error="another video is still processing; try again in a bit"), 429
    try:
        # 1) optional trim so the pipeline only sees the window
        proc_in = src
        if start_s is not None or end_s is not None:
            a = start_s or 0.0
            proc_in = os.path.join(jdir, "input_win.mp4")
            cmd = [_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-ss", f"{a:.3f}"]
            if end_s is not None:
                cmd += ["-t", f"{max(0.1, end_s - a):.3f}"]
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-an", proc_in]
            _run(cmd)

        # 2) video_processing (its own venv)
        out = os.path.join(jdir, "out")
        pv = [VENV_PY, os.path.join(VP, "scripts", "process_video.py"),
              "--input", proc_in, "--output-dir", out,
              "--stride", str(stride), "--no-plot"]
        if resize_width > 0:
            pv += ["--resize-width", str(resize_width)]
        _run(pv, cwd=VP, timeout=1800)

        frames_csv = os.path.join(out, "data", "frames.csv")
        events_csv = os.path.join(out, "data", "events.csv")
        overlay = os.path.join(out, "videos", "overlay.mp4")
        if not os.path.isfile(frames_csv):
            return jsonify(ok=False, error="pipeline produced no frames.csv", log=_tail(out)), 500

        # video_processing writes overlay.mp4 with OpenCV's default mp4v codec,
        # which no browser can decode. Transcode to H.264 for the <video> tag.
        overlay_web = os.path.join(out, "videos", "overlay_web.mp4")
        if os.path.isfile(overlay):
            try:
                _run([_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
                      "-i", overlay, "-c:v", "libx264", "-preset", "veryfast",
                      "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                      "-an", overlay_web], timeout=300)
            except Exception as e:
                print("overlay transcode failed:", e, flush=True)

        # 3) frames.csv -> console trajectory
        traj_path = os.path.join(jdir, "trajectory.json")
        _run([sys.executable, ADAPTER, frames_csv, traj_path, "--hand", hand])
        traj = json.load(open(traj_path))

        # 4) windowed perception figure, embedded
        try:
            png = os.path.join(jdir, "signal.png")
            plot_window.render(frames_csv, png,
                               events_csv=events_csv if os.path.isfile(events_csv) else None)
            with open(png, "rb") as f:
                traj["signal_png"] = "data:image/png;base64," + base64.b64encode(f.read()).decode("ascii")
            traj["signal_x"] = [plot_window.PLOT_MARGINS["left"], plot_window.PLOT_MARGINS["right"]]
        except Exception as e:  # a figure is nice-to-have, not essential
            print("plot_window failed:", e, flush=True)

        summary = {}
        sp = os.path.join(out, "summary.json")
        if os.path.isfile(sp):
            s = json.load(open(sp))
            summary = {
                "detection_rate": s.get("hand_detection_rate"),
                "grasp_events": s.get("grasp_events"),
                "release_events": s.get("release_events"),
                "duration_s": s.get("duration_s"),
                "frames": s.get("frames"),
                "flags": s.get("quality_flags", []),
            }
        summary["elapsed_s"] = round(time.time() - t0, 1)

        have_overlay = os.path.isfile(overlay_web) or os.path.isfile(overlay)
        return jsonify(
            ok=True,
            trajectory=traj,
            overlay_url=f"/api/job/{job}/overlay.mp4" if have_overlay else None,
            summary=summary,
        )
    except subprocess.CalledProcessError as e:
        return jsonify(ok=False, error="pipeline step failed",
                       cmd=e.cmd if isinstance(e.cmd, str) else " ".join(map(str, e.cmd)),
                       stderr=(e.stderr or "")[-3000:]), 500
    except subprocess.TimeoutExpired:
        return jsonify(ok=False, error="processing timed out -- try a shorter window or a bigger --stride"), 504
    finally:
        _pipeline_lock.release()


def _tail(out_dir):
    st = os.path.join(out_dir, "summary.txt")
    return open(st).read()[-1500:] if os.path.isfile(st) else ""


@app.get("/api/job/<job>/overlay.mp4")
def job_overlay(job):
    if not job.isalnum():
        return ("bad job id", 400)
    vdir = os.path.join(JOBS, job, "out", "videos")
    p = os.path.join(vdir, "overlay_web.mp4")  # H.264, browser-playable
    if not os.path.isfile(p):
        p = os.path.join(vdir, "overlay.mp4")  # fallback (mp4v; may not decode)
    if not os.path.isfile(p):
        return ("not found", 404)
    return send_file(p, mimetype="video/mp4", conditional=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    os.makedirs(JOBS, exist_ok=True)
    if not os.path.isfile(VENV_PY):
        print(f"!! video_processing venv not found at {VENV_PY}", file=sys.stderr)
        print("   set it up:  cd ../video_processing && uv venv --python 3.12 && "
              "uv pip install -r requirements.txt", file=sys.stderr)
    print(f"Retarget Console  ->  http://{args.host}:{args.port}/")
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
