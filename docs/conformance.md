# Conformance ledger (ADR-0010 golden layering, v1 — 2026-10-22)

The honest record of what is byte-identical versus merely semantically
equal across the four implementations. Java is the reference generator;
TS/C#/Dart compare against it. Divergences listed here are **pinned by
fixtures and reported, not forced green** — unifying any of them is a
deliberate decision with a fixture re-record, never a silent fix.

Layers: **L1** = frame order + params (`frames.txt`, every case);
**L2** = byte digest (`bytes.sha256`, matrix cases only, green cells
asserted; identity-function cases are L1-only per ADR-0007).

Current sweep: 47 cases / 48 case×protocol runs / 37 coverage-matrix
cells covered / 46 L2-eligible runs.

## Runner status

| language | L1 | L2 (asserted green) |
|----------|----|---------------------|
| Java (reference) | all cases asserted | 46/46 |
| TypeScript | all cases compared; 18 equal / 26 diverge / 4 skip | 4/46 (`escpos-text-unmapped`, `escpos-qrcode`, `escpos-copies-cut-feed`, `tspl-unmapped-char`) |
| C# | runner scaffold ready, not enabled (`GoldenCommandConformance.cs`) | 0 (not enabled) |
| Dart | runner scaffold ready, not enabled (`test/golden_commands_test.dart`) | 0 (not enabled) |

The 11 divergences registered inline when the TS encoders were ported
(TSPL CRLF-vs-LF verdicts, SIZE spacing, human-readable mapping, BARCODE
content sanitiser, QR model/mask form, density clamping, FORMFEED
exclusion, copies floor, drawer-kick convenience form, label floor
semantics — see the `差异` annotations in `packages/taprint-ts/src/protocols/`)
are builder-level decisions; the entries below are what they amount to
against the Java reference stream.

## ESC/POS — TS vs Java

| # | Divergence | Evidence |
|---|------------|----------|
| E1 | 倍高行 LF 补偿：Java 每行按 heightScale 补 LF（tall/double→2、triple→3），TS `textLine` 恒 1 LF | `escpos-text-sizing-basic` 帧差 #15、`escpos-text-cjk` #8 |
| E2 | 条码/表格命令面：TS EscPosBuilder 无一维码与表格命令（共享子集外），4 用例 SKIP | `escpos-barcode-*`、`escpos-float-ratio-table` |
| E3 | QR 数据编码：Java 存 UTF-8、TS 存 GBK（ASCII 内容下字节相同——纯 ASCII 用例绿） | `escpos-qrcode`（绿）；CJK QR 用例入后续批次 |
| E4 | 表外字符：两端同为 U+FFFD 占位（ADR-0009），绿 | `escpos-text-unmapped`（L1+L2 绿） |

## TSPL — TS vs Java

| # | Divergence | Evidence |
|---|------------|----------|
| T1 | TEXT 字库缺省：Java 按内容自动选 `3`（ASCII）/`SIMPLIFIED CHINESE`（含 CJK）；TS 恒 `SIMPLIFIED CHINESE` | 全部 ASCII 文本用例帧差 #7 |
| T2 | GBK 表覆盖：TS 为子集表（架/居等缺字→U+FFFD），Java 走 JDK 全表（2 字节原样） | `tspl-text-cjk-sizing`、`tspl-text-align-cjk` |
| T3 | BARCODE 码制助记符：Java `128` vs TS `CODE128` | `tspl-barcode-code128` |
| T4 | BARCODE 人读位：Java 恒 `human=1`；TS 布尔映射、缺省 `2` | `tspl-barcode-*` |
| T5 | QRCODE 参数形态：Java 7 参（model 复合 `M2`、无 mask）；TS 9 参（model `M` + mask `7`） | `tspl-qrcode` |
| T6 | 线图元命令：Java `LINE x1,y1,x2,y2,thickness`；TS 组装层 line → `BAR x,y,w,h`（实心条）；TS 无 BOX 面（rect 跳过） | `tspl-line-box` |
| T7 | 折算常数：Java 203/25.4 dot/mm（≈7.9921）vs TS 8 dot/mm——44.45mm→355/356；8dot/mm 精确中点 6.3125mm→50/51（两常数下 half-away-from-zero 各自成立） | `tspl-dpi-mixed`、`tspl-rounding-midpoint` |
| T8 | 表外字符：同为 U+FFFD 占位（绿）；行尾同 CRLF | `tspl-unmapped-char`（L1+L2 绿） |

