#!/usr/bin/env python3
"""Mirror a real LeRobot SO-101 follower arm in the simulator.

Reads observations from a connected follower and forwards them to the bridge,
so the on-screen arm tracks the physical one.

    pip install lerobot
    npm run bridge
    python examples/python/from_lerobot.py --port COM5

LeRobot's ``get_observation()`` returns keys such as ``shoulder_pan.pos``. The
simulator matches on the joint name, so the ``.pos`` suffix is stripped here.

On units: LeRobot's ``use_degrees`` config flag decides what the five arm joints
report. It defaults to ``True`` from v0.6.0 onward (degrees) but defaulted to
``False`` before that (normalised -100..100). Pass ``--unit norm100`` if you are
on an older release or have set the flag yourself. The gripper is always on a
0..100 scale regardless, and the simulator handles that difference internally.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
import time
import urllib.request

# LeRobot moved SO101Follower from `so101_follower` into the shared
# `so_follower` module, keeping SO101Follower as an alias. Try the current
# layout first, then the pre-0.6 one.
FOLLOWER_CANDIDATES = (
    ("lerobot.robots.so_follower", "SOFollower", "SOFollowerConfig"),
    ("lerobot.robots.so_follower", "SO101Follower", "SO101FollowerConfig"),
    ("lerobot.robots.so101_follower", "SO101Follower", "SO101FollowerConfig"),
)


def load_follower_classes():
    """Return (FollowerClass, ConfigClass) for whichever lerobot is installed."""
    attempts = []
    for module_name, class_name, config_name in FOLLOWER_CANDIDATES:
        try:
            module = importlib.import_module(module_name)
            return getattr(module, class_name), getattr(module, config_name)
        except (ImportError, AttributeError) as error:
            attempts.append(f"  {module_name}.{class_name}: {error}")
    raise ImportError(
        "Could not locate the SO-101 follower classes. Tried:\n"
        + "\n".join(attempts)
        + "\nInstall lerobot with `pip install lerobot`, or check the import "
        "path for your version."
    )


def send(url: str, frame: dict) -> None:
    request = urllib.request.Request(
        url,
        data=json.dumps(frame).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(request, timeout=1.0).close()


def strip_suffix(observation: dict) -> dict[str, float]:
    """Turn ``{"shoulder_pan.pos": 12.0, ...}`` into ``{"shoulder_pan": 12.0}``."""
    positions: dict[str, float] = {}
    for key, value in observation.items():
        if not isinstance(value, (int, float)):
            continue
        name = key.split(".", 1)[0] if key.endswith(".pos") else key
        positions[name] = float(value)
    return positions


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="Serial port of the follower arm.")
    parser.add_argument("--id", default="follower", help="Calibration id for this arm.")
    parser.add_argument(
        "--url",
        default="http://localhost:8765/joint_states",
        help="Bridge ingest endpoint.",
    )
    parser.add_argument("--rate", type=float, default=30.0, help="Frames per second.")
    parser.add_argument(
        "--unit",
        choices=("deg", "rad", "norm100"),
        default="deg",
        help="Unit the follower reports positions in.",
    )
    args = parser.parse_args()

    try:
        follower_class, config_class = load_follower_classes()
    except ImportError as error:
        print(error, file=sys.stderr)
        return 1

    robot = follower_class(config_class(port=args.port, id=args.id))
    robot.connect()
    print(f"Connected to {args.port}. Streaming to {args.url}. Ctrl+C to stop.")

    period = 1.0 / args.rate
    try:
        while True:
            started = time.monotonic()
            positions = strip_suffix(robot.get_observation())
            if positions:
                send(
                    args.url,
                    {
                        "robot": "so101",
                        "unit": args.unit,
                        "timestamp": time.time(),
                        "positions": positions,
                    },
                )
            time.sleep(max(0.0, period - (time.monotonic() - started)))
    except KeyboardInterrupt:
        pass
    finally:
        robot.disconnect()

    print("\nDisconnected.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
