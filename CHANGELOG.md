# Changelog

All notable changes to taprint are documented in this file.
The format follows Keep a Changelog; versioning: 0.x releases may break
between minors, strict semver applies from 1.0.

## [Unreleased]

### Added

- **ZPL in all four languages (v0.2, ADR-0001 gate opened)** — the
  four-language parity gate is satisfied and the CI anti-backflow gate is
  removed:
  - Java: `renderer/ZplRenderer` (built-in-font/ASCII route; frame
    `^XA^LH0,0^PW^LL → elements → [^PQ] → ^XZ`; text ^A0N, barcodes
    ^BY/^BC/^BE/^B3/^B2/^BU, QR ^BQN+MA, box ^GB; GBK content channel with
    U+FFFD replacement per ADR-0009; GBK-table unmapped chars placeholder),
    registered in `Taprint#standardRenderers`; image element and the CJK
    ^GFA bitmap route stay deferred to v0.2.x per ADR-0001.
  - Local previewer: `renderer/ZplPreviewer` replaces the extracted
    Labelary HTTP client — ZPL→PNG via pure-Java raster (AWT text, ZXing
    barcodes/QR, ImageIO PNG), zero new dependencies, zero network calls;
    the old Labelary 60-day-retention / PII-whitelist red line dissolves
    with data never leaving the machine. Preview output is pixel-approximate
    and excluded from the golden assertion surface.
  - TypeScript: `src/protocols/zpl.ts` (command-level builders +
    `buildLabel`, half-up-away-from-zero via the shared numeric kernel);
  - C#: `Taprint.PrintDsl/ZplBuilder.cs` (MidpointRounding.AwayFromZero);
  - Dart: `lib/src/printers/zpl_encoder.dart` (label_layout.mmToDot).
- Golden ZPL layer: 16 fixture cases covering the full coverage-matrix v1
  ZPL column (16 cells + unmapped-char special), Java-reference expected
  recorded; TypeScript runner collects **15/16 byte-identical green cells**
  (the remaining case diverges only on the TS GBK subset table, registered
  as Z1 in docs/conformance.md). TS L2 asserted-green total 19/62.
- Tests: Java `ZplRendererTest` (14, incl. previewer), TS `zpl.spec.ts`
  (13), C# `ZplBuilderTests` (16), Dart `zpl_encoder_test.dart` (12,
  static-checked — no local Dart toolchain).
- Repository scaffold: Apache-2.0 license, community files
  (CODE_OF_CONDUCT, SECURITY), compliance tooling (forbidden-content
  scanner with negative-control self-test, license header gate), CI
  skeleton, ADR seeds 0001–0013, frozen L2 coverage matrix v1.
- `taprint-mcp` v0.1 (apps/mcp, ADR-0008): MCP server on stdio with
  `validate_template` (schema + kernel business rules + host-function
  audit), `compile` (ESC/POS receipt / TSPL / CPCL label byte streams
  with frame summaries), and `list_examples` (6 bundled templates);
  schema/example assets ship in-package with a sync script, sha256
  manifest, and drift-asserting tests.

### Changed

- CI: removed the ZPL anti-backflow gate step (ADR-0001) — the CommandSet
  ZPL enum predates this change and stays untouched.
- docs/coverage-matrix.md: ZPL column activated (frozen v1 cell counts
  unchanged); docs/conformance.md: ZPL divergence ledger section.

### Fixed

- Scanner 1.0.2: the email rule no longer flags SCM clone URLs
  (`git@host:org/repo.git` form) — the guard is backtracking-safe
  (`(?![A-Za-z0-9-]*:)`); negative control extended accordingly, and a
  pre-commit hook runs the full compliance gate locally.
