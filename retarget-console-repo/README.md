# Retarget Console

A browser-based orchestrator for the video &rarr; MediaPipe &rarr; simulation
pipeline: play a packaging-line clip with a synced skeleton overlay, drive a
robot arm rig over `postMessage`, and tune scenario parameters (joint
limits, speed, base mounting offset, payload weight) live against the
result. See [`plan.html`](./plan.html) for the full architecture and the
formulas behind the parameter sandbox.

## Files

- `index.html` &mdash; the console itself. Open it directly in a browser, no
  build step, no dependencies.
- `plan.html` &mdash; the written architecture plan (system diagram, data
  contracts, roadmap, risks).
- `mediapipe_to_trajectory.py` &mdash; converts MediaPipe Pose landmark
  output into the `trajectory.json` format the console loads. Run
  `python3 mediapipe_to_trajectory.py --help` for usage.

## Running it locally

```bash
python3 -m http.server 8000
# open http://localhost:8000/
```

Serving it (rather than opening the file directly) matters once you connect
a WebSocket relay or an external simulation URL &mdash; see the notes inside
the console's Arm Relay and Simulation panels.

## Using your own data

1. Run your MediaPipe pipeline over a video, then convert its output with
   `mediapipe_to_trajectory.py` (see the script's docstring for the expected
   input format and a ready-to-adapt MediaPipe snippet).
2. In the console, use **Load trajectory (.json)** to load the result.
3. Use **Load video (.mp4)** to overlay the skeleton on the actual footage.
4. In the simulation panel, point **Load sim** at your own WebGL simulation's
   URL once it implements the `postMessage` contract shown in the "what your
   sim needs to add" panel.

## Publishing it as a live page (optional)

Because the console is a single self-contained `index.html` with no build
step, GitHub Pages can serve it as-is:

1. On GitHub: **Settings &rarr; Pages &rarr; Source: Deploy from a branch**,
   branch `main`, folder `/ (root)`.
2. Save. GitHub gives you a URL at `https://<username>.github.io/<repo>/`
   within a minute or two.
