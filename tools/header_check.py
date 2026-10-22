#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""License header gate for the taprint repository.

Every source file in the four implementation languages (and this repo's
tooling) must carry an SPDX Apache-2.0 identifier within its first eight
lines. Documentation and data formats are exempt.

Exit codes: 0 = clean, 1 = files missing the header, 2 = usage/IO error.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Set

HEADER_TOKEN = "SPDX-License-Identifier: Apache-2.0"
CHECK_EXTS: Set[str] = {
    ".py", ".ts", ".tsx", ".cts", ".mts", ".js", ".mjs",
    ".cs", ".dart", ".java", ".kt", ".go",
}
SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", "bin", "obj", ".dart_tool",
    "__pycache__", ".venv", "venv", "test-results", "playwright-report",
    ".idea", ".vscode", ".hermes",
}
MAX_BYTES = 10 * 1024 * 1024


def _iter_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            yield Path(dirpath) / name


def _is_binary(path: Path) -> bool:
    with path.open("rb") as fh:
        return b"\x00" in fh.read(8192)


def check_root(root: Path) -> List[str]:
    """Return the repo-relative paths missing the license header."""
    root = root.resolve()
    missing: List[str] = []
    for path in _iter_files(root):
        rel = path.relative_to(root).as_posix()
        if path.suffix not in CHECK_EXTS:
            continue
        try:
            if path.is_symlink() or path.stat().st_size > MAX_BYTES \
                    or _is_binary(path):
                continue
            head = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if HEADER_TOKEN not in "\n".join(head.splitlines()[:8]):
            missing.append(rel)
    return missing


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="License header gate (see module docstring).")
    parser.add_argument("root", nargs="?", default=".",
                        help="repository root to check")
    parser.add_argument("--report", help="write a JSON report to this path")
    args = parser.parse_args(argv)

    root = Path(args.root)
    if not root.is_dir():
        print(f"error: {root} is not a directory", file=sys.stderr)
        return 2

    missing = check_root(root)
    status = "CLEAN" if not missing else "FAILED"
    print(f"header-check: {len(missing)} file(s) missing "
          f"'{HEADER_TOKEN}' -> {status}")
    for rel in missing:
        print(f"  {rel}")
    if args.report:
        Path(args.report).write_text(
            json.dumps({"header_token": HEADER_TOKEN,
                        "missing": missing}, indent=2) + "\n",
            encoding="utf-8")
    return 0 if not missing else 1


if __name__ == "__main__":
    sys.exit(main())
