# taprint

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/taprint/taprint/actions/workflows/ci.yml/badge.svg)](https://github.com/taprint/taprint/actions/workflows/ci.yml)

A printer-neutral template DSL for label, receipt and A4-document
printing: design a template once (JSON — a visual designer joins in a
later release), compile it to **ESC/POS**, **TSPL** and **CPCL** command
streams (**ZPL** lands in v0.2 in all four languages at once), and
render it with the same kernel in **TypeScript, C#, Dart and Java**.
Cross-language parity is pinned by shared golden fixtures, not by
trust.

## What is in the box today (v0.1 scope, pre-tag)

| Piece | Where | State |
|---|---|---|
| Template DSL schemas (v1.0 / v1.1 / v2.0) | `schema/` | authoritative contract, versioned changelog |
| Kernel: parse / validate / migrate / canonicalize | `packages/taprint-{ts,cs,dart,java}` | four languages, 600+ tests green |
| Protocol encoders: ESC/POS + TSPL + CPCL | same packages | four languages (ZPL gated to v0.2 — ADR-0001) |
| PDF rendering (A4 documents) | `packages/taprint-java` | Java only in v0.1 (OpenPDF, MPL-2.0 route) |
| MCP server: `validate_template` / `compile` / `list_examples` / `render_preview` | `apps/mcp` | zero hardware, zero native deps (ADR-0008) |
| Bitmap preview engine (label/receipt → monochrome PNG, 203/300 dpi) | `packages/taprint-preview` | pure JS (opentype.js / bwip-js / pngjs), M3a |
| Windows print channels (spooler RAW / TCP / serial, queue setup, USB probe) | `channels/windows-spooler` | reference implementation |
| Flutter transports (BLE / SPP / TCP-9100) | `channels/flutter-transport` | reference implementation |
| GB18030 full mapping table + oracle | `packages/taprint-dart` | 23,940 code points, generator in `tools/` |
| Device compatibility notes | `hardware-notes/` | ten spooler rules distilled from real POS hardware |

## Quick taste

```bash
# MCP server (Claude Desktop / any MCP client):
npx taprint-mcp            # v0.1 publishes to npm; in-repo: apps/mcp

# TypeScript kernel + encoders:
npm install taprint
```

Ask an MCP client: *"validate this label template"* or *"compile this
receipt template to ESC/POS"* — you get byte streams plus a frame-order
summary, printable by any host on any ESC/POS device.

## Design decisions worth knowing

All architecture decisions live in [`docs/adr/`](docs/adr/). The ones
you will hit first:

- **ZPL gate** (ADR-0001): ZPL ships only when all four languages have
  it — the support matrix is always truthful.
- **Numeric & encoding canon** (ADR-0009): mm→dot rounding is half-away
  from zero and number formatting is pinned, so byte streams agree
  across languages; GB18030 coverage is proven by a code-point oracle,
  not claimed.
- **Golden layering** (ADR-0010): frame-order equality for everything,
  byte digests for a frozen coverage matrix, honest divergence ledger
  in `docs/conformance.md`.
- **Host functions SPI** (ADR-0007): business identity functions are
  registered by the host, never baked into the kernel — multi-tenant
  semantics stay out.
- **Font licensing** (ADR-0002): fonts load through a provider SPI; the
  bundled default is Noto Sans SC (OFL-1.1) with its license intact.

## Hardware compatibility

Verified on real hardware: an HPRT TP582 thermal label/receipt printer
and an Epson LQ-630K impact printer. Everything else is honestly
"untested" until a community report lands — reports require a printed
nonce challenge (proof of hardware). See
[`hardware-notes/`](hardware-notes/).

## License

Apache-2.0. Third-party notices are generated from the SBOM at release
time (ADR-0005).
