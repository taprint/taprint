# ADR-0002: Font licensing — SPI, bundled OFL default, no system-font bundling

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The original renderer loaded a Windows-bundled CJK font from its
resources, and the PDF path embedded subsets of it into output files.
That font's license forbids redistribution and format conversion
(including bitmap forms), so the kernel could not ship as open source
with it.

## Decision

1. Every renderer consumes fonts through a `FontProvider` SPI; no
   renderer loads font files directly.
2. The bundled default is **Noto Sans SC (OFL-1.1)**, shipped unmodified
   together with its OFL.txt verbatim; the CI asserts the license file's
   presence and equality with the upstream copy at
   `google/fonts:ofl/notosanssc/OFL.txt` (the reserved-font-name header
   lives there; mirrors may lack it).
3. Subsetting rules branch by reserved font name: fonts whose names carry
   the "Source" reservation must be renamed when subsetted; "Noto Sans SC"
   carries no such reservation and keeps its name. The repo's subsetting
   tool encodes both branches.
4. Documentation never names or ships any non-redistributable font; the
   compliance scanner bans its file names.

## Consequences

Rendering metrics change relative to the old default, so golden byte
streams were re-recorded once at extraction. A host can inject any
font source it likes through the SPI.
