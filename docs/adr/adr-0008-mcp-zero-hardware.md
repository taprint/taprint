# ADR-0008: The MCP server has no hardware access and no native dependencies

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Print-related MCP servers that attempt local hardware access (USB,
spoolers, Bluetooth) are hard to install, hard to test, and — as the 2026
ecosystem shows — consistently fail to find adoption. The valuable,
distributable core of the idea is different: let an AI assistant produce
and verify printable output without any printer attached.

## Decision

`taprint-mcp` is pure TypeScript on the `taprint` kernel: zero hardware
access, zero native dependencies (rasterization is pure JS; native canvas
libraries are banned). v0.1 ships three tools — `validate_template`,
`compile`, `list_examples`; `render_preview` joins in v0.3 with the
bitmap engine. Physical printing is explicitly out of scope and stated
as such in the docs.

## Consequences

An `npx` one-liner works everywhere Node runs; in exchange the MCP
cannot print — hosts do that themselves with the compiled byte streams.
