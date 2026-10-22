# fixtures

Shared golden fixtures: template inputs plus expected outputs — frame
order streams (L1, every case) and byte digests (L2, the frozen subset
defined in `docs/coverage-matrix.md`). ADR-0010 governs the layering;
the live divergence ledger is `docs/conformance.md`.

## Layout

```
fixtures/
  templates/                     # business DSL templates（parse/signer 金样，v0.1 前已就位）
  negative/                      # validator negative cases（与本目录 ADR-0010 层无关）
  expected/parse-results/        # parse/signer golden（另一套工件，勿与本层混同）
  cases/                         # golden-command 用例（codegen 生成，taprint/golden-case@1）
  expected/commands/<case>/<lang>/<protocol>.frames.txt        # L1 帧序工件
  expected/commands/<case>/<lang>/<protocol>.bytes.sha256      # L2 字节摘要（绿格/身份函数豁免规则见 manifest）
  manifest.json                  # taprint/golden-commands@1：case/profile/protocols/
                                 #   containsIdentityFn/layers + l2Assert 每语言绿格面
```

`fixtures/manifest.json` is the ADR-0010 command-layer manifest. It is a
different artifact from `packages/taprint-ts/tests/generated/fixture-manifest.json`
(parse/signer layer); do not merge them.

## Case schema (`taprint/golden-case@1`)

Each `cases/<id>.json` carries a canonical, language-neutral input:
`{schema, id, title, profile: label|receipt, protocols, containsIdentityFn,
special, matrixCells, input}`. `input` holds `label`/`receipt` specs plus a
`body` of canonical elements (`text`/`barcode`/`qrcode`/`line`/`rect`/
`spacer`/`cut`/`table`). Every runner maps this input onto its own encoder
surface; behaviour the language lacks is recorded as SKIP in the report and
in `docs/conformance.md`, never silently emulated.

## L1 frame format (`frames.txt`)

One frame per line: `序号|协议助记|参数键=值;参数键=值…` (no params → `-`).
Content-bearing params serialize **raw bytes**: printable ASCII verbatim,
everything else `\xXX`, with `\\ \" \r \n \t` escaping. No GBK decoding —
the file is byte-faithful and identical across parser implementations.

## Regenerating

```
tools/fixture-codegen                       # cases + manifest + Java expected (runs Maven)
tools/fixture-codegen --skip-java           # cases + manifest only
tools/fixture-codegen --l2-green ts=a,b     # stamp lang green cells after a verified run
```

The Java reference generator lives in
`packages/taprint-java/src/test/java/dev/taprint/golden/GenerateGoldenExpected.java`
(drives the real renderers). Rendering behaviour changes must be deliberate:
re-record expected, and update `docs/conformance.md` in the same change.

## Runners

| language | entry | status |
|----------|-------|--------|
| Java (reference) | `cd packages/taprint-java && mvn test -Dtest=GoldenCommandFixturesTest` | enabled — L1 全量断言 + L2 按 `l2Assert.java` 断言（身份函数用例只跑 L1） |
| TypeScript | `cd packages/taprint-ts && npx vitest run tests/golden-commands.spec.ts`（CI 已随 `npm test` 跑） | enabled — L1 全量比对（分叉出报告不失败）+ L2 仅绿格断言 |
| C# | `dotnet test packages/taprint-cs/Taprint.PrintDsl.Tests --filter GoldenCommandConformance` | 脚本就绪 · 未启用（`[Fact(Skip=…)]`，启用路径见 `GoldenCommandConformance.cs` 头注） |
| Dart | `cd packages/taprint-dart && dart test test/golden_commands_test.dart` | 脚本就绪 · 未启用（`group(skip: …)`，启用路径见文件头注） |

Runner rules (all languages):

1. **L1** compares frame order + params against `expected/commands/<case>/java/`
   for every case. Cross-language divergence is *reported*, not asserted —
   it belongs in `docs/conformance.md`.
2. **L2** asserts the byte digest only where `manifest.json → cases[].l2Assert.<lang>`
   is `true` (a verified byte-identical cell). Everything else is probed
   and reported.
3. Identity-function cases (`containsIdentityFn: true`) run L1 only;
   they must never carry a `bytes.sha256`.
