"""Choose a temporally consistent primary hand from detections."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from config import SelectionConfig
from hand_tracking import FrameObservation, HandObservation, WRIST


@dataclass
class SelectionResult:
    primary: HandObservation | None
    others: list[HandObservation]
    reason: str
    locked_label: str | None


class HandSelector:
    """Lock onto a handedness; switch only after a sustained challenge or a long gap."""

    def __init__(self, config: SelectionConfig) -> None:
        self.config = config
        self.locked_label: str | None = None
        self._last_wrist: np.ndarray | None = None
        self._challenge_label: str | None = None
        self._challenge_count = 0
        self._missing = 0

    def reset(self) -> None:
        self.locked_label = None
        self._last_wrist = None
        self._challenge_label = None
        self._challenge_count = 0
        self._missing = 0

    def select(self, observation: FrameObservation) -> SelectionResult:
        hands = list(observation.hands)
        if not hands:
            return self._note_absent([], "missing")

        if self.locked_label is None:
            chosen = self._pick_initial(hands)
            self.locked_label = chosen.label
            self._last_wrist = chosen.point(WRIST)[:2].copy()
            self._missing = 0
            others = [h for h in hands if h is not chosen]
            return SelectionResult(chosen, others, "initial", self.locked_label)

        locked = [h for h in hands if h.label == self.locked_label]
        others = [h for h in hands if h.label != self.locked_label]
        if locked:
            self._missing = 0
            primary = self._best(locked)
            challenger = self._best(others) if others else None
            if challenger is not None and self._should_switch(primary, challenger):
                self._note_challenge(challenger.label)
                if self._challenge_count >= self.config.switch_patience:
                    self.locked_label = challenger.label
                    self._challenge_label = None
                    self._challenge_count = 0
                    self._last_wrist = challenger.point(WRIST)[:2].copy()
                    remaining = [h for h in hands if h is not challenger]
                    return SelectionResult(challenger, remaining, "switched", self.locked_label)
            else:
                self._challenge_label = None
                self._challenge_count = 0
            self._last_wrist = primary.point(WRIST)[:2].copy()
            return SelectionResult(primary, others, "locked", self.locked_label)

        # Locked handedness is gone. Hold the lock through a short gap so the
        # other visible hand cannot steal the primary stream.
        return self._note_absent(others, "locked_absent")

    def _note_absent(self, others: list[HandObservation], reason: str) -> SelectionResult:
        self._missing += 1
        if self._missing > self.config.max_gap_frames:
            if others:
                fallback = self._closest_wrist(others) or self._best(others)
                self.locked_label = fallback.label
                self._last_wrist = fallback.point(WRIST)[:2].copy()
                self._challenge_label = None
                self._challenge_count = 0
                self._missing = 0
                remaining = [h for h in others if h is not fallback]
                return SelectionResult(fallback, remaining, "relock", self.locked_label)
            self.locked_label = None
            self._last_wrist = None
            self._challenge_label = None
            self._challenge_count = 0
        return SelectionResult(None, list(others), reason, self.locked_label)

    def _pick_initial(self, hands: list[HandObservation]) -> HandObservation:
        return self._best(hands)

    def _best(self, hands: list[HandObservation]) -> HandObservation:
        return max(hands, key=lambda h: (h.tracking_confidence, h.detection_confidence, h.handedness_score))

    def _should_switch(self, locked: HandObservation, challenger: HandObservation) -> bool:
        return challenger.tracking_confidence >= locked.tracking_confidence + self.config.switch_margin

    def _note_challenge(self, label: str) -> None:
        if self._challenge_label == label:
            self._challenge_count += 1
        else:
            self._challenge_label = label
            self._challenge_count = 1

    def _closest_wrist(self, hands: list[HandObservation]) -> HandObservation | None:
        if self._last_wrist is None:
            return None
        best = None
        best_dist = float("inf")
        for hand in hands:
            wrist = hand.point(WRIST)[:2]
            dist = float(np.linalg.norm(wrist - self._last_wrist))
            if dist < best_dist:
                best_dist = dist
                best = hand
        return best
