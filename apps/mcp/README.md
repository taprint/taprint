# taprint-mcp

MCP server for the [taprint](https://github.com/taprint/taprint) print-template DSL:
`validate_template`, `compile`, `list_examples` (v0.1) and `render_preview`
(M3a, bitmap preview via the pure-JS `taprint-preview` engine). Zero printer /
hardware access, zero native dependencies — an `npx` one-liner works everywhere
Node runs. **Physical printing is permanently out of scope** — hosts print the
compiled byte streams themselves.

## Install & run

```bash
npx -y taprint-mcp          # starts the MCP server on stdio
taprint-mcp --help          # usage
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "taprint": { "command": "npx", "args": ["-y", "taprint-mcp"] }
  }
}
```

### Claude Code

```bash
claude mcp add taprint -- npx -y taprint-mcp
```

## Tools

### `validate_template`

Validate a template JSON object. Three layers, merged into
`{valid, errors:[{path, code, message}]}`:

1. **JSON Schema** (`v1.0` / `v1.1` / `v2.0`, selected by `schemaVersion`;
   the schema files ship inside the package under `schemas/`);
2. **kernel business rules** (expression grammar, field binding against
   dataSources/parameters, DSL 2.0 cross-field shapes);
3. **host-function audit** (ADR-0007 SPI, minimal ExpressionAudit): every
   `fn(...)` call inside an expression must be listed in the optional
   `hostFunctions: string[]` argument, otherwise `unknown-host-function`.

Input: `{template: object, hostFunctions?: string[]}`.

### `compile`

Compile a template (plus binding data) into printer bytes.

Input:

```jsonc
{
  "template": { /* taprint template */ },
  "data": { /* fields per the template's dataSources/parameters */ },
  "target": "escpos" | "tspl" | "cpcl",
  "options": { "dpi": 203, "widthMm": 50, "copies": 3 }  // all optional
}
```

Output: `{bytesBase64, byteCount, frameSummary: string[]}` — the base64 byte
stream plus a human-readable frame-order summary. Two presentation paths:

- `escpos` uses `presentations.receipt` (ESC/POS line order: text / kvtable /
  table / qrcode / divider / cashDrawer / cut; receipt `barcode` follows the
  kernel Dart fallback = blank-line placeholder + explicit `WARN` in
  `frameSummary`);
- `tspl` / `cpcl` use `presentations.label` via the kernel `buildLabel` frame
  order (`SIZE/GAP/DENSITY/SPEED/DIRECTION/CLS/body/PRINT`).

Capability edges fail loudly instead of silently degrading: mismatched
presentation (`missing-presentation`), `image` elements
(`unsupported-element` — rasterization is v0.3), `dpi` other than 200/203
(`unsupported-dpi` — the kernel pins 8 dot/mm), and `copies` on `escpos`
(`option-not-supported` — receipt copies are host-side re-sends). Label `box`
elements are skipped by the kernel `buildLabel` and reported as `SKIP` entries
in `frameSummary`.

### `list_examples`

Returns the 6 curated example templates bundled in the package (2 receipts, 2
price/shelf labels, 2 A4 documents): `{count, examples:[{name, code,
schemaVersion, category, file, template}]}`. Feed any of them straight back
into `validate_template` / `compile`.

### `render_preview`

Render a template (plus binding data) into a monochrome bitmap preview
(M3a, pure-JS engine `taprint-preview` — ADR-0008: no native canvas).

Input:

```jsonc
{
  "template": { /* taprint template */ },
  "data": { /* fields per the template's dataSources/parameters */ },
  "presentation": "auto" | "label" | "receipt",       // optional, auto = label first
  "options": { "dpi": 203 | 300, "threshold": 128 }   // optional
}
```

Output: `{path, byteCount, presentation, widthDots, heightDots, warnings}` —
the PNG is written to a temp file (read it back from `path`; the host may
delete it after display). Geometry is ADR-0009 half-up at true dpi
(203/25.4 dot/mm); label = absolute layout, receipt = flow layout on the
24-dot line grid (C# `IrWpfPreviewRenderer`-aligned). `warnings` carries
honest degradations: `image-skipped`, `cashDrawer-skipped`,
`unsupported-symbology` (preview v1 supports CODE128/EAN13),
`box-radius-degraded`, `missing-glyph`.

Errors: `missing-presentation` (no label/receipt presentation),
`unsupported-dpi` (only 203/300), `barcode-encode-failed` (bwip-js rejects the
content, e.g. EAN13 must be 12/13 digits), `bad-option`.

## Assets & drift protection

`schemas/*.json` and `examples/*.json` are copied from the repository's
authoritative `schema/` and `fixtures/templates/` by
`scripts/sync-assets.mjs`, which also writes `assets-manifest.json` (sha256 per
file). `npm run build` runs the script in `--check` mode (drift = red build),
and `tests/examples.spec.ts` asserts byte-for-byte equality plus manifest
hashes — package assets can never silently drift from the repo.

## Install & development (workspace protocol trade-off)

The published dependency on the kernel is `"taprint": "workspace:*"` (pnpm
workspace, resolved at publish time). npm does not understand `workspace:*`,
so local development resolves the kernel two ways:

- **tests** resolve `taprint` / `taprint-preview` to package *sources* via the
  `vitest.config.ts` aliases — no builds needed;
- **typecheck / build / smoke** need sibling `dist/` outputs: build them first
  (`cd packages/taprint-ts && npx tsc -p tsconfig.build.json`,
  `cd packages/taprint-preview && npx tsc -p tsconfig.build.json`, both with
  TypeScript ≥ 5.7 — they need `rewriteRelativeImportExtensions`), then
  `pnpm install && pnpm run build` in `apps/mcp` (pnpm links the workspace
  deps; `npm install ../packages/taprint-ts ../packages/taprint-preview
  --no-save` is the npm-flavored equivalent).

Note: the root `pnpm-lock.yaml` is intentionally not committed — pnpm lockfiles
write dependency specifiers as `name@version`, which trips the repository's
forbidden-content scanner (ADR-0006) as false-positive email addresses. Re-run
`pnpm install` locally when needed.

```bash
pnpm install        # from apps/mcp (or the workspace root)
pnpm test           # vitest, 36 cases
pnpm typecheck
pnpm run build      # assets drift check + tsc + shebang fix
node dist/index.js --help
```

## Scope notes (ADR-0008)

- No hardware access, ever: no USB/Bluetooth/spooler, hosts do the printing.
- Preview rasterization is pure JS (`taprint-preview`, M3a): temp-file PNG,
  monochrome threshold (dithering is a follow-up), 203/300 dpi only.
- `smithery.yaml` is a draft for a future registry submission — the server is
  not registered anywhere yet.

License: Apache-2.0 (SPDX headers in every source file).
