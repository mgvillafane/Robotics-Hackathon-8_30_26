from __future__ import annotations

from pathlib import Path

import pytest

from config import Config, load_config
from dataset import find_dataset_root, resolve_clip


def test_default_config_loads() -> None:
    cfg = load_config()
    assert isinstance(cfg, Config)
    assert cfg.gripper.open_threshold > cfg.gripper.closed_threshold
    assert cfg.tracking.num_hands == 2


def test_resolve_preview_clip() -> None:
    try:
        root = find_dataset_root()
    except FileNotFoundError:
        pytest.skip("World Context package not available")
    clip = resolve_clip(clip_id="clip_3ehh7nbm5rnhw", preview=True, dataset_root=root)
    assert clip.is_preview
    assert clip.path.exists()
    assert clip.task_id == "garment-folding-general"
