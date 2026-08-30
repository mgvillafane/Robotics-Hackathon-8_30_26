from __future__ import annotations

from config import SelectionConfig
from hand_selection import HandSelector
from tests.helpers import make_hand, make_obs


def test_locks_highest_confidence_initially() -> None:
    selector = HandSelector(SelectionConfig())
    left = make_hand("LEFT", 0.6)
    right = make_hand("RIGHT", 0.95)
    result = selector.select(make_obs(0, left, right))
    assert result.primary is not None
    assert result.primary.label == "RIGHT"
    assert selector.locked_label == "RIGHT"


def test_does_not_switch_on_one_frame_flip() -> None:
    cfg = SelectionConfig(switch_margin=0.1, switch_patience=5, max_gap_frames=10)
    selector = HandSelector(cfg)
    selector.select(make_obs(0, make_hand("RIGHT", 0.9), make_hand("LEFT", 0.4)))
    for i in range(1, 4):
        result = selector.select(make_obs(i, make_hand("RIGHT", 0.5), make_hand("LEFT", 0.95)))
        assert result.primary is not None
        assert result.primary.label == "RIGHT"
        assert result.reason == "locked"


def test_switches_after_sustained_challenge() -> None:
    cfg = SelectionConfig(switch_margin=0.1, switch_patience=3, max_gap_frames=10)
    selector = HandSelector(cfg)
    selector.select(make_obs(0, make_hand("RIGHT", 0.9)))
    reasons = []
    last = None
    for i in range(1, 6):
        last = selector.select(make_obs(i, make_hand("RIGHT", 0.4), make_hand("LEFT", 0.95)))
        reasons.append(last.reason)
    assert last is not None
    assert last.primary is not None
    assert last.primary.label == "LEFT"
    assert "switched" in reasons


def test_other_hand_does_not_steal_during_short_gap() -> None:
    cfg = SelectionConfig(max_gap_frames=5, switch_patience=8)
    selector = HandSelector(cfg)
    selector.select(make_obs(0, make_hand("RIGHT", 0.9), make_hand("LEFT", 0.8)))
    for i in range(1, 5):
        result = selector.select(make_obs(i, make_hand("LEFT", 0.95)))
        assert result.primary is None
        assert result.reason == "locked_absent"
        assert selector.locked_label == "RIGHT"
    result = selector.select(make_obs(5, make_hand("RIGHT", 0.85), make_hand("LEFT", 0.7)))
    assert result.primary is not None
    assert result.primary.label == "RIGHT"


def test_missing_frames_do_not_drop_lock_immediately() -> None:
    cfg = SelectionConfig(max_gap_frames=5)
    selector = HandSelector(cfg)
    selector.select(make_obs(0, make_hand("RIGHT", 0.9)))
    for i in range(1, 4):
        result = selector.select(make_obs(i))
        assert result.primary is None
        assert selector.locked_label == "RIGHT"
    result = selector.select(make_obs(4, make_hand("RIGHT", 0.8), make_hand("LEFT", 0.7)))
    assert result.primary is not None
    assert result.primary.label == "RIGHT"
