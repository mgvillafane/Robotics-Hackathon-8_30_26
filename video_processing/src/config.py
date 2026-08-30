"""Nested configuration loaded from YAML and overridable from the CLI."""

from __future__ import annotations

from dataclasses import asdict, dataclass, fields, is_dataclass
from pathlib import Path
from typing import Any

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "configs" / "default.yaml"


def _from_mapping(cls: type, data: dict[str, Any] | None) -> Any:
    if not is_dataclass(cls):
        raise TypeError(f"{cls} is not a dataclass")
    data = data or {}
    values: dict[str, Any] = {}
    for field in fields(cls):
        if field.name not in data:
            continue
        value = data[field.name]
        if is_dataclass(field.type) and isinstance(value, dict):
            values[field.name] = _from_mapping(field.type, value)
        else:
            values[field.name] = value
    return cls(**values)


@dataclass
class VideoConfig:
    resize_width: int | None = None
    stride: int = 1
    max_frames: int | None = None
    streaming: bool = False
    undistort: bool = False


@dataclass
class TrackingConfig:
    model_path: str = "models/hand_landmarker.task"
    num_hands: int = 2
    min_detection_confidence: float = 0.5
    min_tracking_confidence: float = 0.5
    min_presence_confidence: float = 0.5


@dataclass
class SelectionConfig:
    switch_margin: float = 0.15
    switch_patience: int = 8
    max_gap_frames: int = 15


@dataclass
class FeaturesConfig:
    source: str = "normalized_2d"
    scale_mode: str = "wrist_middle_mcp"
    scale_median_window: int = 21
    min_scale: float = 1e-4


@dataclass
class SmoothingConfig:
    method: str = "ema"
    ema_alpha: float = 0.3
    median_window: int = 5
    savgol_window: int = 9
    savgol_polyorder: int = 2
    reset_gap_frames: int = 8


@dataclass
class GripperConfig:
    closed_threshold: float = 0.35
    open_threshold: float = 0.90
    auto_calibrate: bool = True
    auto_p_low: float = 10.0
    auto_p_high: float = 90.0
    enter_closed: float = 0.25
    exit_closed: float = 0.40
    enter_open: float = 0.75
    exit_open: float = 0.60
    min_state_frames: int = 4
    max_missing_frames: int = 8
    velocity_window: int = 5
    closing_velocity: float = -0.02
    opening_velocity: float = 0.02


@dataclass
class EventsConfig:
    min_hold_frames: int = 6
    min_event_separation_s: float = 0.25


@dataclass
class VisualizationConfig:
    plot_window_s: float = 4.0
    hud_scale: float = 1.0


@dataclass
class OutputConfig:
    write_parquet: bool = True
    write_video: bool = True
    write_plot: bool = True


@dataclass
class QualityConfig:
    min_detection_rate: float = 0.4
    max_switch_rate: float = 0.15
    min_signal_range: float = 0.05


@dataclass
class DatasetConfig:
    root: str | None = None


@dataclass
class Config:
    video: VideoConfig
    tracking: TrackingConfig
    selection: SelectionConfig
    features: FeaturesConfig
    smoothing: SmoothingConfig
    gripper: GripperConfig
    events: EventsConfig
    visualization: VisualizationConfig
    output: OutputConfig
    quality: QualityConfig
    dataset: DatasetConfig

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None = None) -> Config:
        data = data or {}
        return cls(
            video=_from_mapping(VideoConfig, data.get("video")),
            tracking=_from_mapping(TrackingConfig, data.get("tracking")),
            selection=_from_mapping(SelectionConfig, data.get("selection")),
            features=_from_mapping(FeaturesConfig, data.get("features")),
            smoothing=_from_mapping(SmoothingConfig, data.get("smoothing")),
            gripper=_from_mapping(GripperConfig, data.get("gripper")),
            events=_from_mapping(EventsConfig, data.get("events")),
            visualization=_from_mapping(VisualizationConfig, data.get("visualization")),
            output=_from_mapping(OutputConfig, data.get("output")),
            quality=_from_mapping(QualityConfig, data.get("quality")),
            dataset=_from_mapping(DatasetConfig, data.get("dataset")),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def resolve_model_path(self, project_root: Path | None = None) -> Path:
        root = project_root or PROJECT_ROOT
        path = Path(self.tracking.model_path)
        if not path.is_absolute():
            path = root / path
        return path


def load_config(path: str | Path | None = None) -> Config:
    """Load defaults, then overlay an optional YAML file."""
    merged: dict[str, Any] = {}
    if DEFAULT_CONFIG_PATH.exists():
        merged = yaml.safe_load(DEFAULT_CONFIG_PATH.read_text()) or {}
    if path is not None:
        overlay = yaml.safe_load(Path(path).read_text()) or {}
        merged = _deep_merge(merged, overlay)
    return Config.from_dict(merged)


def _deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out
