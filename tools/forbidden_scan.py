#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Forbidden-content gate for the taprint repository.

Scans every text file in the tree for content that must never become
public: internal brand/host/registry identifiers, leaked secrets, and
internal workflow vocabulary. A narrower governance rule set applies to
documentation only, so ordinary community vocabulary stays legal.

The pattern set is frozen by ADR-0006. Changing it requires maintainer
sign-off and an updated negative-control test (tools/test_compliance.py).

Exit codes: 0 = clean, 1 = hits found, 2 = usage/IO error.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Pattern, Tuple

SCAN_VERSION = "1.0.3"

SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", "bin", "obj", ".dart_tool",
    "__pycache__", ".venv", "venv", "test-results", "playwright-report",
    ".idea", ".vscode", ".hermes",
}
MAX_BYTES = 10 * 1024 * 1024

# Files that must contain banned strings themselves (pattern-as-data).
EXEMPT_FILES: Dict[str, str] = {
    "tools/forbidden_scan.py": "scanner pattern definitions (ADR-0006)",
    "tools/test_compliance.py": "negative-control decoys (ADR-0006)",
}


def code_patterns() -> List[Tuple[str, Pattern[str]]]:
    """Banned everywhere: code, config, comments, docs."""
    return [
        ("internal-brand-smartshop", re.compile(r"smartshop", re.I)),
        ("internal-brand-longjie", re.compile(r"longjie", re.I)),
        ("internal-brand-zhaojie", re.compile(r"zhaojie", re.I)),
        ("internal-lan-host", re.compile(r"192\.168\.")),
        ("internal-machine-names",
         re.compile(r"\b(testshop2|testai|testdeploy|bigdata1|test[456])\b")),
        ("internal-home-path", re.compile(r"/home/zj")),
        ("internal-registry-host", re.compile(r"gitee\.com|\baidata666\b")),
        ("internal-schema-tables",
         re.compile(r"\bss_(?:sys|tenant|user|organization)\b")),
        ("non-redistributable-font", re.compile(r"simsun", re.I)),
        ("leaked-secret", re.compile(r"E2e@Print")),
        ("internal-decision-vocab", re.compile(r"用户令|定案|任务书|拍板")),
        ("internal-doc-refs",
         re.compile(r"\bDPD\b|handoff|DESIGNER-PRODUCTION|设计器文档|播种")),
        ("email-address",
         re.compile(
             r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+"
             r"(?![A-Za-z0-9-]*:)")),
    ]


def governance_patterns() -> List[Tuple[str, Pattern[str]]]:
    """Banned only in documentation, where plain review language stays legal."""
    return [
        ("governance-review-tag", re.compile(r"评审\s?[A-Z]?\d|轮评审|评审轨迹")),
    ]


def _is_governance(rel: str) -> bool:
    if not rel.endswith((".md", ".markdown")):
        return False
    return "/" not in rel or rel.startswith("docs/")


def _iter_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            # `.git` is repository metadata: a directory in plain clones
            # (already dropped via SKIP_DIRS) and a gitdir-pointer FILE in
            # linked worktrees. It is never tracked content — skip both.
            if name == '.git':
                continue
            yield Path(dirpath) / name


def _is_binary(path: Path) -> bool:
    with path.open("rb") as fh:
        return b"\x00" in fh.read(8192)


def scan_root(root: Path) -> Tuple[int, List[dict]]:
    """Return (files_scanned, hits); each hit is {file, line, rule}."""
    root = root.resolve()
    scanned = 0
    hits: List[dict] = []
    code = code_patterns()
    gov = governance_patterns()
    for path in _iter_files(root):
        rel = path.relative_to(root).as_posix()
        if rel in EXEMPT_FILES:
            continue
        try:
            if path.is_symlink() or path.stat().st_size > MAX_BYTES \
                    or _is_binary(path):
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        scanned += 1
        rules = list(code)
        if _is_governance(rel):
            rules += gov
        for rule_name, pattern in rules:
            for match in pattern.finditer(text):
                line_no = text.count("\n", 0, match.start()) + 1
                hits.append({"file": rel, "line": line_no, "rule": rule_name})
    return scanned, hits


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Forbidden-content gate (see module docstring).")
    parser.add_argument("root", nargs="?", default=".",
                        help="repository root to scan")
    parser.add_argument("--report", help="write a JSON report to this path")
    args = parser.parse_args(argv)

    root = Path(args.root)
    if not root.is_dir():
        print(f"error: {root} is not a directory", file=sys.stderr)
        return 2

    scanned, hits = scan_root(root)
    status = "CLEAN" if not hits else "FAILED"
    print(f"forbidden-scan {SCAN_VERSION}: scanned {scanned} files, "
          f"hits {len(hits)} -> {status}")
    for hit in hits:
        print(f"  {hit['file']}:{hit['line']}  [{hit['rule']}]")
    if args.report:
        Path(args.report).write_text(
            json.dumps({"scan_version": SCAN_VERSION,
                        "files_scanned": scanned, "hits": hits},
                       ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8")
    return 0 if not hits else 1


if __name__ == "__main__":
    sys.exit(main())
