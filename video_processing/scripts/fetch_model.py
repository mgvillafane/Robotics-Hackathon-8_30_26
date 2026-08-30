#!/usr/bin/env python3
"""Download the MediaPipe Hand Landmarker model into models/."""

from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

DEFAULT_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
)


def default_model_path() -> Path:
    return Path(__file__).resolve().parents[1] / "models" / "hand_landmarker.task"


def fetch_model(dest: Path, url: str = DEFAULT_URL, force: bool = False) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0 and not force:
        return dest
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    print(f"Downloading Hand Landmarker model to {dest}")
    urllib.request.urlretrieve(url, tmp)
    tmp.replace(dest)
    print(f"Wrote {dest} ({dest.stat().st_size} bytes)")
    return dest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", type=Path, default=default_model_path())
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    fetch_model(args.dest, url=args.url, force=args.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