## CPCL — TS vs Java

| # | Divergence | Evidence |
|---|------------|----------|
| C1 | 行尾：Java 每命令 CRLF；TS LF——帧级不可见（切行双兼容）、字节级全量差异（CPCL 0 绿格主因） | 全部 cpcl 用例 L2=diff |
| C2 | TEXT 字号档：Java mul-1（top size 2→1）且不读 style.fontSize；TS `resolveTextSizeGrade`（2→2、double→2） | `cpcl-text-sizing-basic`、`cpcl-text-sizing-grades` |
| C3 | GBK 表覆盖：TS 子集表 é/±/°→U+FFFD；Java JDK 全表 2 字节（ñ 两端皆表外→U+FFFD） | `cpcl-codepage-latin`、`cpcl-codepage-latin2` |
| C4 | LINE 厚度：Java 固定 2；TS 用元素高度 dot | `cpcl-line-box` |
| C5 | L1 相等面（11 用例，字节因 C1 不等）：对齐/条码/QR/份数/收尾/间隙/dpi/纸型帧序/身份函数 | `cpcl-text-align-*`、`cpcl-barcode-*`、`cpcl-qrcode`、`cpcl-copies`、`cpcl-feed-tear`、`cpcl-gap-*`、`cpcl-dpi-200`、`cpcl-size-frame-*`、`label-identity-fn/cpcl` |

## Java-side compliance fixes made with this ledger (ADR-0009)

- GBK-unmappable characters: TSPL previously **threw** `RENDER_FAILED`,
  ESC/POS folded to `'?'`, CPCL folded non-ASCII via US-ASCII — all now
  emit the U+FFFD placeholder (`renderer/GbEncoding.java`), matching
  ADR-0009 §3. `TsplContentGuardTest` updated in the same change;
  `UnmappedReplacementTest` pins all three renderers.

## C# / Dart status

Scaffolds compile and enumerate the manifest (C# verified:
`dotnet test` → 274 passed / 4 golden facts skipped, TZ=UTC). Enabling
requires mapping the canonical cases onto the C# builders and Dart
encoders and repeating the sweep; expected known deltas to check first:
CPCL CRLF (C# builder emits CRLF like Java), TSPL barcode symbology
token, Dart line-endings LF, Dart unmapped `'question'` compatibility
tier, and the Dart GB18030 full-table channel (four-byte area vs Java
GBK two-byte area for characters beyond GBK).

## Preview (M3a) — `taprint-preview` (TS)

The bitmap preview engine renders label (absolute layout) and receipt
(24-dot flow grid) presentations to monochrome PNG at true dpi
(`dot = half-up(mm × dpi / 25.4)`, ADR-0009; 203/300). Preview conformance
cases P1–P10 are pinned in
`packages/taprint-preview/tests/conformance.spec.ts` (paper-size mapping at
both dpi, absolute x/y placement, align three-state, line/box/barcode/QR
bbox shapes, overflow truncation).

**Alignment status (honest registration):** the per-case geometry mapping
against the C# `IrWpfPreviewRenderer` (BaseLineDots=24, BaseCharDots=12,
align/truncate/rule semantics, column-weight tables with last-column
right-align) is a **follow-up task** — the TS side mirrors those semantics
by construction, but no C#↔TS rendered-pixel sweep has been run yet. Known
deliberate deltas to reconcile then: preview uses true-dpi dot conversion
(203/25.4, not the encoder's 8 dot/mm — conformance T7), and previews
rasterize real glyph outlines while the C# preview draws character-cell
blocks. Registration of the P-cases here does not assert C# parity.
