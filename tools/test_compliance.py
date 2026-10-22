#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Negative controls for the compliance tools (ADR-0006).

Plants decoy files that violate every pattern category in a temporary
tree and asserts the scanner catches each one, plus clean files that must
produce zero hits. Also exercises the license-header checker. Run in CI
before the repository-wide scan so a broken scanner can never fake a
clean report.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import forbidden_scan
import header_check

# file -> (expected rule, violating content)
CODE_DECOYS = {
    "brand.txt": ("internal-brand-smartshop",
                  "ask the smartshop team about legacy keys"),
    "host.txt": ("internal-lan-host",
                 "staging gateway lives at 192.168.1.9"),
    "registry.txt": ("internal-registry-host",
                     "git clone https://gitee.com/aidata666/demo.git"),
    "flow.txt": ("internal-decision-vocab",
                 "see 任务书 T1, then 拍板 the schema bump"),
    "secret.txt": ("leaked-secret",
                   "password: E2e@Print#2026_0x9F"),
    "mail.txt": ("email-address",
                 "questions -> dev@example.com"),
}
GOV_DECOY = ("governance-review-tag", "见评审 I4 与评审轨迹。")
FONT_DECOY = ("non-redistributable-font", "render with simsun.ttc, dpi 203")


def test_forbidden_scan_catches_every_category() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "docs").mkdir()
        expected: dict = {}
        for name, (rule, text) in CODE_DECOYS.items():
            (root / name).write_text(text, encoding="utf-8")
            expected[name] = {rule}
        (root / "font.txt").write_text(FONT_DECOY[1], encoding="utf-8")
        expected["font.txt"] = {FONT_DECOY[0]}
        (root / "docs" / "notes.md").write_text(GOV_DECOY[1],
                                                encoding="utf-8")
        expected["docs/notes.md"] = {GOV_DECOY[0]}
        (root / "clean.md").write_text(
            "Receipt printing and label templates, compiled everywhere.\n",
            encoding="utf-8")
        expected["clean.md"] = set()
        # SCM clone URLs look like emails (git@host:path) but are not;
        # the email rule must not flag them, at any backtracking split
        # (ADR-0006 pattern 1.0.2).
        (root / "clone.txt").write_text(
            "git remote add origin git@github.com:taprint/taprint.git\n",
            encoding="utf-8")

        scanned, hits = forbidden_scan.scan_root(root)
        got: dict = {}
        for hit in hits:
            got.setdefault(hit["file"], set()).add(hit["rule"])
        assert scanned >= len(expected), scanned
        flagged = {k: v for k, v in expected.items() if v}
        assert got == flagged, f"expected {flagged}, got {got}"
        assert "clean.md" not in got, "clean file must produce zero hits"
        assert "clone.txt" not in got, "clone URL must not trip the email rule"


def test_header_checker() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "good.py").write_text(
            "# SPDX-License-Identifier: Apache-2.0\nprint('ok')\n",
            encoding="utf-8")
        (root / "bad.py").write_text("print('missing header')\n",
                                     encoding="utf-8")
        (root / "note.md").write_text("headers not required here\n",
                                      encoding="utf-8")
        missing = header_check.check_root(root)
        assert missing == ["bad.py"], missing


if __name__ == "__main__":
    test_forbidden_scan_catches_every_category()
    test_header_checker()
    print("compliance self-test: all negative controls passed")
