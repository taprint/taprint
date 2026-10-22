# Bundled CJK font (Noto Sans SC, OFL-1.1)

This directory carries the kernel's default CJK typeface served through the
`FontProvider` SPI (ADR-0002):

- `NotoSansSC-Regular.ttf` - Noto Sans SC, weight 400, distributed by
  Google Fonts via its CSS API (`family=Noto+Sans+SC:wght@400`). The file is
  shipped unmodified.
- `OFL.txt` - the upstream license text, copied verbatim from
  `google/fonts` at `ofl/notosanssc/OFL.txt`.

## Re-fetching the files

If either file is missing (for example a clone with Git LFS skipped), fetch
them with:

```sh
curl -L -o NotoSansSC-Regular.ttf \
  "https://fonts.gstatic.com/s/notosanssc/v41/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYw.ttf"
curl -L -o OFL.txt \
  "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt"
```

The pinned URL above serves the exact static instance this kernel records
its golden fixtures against; do not substitute a variable font
(`NotoSansSC[wght].ttf`) - Java2D and OpenPDF both resolve its default
instance to Thin, which changes rasterization metrics and PDF bytes.

## Tests without the font

Font-dependent tests use JUnit `assumeTrue` on `FontProvider#available()`
and skip when the TTF is absent, so CI clones without the font still run the
non-glyph test suite. Rendering then degrades to a JDK logical font
(rasterization) or Helvetica (PDF) exactly as it does in production when a
host supplies no font.

## Licensing notes

OFL-1.1 permits redistribution and subsetting. The reserved font names in
`OFL.txt` apply to the "Source" family naming; "Noto Sans SC" carries no
reservation relevant to subsetting, so subsetted derivatives may keep the
name. Never bundle a font whose license forbids redistribution.
