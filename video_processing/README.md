# Gripper-state extraction

Turn a video of a person doing a manual task into a time-synchronized estimate of how open their hand is.

```
VIDEO
  → MediaPipe hand landmarks
  → thumb–index geometry
  → scale-normalized opening
  → smoothed gripper value (0 closed … 1 open)
  → OPEN / CLOSING / CLOSED / OPENING / UNKNOWN
  → GRASP_START / GRASP_HOLD / GRASP_RELEASE
```

This phase stops there. It does not estimate robot joints, run inverse kinematics, or talk to a simulator.

## Install

Python 3.12 and [uv](https://docs.astral.sh/uv/) are required.

```bash
cd video_processing
uv venv --python 3.12
source .venv/bin/activate
uv pip install -r requirements.txt
python scripts/fetch_model.py
```

`scripts/fetch_model.py` downloads MediaPipe's `hand_landmarker.task` into `models/`. MediaPipe 1.0 no longer ships `solutions.hands`, so this file is required.

## Run one video

World Context clip (8 s preview of `garment-folding-general`):

```bash
python scripts/process_video.py \
  --clip-id clip_3ehh7nbm5rnhw \
  --preview \
  --output-dir outputs/clip_3ehh7nbm5rnhw
```

Any other file:

```bash
python scripts/process_video.py \
  --input /path/to/video.mp4 \
  --output-dir outputs/my_video
```

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--full` | Use the 5-minute 1080p World Context clip instead of the preview |
| `--resize-width 720` | Downscale before tracking (recommended for full clips) |
| `--open-threshold` / `--closed-threshold` | Override gripper mapping |
| `--no-auto-calibrate` | Disable per-video percentile calibration |
| `--smoothing ema\|savgol\|median` | Smoothing method |
| `--ema-alpha 0.3` | EMA blend (higher = less lag, more noise) |
| `--min-detection-confidence` / `--min-tracking-confidence` | MediaPipe gates |
| `--max-frames N` | Process only the first N emitted frames |
| `--no-video` | Skip the overlay MP4 |

Dataset discovery: `--dataset-root`, else `WORLD_CONTEXT_ROOT`, else the default World Context path on this machine.

## Batch a task

```bash
python scripts/process_batch.py \
  --task garment-folding-general \
  --preview \
  --output-dir outputs/garment-folding-general \
  --limit 2
```

Full 1080p clips should pass `--resize-width 720` so iteration stays interactive.

## Outputs

`outputs/<name>/`

- `data/frames.csv` and `data/frames.parquet` — one row per video frame, including missed detections as `hand_detected=false` and NaN landmarks
- `data/events.csv` — `GRASP_START`, `GRASP_HOLD`, `GRASP_RELEASE`
- `data/stages.csv` — raw distance → normalized → smoothed → value → state
- `plots/signal.png` — standalone inspection figure
- `videos/overlay.mp4` — skeleton, HUD, gripper bar, live signal strip
- `summary.txt` / `summary.json` — detection rate, event counts, state occupancy, quality flags

## Configuration

All thresholds live in [`configs/default.yaml`](configs/default.yaml). Pass `--config other.yaml` to overlay a file; CLI flags win last.

Hand scale defaults to `distance(wrist, middle_MCP)` with a 21-frame rolling median. Instantaneous palm length is unstable in this head-mounted fisheye footage (strong foreshortening as the palm rotates). Distances use aspect-corrected MediaPipe coordinates so a horizontal pinch and a vertical pinch measure the same. `palm_width` and `bone_median` are available in config if that scale starts to wobble.

On the first vertical slice (`ui-previews/garment-folding-general/clip_3ehh7nbm5rnhw.mp4`) the primary-hand lock held, detection on the locked hand was ~81%, and auto-calibration landed near `closed=0.24`, `open=0.81`. Full 1080p clips should pass `--resize-width 720` so tracking stays near 15–20 fps on CPU.

## Tests

```bash
pytest
```

## Layout

```
src/           tracking, features, smoothing, gripper, events, viz, pipeline
scripts/       process_video.py, process_batch.py, fetch_model.py
configs/       default.yaml
tests/         unit + a tiny generated-video integration test
```
