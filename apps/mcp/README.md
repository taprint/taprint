# taprint-mcp

MCP server for the [taprint](https://github.com/taprint/taprint) print-template DSL:
`validate_template`, `compile`, `list_examples` (v0.1, ADR-0008). Zero printer /
hardware access, zero native dependencies — an `npx` one-liner works everywhere
Node runs. Preview rasterization (`render_preview`) arrives in v0.3; **physical
printing is permanently out of scope** — hosts print the compiled byte streams
themselves.

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

- **tests / typecheck** resolve `taprint` to the kernel *source* via the
  `vitest.config.ts` alias and `tsconfig` `paths` — no kernel build needed;
- **build / smoke** need the kernel `dist/`: build it first
  (`cd packages/taprint-ts && npx -y -p typescript tsc -p tsconfig.build.json`
  with TypeScript ≥ 5.7 — the kernel needs `rewriteRelativeImportExtensions`),
  then `pnpm install && pnpm run build` in `apps/mcp` (pnpm links the workspace
  dep; `npm install ../packages/taprint-ts --no-save` is the npm-flavored
  equivalent).

Note: the root `pnpm-lock.yaml` is intentionally not committed — pnpm lockfiles
write dependency specifiers as `name@version`, which trips the repository's
forbidden-content scanner (ADR-0006) as false-positive email addresses. Re-run
`pnpm install` locally when needed.

```bash
pnpm install        # from apps/mcp (or the workspace root)
pnpm test           # vitest, 32 cases
pnpm typecheck
pnpm run build      # assets drift check + tsc + shebang fix
node dist/index.js --help
```

## Scope notes (ADR-0008)

- No preview / rasterization in v0.1 (`render_preview` is v0.3).
- No hardware access, ever: no USB/Bluetooth/spooler, hosts do the printing.
- `smithery.yaml` is a draft for a future registry submission — the server is
  not registered anywhere yet.

License: Apache-2.0 (SPDX headers in every source file).
