#!/usr/bin/env python3
"""
serve.py -- the Retarget Console with a video-processing backend.

Serves index.html AND exposes endpoints that list clips from videos/processed/
and run the ../video_processing MediaPipe pipeline on a selected clip, then
turn its output into a console trajectory (+ overlay video + windowed
perception-signal figure).

    python serve.py                # http://localhost:8000/
    python serve.py --port 9000

GET /api/videos
    { ok, videos: [{ name, url, bytes }] }  -- *.mp4 under videos/processed/

Pipeline (POST /api/process, form fields):
    video_name       filename in videos/processed/             (required)
    start_s, end_s   trim the clip to this window first        (optional)
    hand             any | left | right  -> frames_csv_to_trajectory
    resize_width     downscale before tracking (blank/0 = native, best detection)
    stride           process every Nth frame (default 1; 2 = ~2x faster, coarser)

Response JSON: { ok, trajectory: {...}, overlay_url, summary }
The trajectory already has the signal figure embedded (signal_png / signal_x),
so the console shows it with no extra request.

Runs video_processing in ITS OWN venv (../video_processing/.venv); this
server only needs Flask. First process downloads the hand-landmarker model if
missing.
"""

import argparse
import base64
import json
import os
import re
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
VIDEOS_PROCESSED = os.path.join(HERE, "videos", "processed")
VIDEOS_WEB = os.path.join(VIDEOS_PROCESSED, "_web")
VIDEOS_SIMULATION = os.path.join(HERE, "videos", "simulation")
SIM_DIST = os.path.normpath(os.path.join(HERE, "..", "simulations", "dist"))

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


def _safe_video_name(name):
    """Resolve a basename under videos/processed/. None if missing or unsafe."""
    name = os.path.basename(name or "")
    if not name.lower().endswith(".mp4"):
        return None
    root = os.path.realpath(VIDEOS_PROCESSED)
    full = os.path.realpath(os.path.join(root, name))
    if os.path.commonpath([full, root]) != root:
        return None
    if not os.path.isfile(full):
        return None
    return full


def _transcode_to_web(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    _run([_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
          "-i", src, "-c:v", "libx264", "-preset", "veryfast",
          "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
          "-an", dst], timeout=3600)


def _web_video_path(name):
    src = _safe_video_name(name)
    if src is None:
        return None
    os.makedirs(VIDEOS_WEB, exist_ok=True)
    dst = os.path.join(VIDEOS_WEB, name)
    if os.path.isfile(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
        return dst
    print(f"transcoding for browser playback: {name}", flush=True)
    _transcode_to_web(src, dst)
    return dst


def _clip_number_prefix(name):
    m = re.match(r"^(\d+)_", name or "")
    return m.group(1) if m else None


def _safe_simulation_name(name):
    name = os.path.basename(name or "")
    if not name.lower().endswith(".mp4"):
        return None
    root = os.path.realpath(VIDEOS_SIMULATION)
    full = os.path.realpath(os.path.join(root, name))
    if os.path.commonpath([full, root]) != root:
        return None
    if not os.path.isfile(full):
        return None
    return full


def _find_simulation_video(processed_name):
    prefix = _clip_number_prefix(processed_name)
    if prefix is None or not os.path.isdir(VIDEOS_SIMULATION):
        return None
    matches = []
    for fname in sorted(os.listdir(VIDEOS_SIMULATION)):
        if fname.lower().endswith(".mp4") and fname.startswith(prefix + "_"):
            matches.append(fname)
    return matches[0] if matches else None


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


# ---------------------------------------------------------------- video library
def _list_processed_videos():
    videos = []
    if not os.path.isdir(VIDEOS_PROCESSED):
        return videos
    for fname in sorted(os.listdir(VIDEOS_PROCESSED)):
        if not fname.lower().endswith(".mp4"):
            continue
        if fname.startswith("."):
            continue
        path = os.path.join(VIDEOS_PROCESSED, fname)
        if not os.path.isfile(path):
            continue
        web_path = os.path.join(VIDEOS_WEB, fname)
        sim_name = _find_simulation_video(fname)
        entry = {
            "name": fname,
            "url": f"/videos/processed/_web/{fname}",
            "bytes": os.path.getsize(path),
            "web_ready": os.path.isfile(web_path)
            and os.path.getmtime(web_path) >= os.path.getmtime(path),
        }
        if sim_name:
            entry["simulation_name"] = sim_name
            entry["simulation_url"] = f"/videos/simulation/{sim_name}"
        videos.append(entry)
    return videos


def _write_manifest():
    """Static fallback for python -m http.server (no /api/videos)."""
    os.makedirs(VIDEOS_PROCESSED, exist_ok=True)
    manifest = os.path.join(VIDEOS_PROCESSED, "manifest.json")
    with open(manifest, "w", encoding="utf-8") as f:
        json.dump({"ok": True, "videos": _list_processed_videos()}, f, indent=2)
        f.write("\n")


@app.get("/api/videos")
def list_videos():
    return jsonify(ok=True, videos=_list_processed_videos())


@app.get("/videos/simulation/<name>")
def simulation_video(name):
    path = _safe_simulation_name(name)
    if path is None:
        return ("not found", 404)
    return send_file(path, mimetype="video/mp4", conditional=True)


@app.get("/videos/processed/_web/<name>")
def processed_video_web(name):
    try:
        path = _web_video_path(name)
    except subprocess.CalledProcessError as e:
        return jsonify(ok=False, error="transcode failed", stderr=(e.stderr or "")[-500:]), 500
    except subprocess.TimeoutExpired:
        return jsonify(ok=False, error="transcode timed out"), 504
    if path is None:
        return ("not found", 404)
    return send_file(path, mimetype="video/mp4", conditional=True)


@app.get("/videos/processed/<name>")
def processed_video(name):
    path = _safe_video_name(name)
    if path is None:
        return ("not found", 404)
    return send_file(path, mimetype="video/mp4", conditional=True)


# ---------------------------------------------------------------- processing
@app.post("/api/process")
def process():
    src = _safe_video_name((request.form.get("video_name") or "").strip())
    if src is None:
        return jsonify(ok=False, error="unknown or missing video_name"), 400

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
            import plot_window  # noqa: WPS433  (needs matplotlib + pandas)
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
    os.makedirs(VIDEOS_PROCESSED, exist_ok=True)
    _write_manifest()
    if not os.path.isfile(VENV_PY):
        print(f"!! video_processing venv not found at {VENV_PY}", file=sys.stderr)
        print("   set it up:  cd ../video_processing && uv venv --python 3.12 && "
              "uv pip install -r requirements.txt", file=sys.stderr)
    n_videos = len(_list_processed_videos())
    if n_videos == 0:
        print(f"!! no .mp4 files in {VIDEOS_PROCESSED}", file=sys.stderr)
        print("   drop processed clips there and they will appear in the console", file=sys.stderr)
    else:
        print(f"   {n_videos} clip(s) in videos/processed/", flush=True)
    print(f"Retarget Console  ->  http://{args.host}:{args.port}/")
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
