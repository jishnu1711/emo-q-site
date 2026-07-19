#!/usr/bin/env python3
"""Play one desk-robot motor emotion through the meow_hw motion layer.

This helper is intentionally small so Echo Q can trigger hardware emotion from
the Node backend without importing Arduino Bridge in JavaScript. If the UNO Q
Bridge runtime is unavailable, the helper exits cleanly and Echo Q continues.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path


DEFAULT_MEOW_HW_PYTHON = Path("/home/jishnu/embedded/meow_hw/app/python")
MOTOR_EMOTIONS = {"happy", "sad", "confused", "idle"}


def configure_import_path() -> None:
    package_root = Path(os.environ.get("MEOW_HW_PYTHON_PATH", DEFAULT_MEOW_HW_PYTHON))
    sys.path.insert(0, str(package_root))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Play one Echo Q motor emotion.")
    parser.add_argument("emotion", choices=sorted(MOTOR_EMOTIONS))
    return parser.parse_args()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="[motor-emotion] %(levelname)s: %(message)s")
    args = parse_args()
    configure_import_path()

    try:
      from meow_motion import EmotionMotorController
    except Exception as exc:
      logging.warning("meow_motion is unavailable; skipping %s gesture: %s", args.emotion, exc)
      return 0

    try:
      controller = EmotionMotorController(auto_verify=True)
      if args.emotion == "idle":
        controller.stop()
      else:
        controller.play_emotion(args.emotion)
    except Exception as exc:
      logging.warning("motor emotion %s skipped or failed safely: %s", args.emotion, exc)
      return 0

    logging.info("completed %s", args.emotion)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
