#!/usr/bin/env python3
"""Transcode videos/processed/*.mp4 to browser-playable H.264 in _web/."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from serve import VIDEOS_PROCESSED, VIDEOS_WEB, _list_processed_videos, _transcode_to_web, _web_video_path  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="re-transcode even if _web copy exists")
    args = ap.parse_args()
    os.makedirs(VIDEOS_WEB, exist_ok=True)
    videos = _list_processed_videos()
    if not videos:
        print(f"no .mp4 files in {VIDEOS_PROCESSED}", file=sys.stderr)
        return 1
    for v in videos:
        name = v["name"]
        src = os.path.join(VIDEOS_PROCESSED, name)
        dst = os.path.join(VIDEOS_WEB, name)
        if not args.force and os.path.isfile(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            print(f"skip (up to date): {name}")
            continue
        print(f"transcode: {name}")
        _transcode_to_web(src, dst)
    from serve import _write_manifest  # noqa: WPS433
    _write_manifest()
    print(f"done -> {VIDEOS_WEB}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
