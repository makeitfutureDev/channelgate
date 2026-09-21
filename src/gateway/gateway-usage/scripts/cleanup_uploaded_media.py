#!/usr/bin/env python3
"""Delete one successfully processed media upload without escaping the channel uploads folder."""

from __future__ import annotations

import argparse
import json
import stat
import sys
from pathlib import Path


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()

    channel_root = Path.cwd().resolve()
    try:
        uploads_root = (channel_root / "uploads").resolve(strict=True)
    except OSError as exc:
        fail(f"Managed uploads directory is unavailable: {exc}")

    source = args.source if args.source.is_absolute() else channel_root / args.source
    try:
        source_info = source.lstat()
    except OSError as exc:
        fail(f"Media source is unavailable: {exc}")
    if stat.S_ISLNK(source_info.st_mode) or not stat.S_ISREG(source_info.st_mode):
        fail("Refusing to remove a source that is not a regular file.")

    try:
        resolved_source = source.resolve(strict=True)
        resolved_source.relative_to(uploads_root)
    except (OSError, ValueError):
        fail("Refusing to remove a source outside the current channel's managed uploads directory.")

    try:
        source.unlink()
    except OSError as exc:
        fail(f"Could not remove processed media source: {exc}")

    print(json.dumps({"removed": str(resolved_source)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
