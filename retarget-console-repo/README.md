# Retarget Console

A browser-based orchestrator for the video &rarr; MediaPipe &rarr; simulation
pipeline: play a packaging-line clip with a synced skeleton overlay, drive a
robot arm rig over `postMessage`, and tune scenario parameters (joint
limits, speed, base mounting offset, payload weight) live against the
result. See [`plan.html`](./plan.html) for the full architecture and the
formulas behind the parameter sandbox.

## Files

- `index.html` &mdash; the console itself. No build step.
- `serve.py` &mdash; Flask server: static UI, clip catalog, and MediaPipe
  processing. **This is the supported way to run the console.**
- `plan.html` &mdash; the written architecture plan (system diagram, data
  contracts, roadmap, risks).
- `videos/processed/` &mdash; drop `.mp4` clips here; they appear in the
  SOURCE panel dropdown.
- `mediapipe_to_trajectory.py` &mdash; converts MediaPipe Pose landmark
  output into the `trajectory.json` format the console loads. Run
  `python3 mediapipe_to_trajectory.py --help` for usage.

## Running it locally

Gallery playback (pick clips, play in source):

```bash
cd retarget-console-repo
python3 -m http.server 8000
# open http://localhost:8000/
```

MediaPipe processing and the live clip catalog need Flask:

```bash
cd retarget-console-repo
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python serve.py
# open http://localhost:8000/
```

`serve.py` refreshes `videos/processed/manifest.json` on startup so the
gallery also works under plain `http.server` when that file is present.

Processed clips are often OpenCV **mpeg4** exports, which browsers cannot
play. Transcode once to H.264:

```bash
cd retarget-console-repo
.venv/bin/python transcode_web_videos.py   # writes videos/processed/_web/*.mp4
```

With `serve.py`, the first play of each clip auto-transcodes if `_web/` is
missing.

## Using processed clips

1. Put `.mp4` files in `videos/processed/` (already-curated clips live
   there). They show up in the **video gallery** on the next page load.
2. Click a gallery tile to play that clip in **01 · source** (left panel).
   Matching **02 · simulation** recordings (same number prefix in
   `videos/simulation/`) play in sync on the right.
3. Optionally set a start/end window and click **Run MediaPipe** to track
   the hand and build a trajectory (no file upload).
4. **Load trajectory (.json)** is still available if you already have a
   matching trajectory file from an offline run.

## Offline trajectory workflow (optional)

1. Run your MediaPipe pipeline over a video, then convert its output with
   `mediapipe_to_trajectory.py` (see the script's docstring for the expected
   input format and a ready-to-adapt MediaPipe snippet).
2. In the console, use **Load trajectory (.json)** to load the result.
3. Click the matching clip in the **video gallery** to play it in source.
4. In the simulation panel, point **Load sim** at your own WebGL simulation's
   URL once it implements the `postMessage` contract shown in the "what your
   sim needs to add" panel.

## Publishing it as a live page (optional)

Because the console UI is a single self-contained `index.html` with no build
step, GitHub Pages can serve the static page as-is. Clip listing and
MediaPipe processing still need `serve.py` (or an equivalent backend).

1. On GitHub: **Settings &rarr; Pages &rarr; Source: Deploy from a branch**,
   branch `main`, folder `/ (root)`.
2. Save. GitHub gives you a URL at `https://<username>.github.io/<repo>/`
   within a minute or two.
