"""Two-pass gripper-state pipeline: extract, estimate, write, visualize."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from config import Config
from events import GripperEvent, detect_events
from gripper import GripperMapper, GripperStateMachine
from hand_features import FeatureExtractor
from hand_selection import HandSelector, SelectionResult
from hand_tracking import FrameObservation, HandObservation, HandTracker, MediaPipeHandTracker
from plots import plot_signal
from report import build_summary, write_summary
from smoothing import smooth_series
from video import VideoReader, VideoWriter, VideoInfo
from visualization import SignalStrip, events_for_frame, render_overlay_frame


def maybe_undistort(frame: np.ndarray, enabled: bool) -> np.ndarray:
    """Reserved hook. Fisheye undistortion is intentionally a no-op in this phase."""
    return frame


@dataclass
class FrameRecord:
    frame: int
    timestamp: float
    fps: float
    hand_detected: bool
    hand_label: str | None
    detection_confidence: float
    tracking_confidence: float
    selection_reason: str
    thumb: np.ndarray | None
    index: np.ndarray | None
    wrist: np.ndarray | None
    index_mcp: np.ndarray | None
    middle_mcp: np.ndarray | None
    middle_tip: np.ndarray | None
    other_hand_label: str | None
    other_thumb: np.ndarray | None
    other_index: np.ndarray | None
    other_wrist: np.ndarray | None
    other_detection_confidence: float
    thumb_index_distance: float
    hand_scale: float
    hand_scale_raw: float
    normalized_gripper_distance: float
    primary: HandObservation | None
    others: list[HandObservation]
    smoothed: float = float("nan")
    gripper_value: float = float("nan")
    gripper_state: str = "UNKNOWN"


@dataclass
class PipelineResult:
    info: VideoInfo
    records: list[FrameRecord]
    events: list[GripperEvent]
    frame_table: pd.DataFrame
    event_table: pd.DataFrame
    stages_table: pd.DataFrame
    summary: dict
    output_dir: Path
    closed_threshold: float
    open_threshold: float


def _xyz(point: np.ndarray | None) -> tuple[float, float, float]:
    if point is None or not np.all(np.isfinite(point[: min(3, point.size)])):
        return (float("nan"), float("nan"), float("nan"))
    arr = np.asarray(point, dtype=np.float64)
    z = float(arr[2]) if arr.size > 2 else float("nan")
    return float(arr[0]), float(arr[1]), z


def records_to_frame_table(records: list[FrameRecord]) -> pd.DataFrame:
    rows = []
    for rec in records:
        tx, ty, tz = _xyz(rec.thumb)
        ix, iy, iz = _xyz(rec.index)
        wx, wy, wz = _xyz(rec.wrist)
        imx, imy, imz = _xyz(rec.index_mcp)
        mmx, mmy, mmz = _xyz(rec.middle_mcp)
        mtx, mty, mtz = _xyz(rec.middle_tip)
        otx, oty, otz = _xyz(rec.other_thumb)
        oix, oiy, oiz = _xyz(rec.other_index)
        owx, owy, owz = _xyz(rec.other_wrist)
        rows.append(
            {
                "frame": rec.frame,
                "timestamp": rec.timestamp,
                "fps": rec.fps,
                "hand_detected": rec.hand_detected,
                "hand_label": rec.hand_label,
                "detection_confidence": rec.detection_confidence,
                "tracking_confidence": rec.tracking_confidence,
                "selection_reason": rec.selection_reason,
                "thumb_x": tx,
                "thumb_y": ty,
                "thumb_z": tz,
                "index_x": ix,
                "index_y": iy,
                "index_z": iz,
                "wrist_x": wx,
                "wrist_y": wy,
                "wrist_z": wz,
                "index_mcp_x": imx,
                "index_mcp_y": imy,
                "index_mcp_z": imz,
                "middle_mcp_x": mmx,
                "middle_mcp_y": mmy,
                "middle_mcp_z": mmz,
                "middle_tip_x": mtx,
                "middle_tip_y": mty,
                "middle_tip_z": mtz,
                "other_hand_label": rec.other_hand_label,
                "other_thumb_x": otx,
                "other_thumb_y": oty,
                "other_thumb_z": otz,
                "other_index_x": oix,
                "other_index_y": oiy,
                "other_index_z": oiz,
                "other_wrist_x": owx,
                "other_wrist_y": owy,
                "other_wrist_z": owz,
                "other_detection_confidence": rec.other_detection_confidence,
                "thumb_index_distance": rec.thumb_index_distance,
                "hand_scale": rec.hand_scale,
                "hand_scale_raw": rec.hand_scale_raw,
                "normalized_gripper_distance": rec.normalized_gripper_distance,
                "smoothed_normalized_distance": rec.smoothed,
                "gripper_value": rec.gripper_value,
                "gripper_state": rec.gripper_state,
            }
        )
    return pd.DataFrame(rows)


def _empty_record(frame: int, timestamp: float, fps: float, reason: str) -> FrameRecord:
    return FrameRecord(
        frame=frame,
        timestamp=timestamp,
        fps=fps,
        hand_detected=False,
        hand_label=None,
        detection_confidence=float("nan"),
        tracking_confidence=float("nan"),
        selection_reason=reason,
        thumb=None,
        index=None,
        wrist=None,
        index_mcp=None,
        middle_mcp=None,
        middle_tip=None,
        other_hand_label=None,
        other_thumb=None,
        other_index=None,
        other_wrist=None,
        other_detection_confidence=float("nan"),
        thumb_index_distance=float("nan"),
        hand_scale=float("nan"),
        hand_scale_raw=float("nan"),
        normalized_gripper_distance=float("nan"),
        primary=None,
        others=[],
    )


def _record_from_selection(
    frame: int,
    timestamp: float,
    fps: float,
    selection: SelectionResult,
    extractor: FeatureExtractor,
) -> FrameRecord:
    if selection.primary is None:
        return _empty_record(frame, timestamp, fps, selection.reason)
    features = extractor.extract(selection.primary)
    if features is None:
        return _empty_record(frame, timestamp, fps, selection.reason)
    other = selection.others[0] if selection.others else None
    raw = selection.primary.landmarks
    other_pts = other.landmarks if other is not None else None
    return FrameRecord(
        frame=frame,
        timestamp=timestamp,
        fps=fps,
        hand_detected=True,
        hand_label=selection.primary.label,
        detection_confidence=selection.primary.detection_confidence,
        tracking_confidence=selection.primary.tracking_confidence,
        selection_reason=selection.reason,
        thumb=raw[4],
        index=raw[8],
        wrist=raw[0],
        index_mcp=raw[5],
        middle_mcp=raw[9],
        middle_tip=raw[12],
        other_hand_label=other.label if other else None,
        other_thumb=other_pts[4] if other_pts is not None else None,
        other_index=other_pts[8] if other_pts is not None else None,
        other_wrist=other_pts[0] if other_pts is not None else None,
        other_detection_confidence=other.detection_confidence if other else float("nan"),
        thumb_index_distance=features.thumb_index_distance,
        hand_scale=features.hand_scale,
        hand_scale_raw=features.hand_scale_raw,
        normalized_gripper_distance=features.normalized_gripper_distance,
        primary=selection.primary,
        others=list(selection.others),
    )


def _print_progress(frame: int, timestamp: float, detected: int, total: int, t0: float) -> None:
    rate = 100.0 * detected / max(total, 1)
    elapsed = time.time() - t0
    fps_proc = total / max(elapsed, 1e-6)
    print(
        f"  t={timestamp:7.2f}s  frame={frame:6d}  detected={rate:5.1f}%  "
        f"proc={fps_proc:5.1f} fps",
        flush=True,
    )


def extract_records(
    reader: VideoReader,
    tracker: HandTracker,
    selector: HandSelector,
    extractor: FeatureExtractor,
    undistort: bool,
) -> list[FrameRecord]:
    records: list[FrameRecord] = []
    detected = 0
    t0 = time.time()
    last_print = -1.0
    info = reader.info
    print(f"Pass 1: tracking {info.path.name} ({info.frame_count} frames, {info.fps:.2f} fps)")
    for frame_index, timestamp_s, bgr in reader.frames():
        bgr = maybe_undistort(bgr, undistort)
        observation = tracker.process(bgr, frame_index, timestamp_s)
        selection = selector.select(observation)
        record = _record_from_selection(frame_index, timestamp_s, info.fps, selection, extractor)
        records.append(record)
        if record.hand_detected:
            detected += 1
        if timestamp_s - last_print >= 1.0 or last_print < 0:
            _print_progress(frame_index, timestamp_s, detected, len(records), t0)
            last_print = timestamp_s
    print(f"Pass 1 done: {len(records)} frames, {100.0 * detected / max(len(records), 1):.1f}% detected")
    return records


def estimate_signal(records: list[FrameRecord], config: Config) -> tuple[list[GripperEvent], float, float]:
    raw = [r.normalized_gripper_distance for r in records]
    if config.video.streaming:
        config.smoothing.method = "ema"
        mapper = GripperMapper(config.gripper)
        mapper.closed_threshold = config.gripper.closed_threshold
        mapper.open_threshold = config.gripper.open_threshold
        machine = GripperStateMachine(config.gripper)
        smoothed = []
        from smoothing import ema_filter, median_filter

        pre = median_filter(raw, config.smoothing.median_window)
        sm = ema_filter(pre, config.smoothing.ema_alpha, config.smoothing.reset_gap_frames)
        for rec, value in zip(records, sm):
            rec.smoothed = float(value)
            rec.gripper_value = mapper.value(rec.smoothed)
            rec.gripper_state = machine.step(rec.gripper_value)
            smoothed.append(rec.smoothed)
        closed_t, open_t = mapper.closed_threshold, mapper.open_threshold
    else:
        smoothed = smooth_series(raw, config.smoothing)
        mapper = GripperMapper(config.gripper)
        calib = mapper.calibrate(smoothed)
        closed_t, open_t = calib.closed_threshold, calib.open_threshold
        if calib.auto:
            print(f"Auto-calibrated thresholds: closed={closed_t:.3f}  open={open_t:.3f}")
        machine = GripperStateMachine(config.gripper)
        values = mapper.map_series(smoothed)
        states = machine.apply(values)
        for rec, sm, val, state in zip(records, smoothed, values, states):
            rec.smoothed = float(sm)
            rec.gripper_value = float(val)
            rec.gripper_state = state

    events = detect_events(
        [r.gripper_state for r in records],
        [r.timestamp for r in records],
        [r.frame for r in records],
        [r.gripper_value for r in records],
        [r.detection_confidence for r in records],
        min_hold_frames=config.events.min_hold_frames,
        min_event_separation_s=config.events.min_event_separation_s,
    )
    return events, closed_t, open_t


def write_tables(
    result_dir: Path,
    frame_table: pd.DataFrame,
    events: list[GripperEvent],
    write_parquet: bool,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    data_dir = result_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    frame_table.to_csv(data_dir / "frames.csv", index=False)
    event_table = pd.DataFrame(
        [{"event": e.event, "frame": e.frame, "timestamp": e.timestamp, "confidence": e.confidence} for e in events]
    )
    event_table.to_csv(data_dir / "events.csv", index=False)
    stages = frame_table[
        [
            "frame",
            "timestamp",
            "thumb_index_distance",
            "hand_scale",
            "normalized_gripper_distance",
            "smoothed_normalized_distance",
            "gripper_value",
            "gripper_state",
        ]
    ].copy()
    stages.to_csv(data_dir / "stages.csv", index=False)
    if write_parquet:
        frame_table.to_parquet(data_dir / "frames.parquet", index=False)
    return event_table, stages


def render_overlay(
    reader: VideoReader,
    records: list[FrameRecord],
    events: list[GripperEvent],
    config: Config,
    dest: Path,
) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    by_frame = {r.frame: r for r in records}
    strip = SignalStrip(config.visualization.plot_window_s, reader.info.fps)
    size = (reader.info.out_width, reader.info.out_height)
    print(f"Pass 2: writing overlay {dest}")
    with VideoWriter(dest, reader.info.fps / max(reader.stride, 1), size) as writer:
        for frame_index, timestamp_s, bgr in reader.frames():
            bgr = maybe_undistort(bgr, config.video.undistort)
            rec = by_frame.get(frame_index)
            if rec is None:
                writer.write(bgr)
                continue
            names = events_for_frame(events, rec.frame)
            overlay = render_overlay_frame(
                bgr,
                primary=rec.primary,
                others=rec.others,
                hand_label=rec.hand_label or "NONE",
                gripper_value=rec.gripper_value,
                state=rec.gripper_state,
                normalized=rec.smoothed if np.isfinite(rec.smoothed) else rec.normalized_gripper_distance,
                events=names,
                strip=strip,
                config=config.visualization,
            )
            writer.write(overlay)
    return dest


def run_pipeline(
    input_path: str | Path,
    output_dir: str | Path,
    config: Config,
    tracker: HandTracker | None = None,
    video_name: str | None = None,
) -> PipelineResult:
    input_path = Path(input_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    reader = VideoReader(
        input_path,
        resize_width=config.video.resize_width,
        stride=config.video.stride,
        max_frames=config.video.max_frames,
    )
    owns_tracker = tracker is None
    if tracker is None:
        tracker = MediaPipeHandTracker(config.tracking, config.resolve_model_path())
    selector = HandSelector(config.selection)
    extractor = FeatureExtractor(config.features, aspect=reader.info.aspect)
    try:
        records = extract_records(reader, tracker, selector, extractor, config.video.undistort)
    finally:
        if owns_tracker:
            tracker.close()

    events, closed_t, open_t = estimate_signal(records, config)
    frame_table = records_to_frame_table(records)
    event_table, stages = write_tables(output_dir, frame_table, events, config.output.write_parquet)

    name = video_name or input_path.name
    summary = build_summary(
        video_name=name,
        duration_s=reader.info.duration_s,
        fps=reader.info.fps,
        frames=len(records),
        frame_table=frame_table,
        events=events,
        quality=config.quality,
    )
    write_summary(summary, output_dir / "summary.json", output_dir / "summary.txt")
    print(summary_line(summary))

    if config.output.write_plot:
        plot_signal(
            output_dir / "plots" / "signal.png",
            timestamps=frame_table["timestamp"],
            raw_normalized=frame_table["normalized_gripper_distance"],
            smoothed=frame_table["smoothed_normalized_distance"],
            gripper_values=frame_table["gripper_value"],
            states=frame_table["gripper_state"],
            events=events,
            closed_threshold=closed_t,
            open_threshold=open_t,
        )

    if config.output.write_video:
        overlay_reader = VideoReader(
            input_path,
            resize_width=config.video.resize_width,
            stride=config.video.stride,
            max_frames=config.video.max_frames,
        )
        render_overlay(
            overlay_reader,
            records,
            events,
            config,
            output_dir / "videos" / "overlay.mp4",
        )

    return PipelineResult(
        info=reader.info,
        records=records,
        events=events,
        frame_table=frame_table,
        event_table=event_table,
        stages_table=stages,
        summary=summary,
        output_dir=output_dir,
        closed_threshold=closed_t,
        open_threshold=open_t,
    )


def summary_line(summary: dict) -> str:
    flags = ",".join(summary["quality_flags"]) if summary["quality_flags"] else "ok"
    return (
        f"Summary: det={100.0 * summary['hand_detection_rate']:.1f}%  "
        f"grasps={summary['grasp_events']} releases={summary['release_events']}  "
        f"OPEN={summary['pct_open']:.0f}% CLOSED={summary['pct_closed']:.0f}%  "
        f"UNKNOWN={summary['pct_unknown']:.0f}%  flags={flags}"
    )
