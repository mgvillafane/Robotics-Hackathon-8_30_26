#!/usr/bin/env python3
"""Stream synthetic joint states to the arm simulator.

Uses only the standard library, so there is nothing to install. Start the
bridge first (``npm run bridge``), then run this script and point the app at
``ws://localhost:8765``.

    python examples/python/send_joint_states.py --rate 50

Pass ``--unit deg`` to send degrees instead of radians; the simulator converts
using the limits it read from the URDF.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.request

JOINT_NAMES = (
    "shoulder_pan",
    "shoulder_lift",
    "elbow_flex",
    "wrist_flex",
    "wrist_roll",
    "gripper",
)


def pose_at(t: float) -> dict[str, float]:
    """A looping demo motion, in radians. Mirrors server/trajectory.mjs."""
    return {
        "shoulder_pan": 0.85 * math.sin(0.45 * t),
        "shoulder_lift": -0.45 + 0.5 * math.sin(0.7 * t),
        "elbow_flex": 0.75 * math.sin(0.6 * t + 1.0),
        "wrist_flex": 0.55 * math.sin(0.9 * t + 0.4),
        "wrist_roll": 1.15 * math.sin(0.35 * t),
        "gripper": 0.55 + 0.5 * math.sin(1.4 * t),
    }


def send(url: str, frame: dict) -> None:
    request = urllib.request.Request(
        url,
        data=json.dumps(frame).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(request, timeout=1.0).close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--url",
        default="http://localhost:8765/joint_states",
        help="Bridge ingest endpoint.",
    )
    parser.add_argument("--rate", type=float, default=50.0, help="Frames per second.")
    parser.add_argument(
        "--unit",
        choices=("rad", "deg"),
        default="rad",
        help="Unit to send positions in.",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=0.0,
        help="Seconds to run for. 0 means run until interrupted.",
    )
    args = parser.parse_args()

    period = 1.0 / args.rate
    started = time.monotonic()
    sent = 0

    print(f"Publishing to {args.url} at {args.rate:g} Hz in {args.unit}. Ctrl+C to stop.")

    try:
        while True:
            now = time.monotonic()
            elapsed = now - started
            if args.duration and elapsed >= args.duration:
                break

            positions = pose_at(elapsed)
            if args.unit == "deg":
                positions = {name: math.degrees(v) for name, v in positions.items()}

            try:
                send(
                    args.url,
                    {
                        "robot": "so101",
                        "unit": args.unit,
                        "timestamp": time.time(),
                        "positions": positions,
                    },
                )
            except urllib.error.URLError as error:
                print(f"Could not reach the bridge: {error}. Is `npm run bridge` running?")
                return 1

            sent += 1
            if sent % int(max(args.rate, 1)) == 0:
                print(f"\r{sent} frames sent ({elapsed:.0f}s)", end="", flush=True)

            time.sleep(max(0.0, period - (time.monotonic() - now)))
    except KeyboardInterrupt:
        pass

    print(f"\nStopped after {sent} frames.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
