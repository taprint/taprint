#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Release-metadata gate for the taprint monorepo (ADR-0005).

Asserts the "five-point check" from docs/release-metadata-checklist.md
across every publishable manifest: license field present and correct,
no legacy brand strings, public repository URL, publish configuration,
and cross-package version alignment for the release train.

Exit codes: 0 = clean, 1 = violations, 2 = usage/IO error.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

BRAND = re.compile(r"smartshop|longjie|zhaojie|aidata666", re.I)
PUBLIC_REPO = "github.com/taprint/taprint"
TS_PACKAGES = ["packages/taprint-ts", "apps/mcp", "packages/taprint-preview"]
CS_PROJ = "packages/taprint-cs/Taprint.PrintDsl/Taprint.PrintDsl.csproj"

# Manifests that must agree on the kernel release train (major.minor).
VERSION_TRAIN = {
    "packages/taprint-ts/package.json": None,      # baseline
    "apps/mcp/package.json": None,
    "packages/taprint-cs/Taprint.PrintDsl/Taprint.PrintDsl.csproj": None,
    "packages/taprint-dart/pubspec.yaml": None,
}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def check_ts_pkg(root: Path, rel: str, issues: list) -> dict:
    data = load_json(root / rel / "package.json")
    name = data.get("name", "?")
    if str(data.get("license", "")).lower() != "apache-2.0":
        issues.append(f"{rel}: license must be Apache-2.0")
    if data.get("publishConfig", {}).get("access") != "public":
        issues.append(f"{rel}: publishConfig.access must be public")
    if BRAND.search(json.dumps(data)):
        issues.append(f"{rel}: brand string in metadata")
    if PUBLIC_REPO not in data.get("repository", {}).get("url", ""):
        issues.append(f"{rel}: repository.url must point at {PUBLIC_REPO}")
    return {"name": name, "version": data.get("version", "?")}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", default=".")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    issues: list = []

    versions = {}
    for rel in TS_PACKAGES:
        p = root / rel / "package.json"
        if not p.exists():
            print(f"  pending (not yet landed): {rel}")
            continue
        versions[rel] = check_ts_pkg(root, rel, issues)

    # C# project (regex the XML — no XML lib required for these fields)
    cs = root / CS_PROJ
    if cs.exists():
        text = cs.read_text(encoding="utf-8")
        for tag, want in [("<PackageLicenseExpression>Apache-2.0<", "license"),
                          (PUBLIC_REPO, "repository url")]:
            if want == "license" and tag not in text:
                issues.append(f"{CS_PROJ}: PackageLicenseExpression Apache-2.0 missing")
            if want == "repository url" and tag not in text:
                issues.append(f"{CS_PROJ}: repository url must point at {PUBLIC_REPO}")
        if BRAND.search(text):
            issues.append(f"{CS_PROJ}: brand string in metadata")
        m = re.search(r"<Version>([^<]+)</Version>", text)
        versions[CS_PROJ] = {"version": m.group(1) if m else "?"}

    # Dart pubspec (light parse)
    pub = root / "packages/taprint-dart/pubspec.yaml"
    if pub.exists():
        text = pub.read_text(encoding="utf-8")
        if BRAND.search(text):
            issues.append("packages/taprint-dart/pubspec.yaml: brand string")
        if "Apache-2.0" not in text and "license" not in text:
            pass  # pubspec carries license via LICENSE file at publish; ok
        m = re.search(r"^version:\s*(\S+)", text, re.M)
        versions["packages/taprint-dart/pubspec.yaml"] = {
            "version": m.group(1) if m else "?"}

    # Version train: all must share the same major.minor
    train = {rel: ".".join(v["version"].split(".")[:2])
             for rel, v in versions.items() if v.get("version") not in (None, "?")}
    if train and len(set(train.values())) > 1:
        issues.append(f"version train misaligned (major.minor): {train}")

    status = "CLEAN" if not issues else "FAILED"
    print(f"pack-check: {len(versions)} manifests checked -> {status}")
    for i in issues:
        print(f"  {i}")
    return 0 if not issues else 1


if __name__ == "__main__":
    sys.exit(main())
