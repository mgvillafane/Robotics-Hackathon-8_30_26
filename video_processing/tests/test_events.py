from __future__ import annotations

from events import detect_events


def _run(states: list[str], fps: float = 30.0, hold: int = 3, sep: float = 0.0):
    frames = list(range(len(states)))
    timestamps = [i / fps for i in frames]
    values = []
    for s in states:
        values.append({"OPEN": 0.9, "CLOSING": 0.5, "CLOSED": 0.1, "OPENING": 0.5, "UNKNOWN": float("nan")}[s])
    conf = [0.9] * len(states)
    return detect_events(
        states,
        timestamps,
        frames,
        values,
        conf,
        min_hold_frames=hold,
        min_event_separation_s=sep,
    )


def test_grasp_and_release_cycle() -> None:
    states = (
        ["OPEN"] * 4
        + ["CLOSING"] * 3
        + ["CLOSED"] * 8
        + ["OPENING"] * 3
        + ["OPEN"] * 4
    )
    events = _run(states, hold=4)
    names = [e.event for e in events]
    assert names.count("GRASP_START") == 1
    assert names.count("GRASP_HOLD") == 1
    assert names.count("GRASP_RELEASE") == 1
    by_name = {e.event: e for e in events}
    assert by_name["GRASP_START"].frame < by_name["GRASP_HOLD"].frame
    assert by_name["GRASP_HOLD"].frame < by_name["GRASP_RELEASE"].frame


def test_debounce_short_separation() -> None:
    states = (
        ["OPEN"] * 2
        + ["CLOSING"] * 2
        + ["CLOSED"] * 5
        + ["OPENING"] * 2
        + ["OPEN"] * 2
        + ["CLOSING"] * 2
        + ["CLOSED"] * 5
        + ["OPENING"] * 2
        + ["OPEN"] * 2
    )
    events = _run(states, fps=10.0, hold=3, sep=10.0)
    assert sum(e.event == "GRASP_START" for e in events) == 1


def test_unknown_does_not_emit() -> None:
    events = _run(["UNKNOWN"] * 10 + ["OPEN"] * 5)
    assert events == []
