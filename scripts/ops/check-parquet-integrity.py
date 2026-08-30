#!/usr/bin/env python3
"""Read only the framing bytes of explicitly configured Parquet files."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def check(path: Path) -> str | None:
    try:
        size = path.stat().st_size
        if not path.is_file():
            return "not a regular file"
        if size < 12:
            return "file is too small for Parquet framing"
        with path.open("rb") as stream:
            leading = stream.read(4)
            stream.seek(-8, 2)
            footer = stream.read(8)
        if leading != b"PAR1":
            return "missing leading PAR1 magic"
        if footer[4:] != b"PAR1":
            return "missing trailing PAR1 magic"
        footer_length = int.from_bytes(footer[:4], "little", signed=False)
        if footer_length > size - 12:
            return "footer length exceeds file size"
        return None
    except OSError as error:
        return f"cannot read file: {error.strerror or error.__class__.__name__}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Check configured Parquet framing")
    parser.add_argument("--path", action="append", required=True)
    args = parser.parse_args()
    if len(args.path) > 100:
        parser.error("at most 100 paths are allowed")

    invalid: list[dict[str, str]] = []
    for raw in args.path:
        path = Path(raw)
        if not path.is_absolute():
            invalid.append({"path": raw, "reason": "path is not absolute"})
            continue
        reason = check(path)
        if reason is not None:
            invalid.append({"path": raw, "reason": reason})

    output = {
        "checked": len(args.path),
        "valid": len(args.path) - len(invalid),
        "invalid": invalid,
    }
    print(json.dumps(output, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
