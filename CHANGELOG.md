# Changelog

All notable changes to taprint are documented in this file.
The format follows Keep a Changelog; versioning: 0.x releases may break
between minors, strict semver applies from 1.0.

## [Unreleased]

### Added

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
- `taprint-preview` v0.1 (packages/taprint-preview, M3a — ADR-0008 pure-JS
  route): bitmap preview engine with `renderPng` / `renderCanvas` —
  203/300 dpi rasterization to monochrome threshold PNG (pngjs), label
  absolute layout and receipt 24-dot flow layout (C# IrWpfPreviewRenderer-
  aligned), CJK text via bundled Noto Sans SC (OFL-1.1, opentype.js lazy
  load + notdef fallback chain), Code128/EAN13/QR bitmaps (bwip-js),
  ADR-0009 half-up geometry at true dpi; honest-degradation warnings
  (image-skipped / cashDrawer-skipped / unsupported-symbology /
  box-radius-degraded / missing-glyph) and preview conformance cases
  P1–P10 (`tests/conformance.spec.ts`; C# alignment annotation is a
  registered follow-up in docs/conformance.md).
- `taprint-mcp`: `render_preview` tool (M3a) — template + data → monochrome
  PNG written to a temp file, returns `{path, byteCount, presentation,
  widthDots, heightDots, warnings}`; RenderError codes surface as MCP tool
  errors; tool roster now four (`validate_template`, `compile`,
  `list_examples`, `render_preview`).

### Fixed

- Scanner 1.0.2: the email rule no longer flags SCM clone URLs
  (`git@host:org/repo.git` form) — the guard is backtracking-safe
  (`(?![A-Za-z0-9-]*:)`); negative control extended accordingly, and a
  pre-commit hook runs the full compliance gate locally.
