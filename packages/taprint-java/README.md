# taprint-java

Java implementation of the taprint DSL kernel: the DSL parser/validator, the
sandboxed expression engine, and the ESC/POS / TSPL / CPCL command-stream
renderers plus the A4 PDF renderer. Maven artifact
`io.github.taprint:taprint-java`, JDK 17, no framework dependencies.

## Usage

```java
Taprint taprint = Taprint.standard();

TemplateDsl dsl = JSON.parseObject(dslJson, TemplateDsl.class);
EvaluatedTemplate evaluated =
        taprint.evaluator().eval(dsl, DeviceClass.RECEIPT, data);
RenderResult result = taprint.renderers().get(CommandSet.ESC_POS)
        .render(evaluated, RenderContext.builder().copies(1).build());
byte[] payload = result.getPayload();   // ready for the transport channel
```

`Taprint.of(KernelOptions, HostFunctions, FontProvider)` accepts custom
sandbox limits, host functions and font sources.

## Extension points

- **HostFunctions SPI (ADR-0007)** — `dev.taprint.expression.HostFunctions`.
  The kernel ships no business functions. Register your own domain functions
  (identity, lookup helpers, ...) through the SPI; templates calling anything
  else fail statically via
  `dev.taprint.expression.ExpressionAudit` (validation time) and explicitly
  inside the engine (evaluation time). Byte-level cross-language goldens are
  only guaranteed for templates without host functions.
- **FontProvider SPI (ADR-0002)** — `dev.taprint.font.FontProvider`. All CJK
  rendering (TSPL/CPCL rasterization, PDF embedding, preview) goes through
  this interface; no renderer loads font files directly. The bundled default
  is Noto Sans SC (OFL-1.1) from `src/main/resources/fonts/` — see the
  README there for provenance and re-fetch instructions. Tests that need the
  glyph stream skip themselves with JUnit `assumeTrue` when the font file is
  absent; rendering then degrades to a JDK logical font / Helvetica.

## Sandbox contract

Per-expression timeout (default 100 ms), per-render expression budget (5 s),
cumulative loop-iteration cap (100k), block nesting limits (if ≤ 5,
each ≤ 3), template ≤ 1 MB, expression ≤ 1 KB, and the QLExpress4
StrategyIsolation security strategy blocking reflective/field access. All
limits are tunable through `dev.taprint.core.KernelOptions`.

## Tests

`mvn test` (surefire pins `user.timezone=UTC`) runs ~118 tests: expression
engine semantics, DSL validation (fixtures + negatives), renderer byte-stream
assertions, render-budget/interrupt behavior, and golden conformance
(ESC/POS sha256; PDF sha256 over normalized bytes masking the three
nondeterministic sources OpenPDF emits). The two PDF goldens were re-recorded
once when the bundled font changed from the original project font to Noto
Sans SC (ADR-0002).

### Not ported from the original repository

The source project's print module also contained storage, orchestration and
business-integration layers that are out of scope for a rendering kernel.
Their tests were intentionally not ported: DB/MyBatis-backed template
management, job lifecycle/reprint/report-HMAC, async retry routing, designer
sessions and websocket legs, datasource fetcher suites, the Labelary cloud
fallback client and ZPL renderer (ZPL is gated until v0.2, ADR-0001), the
controller alias contract, and preview simulator ink accounting (preview
ships as `taprint-preview` in v0.3).
