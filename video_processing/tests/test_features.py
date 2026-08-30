from __future__ import annotations

import numpy as np
import pytest

from hand_features import (
    aspect_corrected_points,
    compute_hand_scale,
    euclidean,
    normalized_gripper_distance,
    thumb_index_distance,
)
from tests.helpers import make_hand, make_landmarks


def test_euclidean_3d() -> None:
    a = np.array([0.0, 0.0, 0.0])
    b = np.array([3.0, 4.0, 0.0])
    assert euclidean(a, b) == pytest.approx(5.0)


def test_aspect_correction_makes_horizontal_and_vertical_equal() -> None:
    aspect = 16 / 9
    horizontal = np.array([[0.0, 0.0, 0.0], [0.1, 0.0, 0.0]])
    vertical = np.array([[0.0, 0.0, 0.0], [0.0, 0.1, 0.0]])
    raw_h = euclidean(horizontal[0], horizontal[1])
    raw_v = euclidean(vertical[0], vertical[1])
    assert raw_h == pytest.approx(raw_v)

    h = aspect_corrected_points(horizontal, aspect)
    v = aspect_corrected_points(vertical, aspect)
    assert euclidean(h[0], h[1]) == pytest.approx(0.1 * aspect)
    assert euclidean(v[0], v[1]) == pytest.approx(0.1)
    assert euclidean(h[0], h[1]) != pytest.approx(euclidean(v[0], v[1]))


def test_thumb_index_distance() -> None:
    pts = make_landmarks(thumb_tip=(0.0, 0.0, 0.0), index_tip=(0.3, 0.4, 0.0))
    assert thumb_index_distance(pts) == pytest.approx(0.5)


def test_hand_scale_modes() -> None:
    pts = make_landmarks(
        wrist=(0.0, 0.0, 0.0),
        middle_mcp=(0.0, 0.2, 0.0),
        index_mcp=(0.1, 0.2, 0.0),
        pinky_mcp=(-0.1, 0.2, 0.0),
    )
    assert compute_hand_scale(pts, "wrist_middle_mcp", 1e-6) == pytest.approx(0.2)
    assert compute_hand_scale(pts, "palm_width", 1e-6) == pytest.approx(0.2)
    bone = compute_hand_scale(pts, "bone_median", 1e-6)
    assert np.isfinite(bone)
    assert bone > 0


def test_degenerate_scale_is_nan() -> None:
    pts = np.zeros((21, 3))
    assert np.isnan(compute_hand_scale(pts, "wrist_middle_mcp", 1e-4))


def test_normalized_distance() -> None:
    assert normalized_gripper_distance(0.2, 0.4) == pytest.approx(0.5)
    assert np.isnan(normalized_gripper_distance(0.2, float("nan")))
    assert np.isnan(normalized_gripper_distance(0.2, 0.0))


def test_feature_extractor_missing_hand() -> None:
    from config import FeaturesConfig
    from hand_features import FeatureExtractor

    ext = FeatureExtractor(FeaturesConfig(), aspect=16 / 9)
    assert ext.extract(None) is None
    feats = ext.extract(make_hand())
    assert feats is not None
    assert np.isfinite(feats.normalized_gripper_distance)
