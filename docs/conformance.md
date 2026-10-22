# Conformance ledger (ADR-0010 golden layering, v1 — 2026-10-22)

The honest record of what is byte-identical versus merely semantically
equal across the four implementations. Java is the reference generator;
TS/C#/Dart compare against it. Divergences listed here are **pinned by
fixtures and reported, not forced green** — unifying any of them is a
deliberate decision with a fixture re-record, never a silent fix.

Layers: **L1** = frame order + params (`frames.txt`, every case);
**L2** = byte digest (`bytes.sha256`, matrix cases only, green cells
asserted; identity-function cases are L1-only per ADR-0007).

Current sweep: 63 cases / 64 case×protocol runs / 46 coverage-matrix
cells covered / 62 L2-eligible runs (ZPL column activated at v0.2,
ADR-0001 gate opened).

## Runner status

| language | L1 | L2 (asserted green) |
|----------|----|---------------------|
| Java (reference) | all cases asserted | 62/62 |
| TypeScript | all cases compared; 33 equal / 27 diverge / 4 skip | 19/62 (ESC/POS `escpos-text-unmapped`, `escpos-qrcode`, `escpos-copies-cut-feed`; TSPL `tspl-unmapped-char`; ZPL 15 格 — 见 §ZPL) |
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

## ZPL — TS vs Java (v0.2, ADR-0001 gate opened)

ZPL landed in all four languages simultaneously (v0.2, builder face:
Java `renderer/ZplRenderer` · TS `src/protocols/zpl.ts` · C#
`Taprint.PrintDsl/ZplBuilder.cs` · Dart `lib/src/printers/zpl_encoder.dart`).
16 golden cases, matrix v1 ZPL column fully covered; **15/16 TS cells are
byte-identical (L1+L2 green)** — the only divergence:

| # | Divergence | Evidence |
|---|------------|----------|
| Z1 | GBK 表覆盖：TS 子集表缺「架」字 → U+FFFD；Java 走 JDK 全表 2 字节原样（与 T2 同根因） | `zpl-text-cjk` |
| Z2 | dot 折算常数：Java 203/25.4 ≈ 7.9921 dot/mm vs TS/C#/Dart 8 dot/mm——本批用例坐标全部同敛（含 `zpl-dpi-203` 的 12.7mm：两端同落 102 dot），潜在分叉面为非整点中点坐标（同 T7 口径，未由本批用例钉死） | 常数级登记，无帧差用例 |
| Z3 | 内容通道：Java 参照原 `^CI28`（UTF-8）被内核 GBK + U+FFFD 口径替换（ADR-0009 §3，四语言字节对拍前提） | 全部 zpl 用例（行为对齐，非分叉） |

Latent API-surface differences (no fixture pins them; register-only):

- **style.fontSize 档**：Java 参照不读 style（恒 size/缺省 1）；TS/C#/Dart
  读兼容档（double→2/triple→3/quadruple→4）。
- **未知码制**：四语言同折 CODE128（Java 参照 `Symbology.of` 缺省口径）——
  与 TSPL/CPCL 构建器的「拒绝不印」纪律不同，为 ZPL 有意选择。
- **barcode 高度缺省**：Java 参照 fallback 10mm；TS/C# label 面 6mm 缺省、
  Dart `label_layout` 6mm——模板显式写 height 时无差异（本批用例均显式）。
- **QR size 缺省**：Java/TS 6；Dart `label_layout` cellSize 缺省 4。
- **image 元素**：v0.2 不支持（Java 抛 UNSUPPORTED_ELEMENT，TS/Dart 跳过、
  C# 未入元素面）——与 CJK 位图路由（^GFA）同批延后 v0.2.x（ADR-0001）。

### ZPL 本地预览器（Java）

参照 `LabelaryClient`（外部 Labelary HTTP 渲染服务）改造为
`renderer/ZplPreviewer`：ZPL→PNG 纯 Java 光栅（AWT 文本 + ZXing 码图 +
JDK ImageIO），零新增依赖、零网络外呼——原「免费档 60 天留存 / PII 白名单」
红线随数据不出本机消解。预览产物为像素近似（一维码宽度按内容估算、文本
光栅与打印机内置字库不同源），**不入 golden 断言面**；真实打印机像素级
校验归真机窗口。

## Java-side compliance fixes made with this ledger (ADR-0009)

- GBK-unmappable characters: TSPL previously **threw** `RENDER_FAILED`,
  ESC/POS folded to `'?'`, CPCL folded non-ASCII via US-ASCII — all now
  emit the U+FFFD placeholder (`renderer/GbEncoding.java`), matching
  ADR-0009 §3. `TsplContentGuardTest` updated in the same change;
  `UnmappedReplacementTest` pins all three renderers.

## C# / Dart status

Scaffolds compile and enumerate the manifest (C# verified:
`dotnet test` → 290 passed / 4 golden facts skipped, TZ=UTC — 含本批
16 个 ZPL 构造器测试；Dart 无本地环境，`zpl_encoder_test.dart` 静态自查
通过，待 CI dart 通道首跑). ZPL enabling follows the same path as
TSPL/CPCL: map the canonical cases onto the C# `ZplBuilder` and Dart
`ZplEncoder` and repeat the sweep; expected known deltas to check first:
CPCL CRLF (C# builder emits CRLF like Java), TSPL barcode symbology
token, Dart line-endings LF, Dart unmapped `'question'` compatibility
tier, and the Dart GB18030 full-table channel (four-byte area vs Java
GBK two-byte area for characters beyond GBK).

### Pre-existing flake (register-only, out of this batch's scope)

`FixtureManifestTests.v1_bizFixture迁移至v2后过v2_schema_超集承诺锁定`
intermittently fails (~50% of full-suite runs, identical on untouched
main) with a delivery-note fixture migrating `/name` to integer —
suspected shared fixture state under parallel test execution. Not
caused by or related to the ZPL batch; filed here so the ledger stays
honest about C# run results.

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
