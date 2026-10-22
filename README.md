# taprint

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A printer-neutral template DSL for thermal label and receipt printing:
design a template once (JSON, plus a visual designer), compile it to
**ESC/POS**, **TSPL** and **CPCL** command streams — with **ZPL** joining in
v0.2 — and render it identically in **TypeScript, C#, Dart and Java**.

## Status: pre-release scaffold

This repository is being prepared for its first release. No packages are
published yet; the directory layout below is the target shape, and the
roadmap table says what lands when.

## Why

The open-source printing world is split into layers that never touch:
visual template designers that only emit HTML/PDF, protocol libraries that
are single-language and single-protocol with no template concept, and the
label side of the industry (TSPL/CPCL — the native command sets of
mainstream mobile label printers) with almost no maintained open-source
tooling at all, as of October 2026. taprint fills the missing middle:
one template contract, compiled to every target, with byte-level
cross-language conformance gates.

## Roadmap

| Version | Scope |
|---|---|
| v0.1 | DSL schemas + parsers/validators in four languages; ESC/POS + TSPL + CPCL encoders in all four languages; golden conformance harness (frame order + byte digests); `taprint-mcp` with `validate_template` / `compile` / `list_examples` |
| v0.2 | ZPL in all four languages; local preview rendering; published conformance document |
| v0.3 | Visual template designer (standalone + embeddable); bitmap preview engine; MCP `render_preview` tool |
| v0.4 | Self-hosted render service (HTTP API: template + data → command streams / PDF / PNG) |

## Repository layout (planned)

```
schema/          authoritative template DSL JSON Schemas + versioned changelog
fixtures/        shared golden fixtures (frame streams + byte digests)
packages/        per-language implementations: taprint-ts / -cs / -dart / -java
packages/taprint-preview   bitmap preview engine (v0.3)
apps/designer    visual template designer (v0.3)
apps/mcp         MCP server (v0.1, preview tool joins in v0.3)
services/render  self-hosted render API (v0.4)
channels/        reference printer-transport implementations (Windows spooler,
                 Flutter BLE/SPP/TCP-9100) — APIs evolve independently
hardware-notes/  device compatibility reports and protocol quirks
docs/            conformance document, ADRs, coverage matrix
tools/           compliance gates, golden-fixture tooling, release checks
```

## Hardware compatibility

Tested devices and community report process live in
[`hardware-notes/`](hardware-notes/) (from v0.1). Verified so far on real
hardware: an HPRT TP582 thermal label/receipt printer and an Epson LQ-630K
impact printer. Anything not on the list is honest "untested" — we do not
claim support for every printer.

## Security

See [`SECURITY.md`](SECURITY.md). The expression sandbox and the render
service's resource limits are security features by design (ADR-0012).

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
