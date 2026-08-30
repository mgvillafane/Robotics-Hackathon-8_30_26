from __future__ import annotations

import numpy as np

import pytest

from config import GripperConfig
from gripper import GripperMapper, GripperStateMachine, map_gripper_value


def test_map_clamps_and_interpolates() -> None:
    assert map_gripper_value(0.10, 0.30, 0.90) == 0.0
    assert map_gripper_value(0.90, 0.30, 0.90) == 1.0
    assert map_gripper_value(0.60, 0.30, 0.90) == pytest.approx(0.5)
    assert np.isnan(map_gripper_value(float("nan"), 0.3, 0.9))


def test_zero_span_threshold() -> None:
    assert map_gripper_value(0.1, 0.5, 0.5) == 0.0
    assert map_gripper_value(0.7, 0.5, 0.5) == 1.0


def test_auto_calibrate_uses_percentiles() -> None:
    cfg = GripperConfig(auto_calibrate=True, auto_p_low=0.0, auto_p_high=100.0)
    mapper = GripperMapper(cfg)
    calib = mapper.calibrate(np.linspace(0.2, 1.0, 50))
    assert calib.auto
    assert calib.closed_threshold == 0.2
    assert calib.open_threshold == 1.0
    assert mapper.value(0.2) == 0.0
    assert mapper.value(1.0) == 1.0


def test_hysteresis_holds_through_noise() -> None:
    cfg = GripperConfig(
        enter_closed=0.25,
        exit_closed=0.40,
        enter_open=0.75,
        exit_open=0.60,
        min_state_frames=3,
        max_missing_frames=8,
        closing_velocity=-0.5,
        opening_velocity=0.5,
    )
    machine = GripperStateMachine(cfg)
    open_seq = [0.9] * 6
    noisy = [0.9, 0.55, 0.9, 0.58, 0.9, 0.9, 0.9]
    states = machine.apply(open_seq + noisy)
    assert states[5] == "OPEN"
    assert all(s == "OPEN" for s in states[-3:])


def test_open_to_closed_goes_through_closing() -> None:
    cfg = GripperConfig(min_state_frames=2, max_missing_frames=20)
    machine = GripperStateMachine(cfg)
    values = [0.95] * 4 + [0.55] * 4 + [0.10] * 6
    states = machine.apply(values)
    assert "OPEN" in states
    assert "CLOSING" in states
    assert states[-1] == "CLOSED"


def test_closed_to_open_goes_through_opening() -> None:
    cfg = GripperConfig(min_state_frames=2, max_missing_frames=20)
    machine = GripperStateMachine(cfg)
    values = [0.95] * 3 + [0.10] * 5 + [0.50] * 4 + [0.95] * 5
    states = machine.apply(values)
    assert "CLOSED" in states
    assert "OPENING" in states
    assert states[-1] == "OPEN"


def test_missing_observations_become_unknown() -> None:
    cfg = GripperConfig(min_state_frames=1, max_missing_frames=2)
    machine = GripperStateMachine(cfg)
    values = [0.9, 0.9, float("nan"), float("nan"), float("nan"), 0.9]
    states = machine.apply(values)
    assert "UNKNOWN" in states
