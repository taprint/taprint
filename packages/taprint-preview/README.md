# taprint-preview

TypeScript bitmap preview engine for the [taprint](https://github.com/taprint/taprint)
print-template DSL: CJK text measurement and layout (opentype.js),
Code128/EAN13/QR bitmaps (bwip-js), 203/300 dpi rasterization with threshold
monochrome conversion, PNG output (pngjs).

**Pure JavaScript** — zero native canvas, zero native dependencies, zero
hardware access (ADR-0008). Lands in v0.3 (M3a).

## Install

```bash
npm install taprint-preview
```

Peer of the [`taprint`](https://www.npmjs.com/package/taprint) kernel package
(used for ADR-0009 numeric helpers and expression evaluation).

## API

```ts
import { renderPng, renderCanvas, FontProvider, MonoCanvas } from 'taprint-preview';

const { png, warnings, widthDots, heightDots, presentation } = await renderPng(
  template,   // taprint DSL template (schema v1.0/v1.1 subset)
  data,       // binding data: { main: {...}, items: [...], overrides }
  { dpi: 203, presentation: 'auto', threshold: 128 },  // all optional
);
// png: Buffer (monochrome grayscale PNG, 8bpp) — write it, show it, delete it.

const { canvas, warnings } = await renderCanvas(template, data, { dpi: 300 });
canvas.inkBBox();     // { minX, minY, maxX, maxY } | null — conformance asserts
canvas.at(x, y);      // 255 = paper, < 128 = ink
canvas.toPng(128);    // monochrome PNG buffer
```

Geometry: `dot = roundHalfAwayFromZero(mm × dpi / 25.4)` at true dpi
(203/300), per ADR-0009 half-up away-from-zero. Receipt flow layout runs on
the 24-dot line grid (C# `IrWpfPreviewRenderer`-aligned); label layout is
absolute x/y. Font size: `size` multiplier on the 24-dot CJK grid; numeric
`style.fontSize` is points (`dot = roundHalfAwayFromZero(pt × dpi / 72)`).

Presentations: `label` (text / barcode / qrcode / line / box / image) and
`receipt` (text / line / cut / spacer / barcode / qrcode / kvtable / table /
cashDrawer). `presentation: 'auto'` prefers `label`.

## Font

The package bundles **Noto Sans SC Regular** (wght=400 static instance,
OFL-1.1, `fonts/`) — served lazily by `FontProvider` (`opentype.js` parse,
first layout triggers a single file read). Latin glyphs come from the same
font; missing glyphs (notdef) are laid out at an approximate advance
(1em CJK / 0.5em Latin) and drawn as hollow boxes, de-duplicated into
`warnings` as `missing-glyph: U+XXXX`. A second exact Latin face is a
follow-up; the first release is honestly "CJK-exact + Latin-from-Noto".

## Warnings (honest degradation, never silent)

`image-skipped` (raster images are a follow-up) · `cashDrawer-skipped` ·
`unsupported-symbology` (preview v1 = CODE128/EAN13 only) ·
`box-radius-degraded` (rounded corners render as right angles, TSPL parity) ·
`missing-glyph`. Barcode/QR contents that bwip-js rejects (e.g. EAN13 must be
12/13 digits) raise `RenderError { code: 'barcode-encode-failed' }` instead of
rendering an empty image.

## Not yet (registered follow-ups)

- Dithering (Floyd–Steinberg) — threshold monochrome only in M3a.
- Human-readable barcode digits follow the explicit `humanReadable` value
  only; the D3 default ruling is pending, no default is invented.
- Exact geometry parity ledger with the C# `IrWpfPreviewRenderer` — cases are
  pinned in `tests/conformance.spec.ts` (P1–P10); the cross-implementation
  annotation lands in `docs/conformance.md` as a follow-up task.

License: Apache-2.0. Bundled font: Noto Sans SC, SIL OFL-1.1 (`fonts/OFL.txt`).
