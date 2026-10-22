# ADR-0001: ZPL ships only when all four languages have it

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

At extraction time the ZPL renderer exists in only one of the four
implementation languages. Publishing a half-matrix would set the
expectation that ZPL is supported while the other three languages
silently lack it.

## Decision

v0.1 ships with no ZPL anywhere: the Java package is built from a
ZPL-free profile (the sources are not merely feature-flagged), and a CI
guard prevents reintroduction before the gate opens. ZPL lands in v0.2 in
all four languages simultaneously, first as the built-in-font/ASCII route;
the CJK bitmap route (font rasterization shared with the preview engine)
follows as a v0.2.x increment behind its own ADR.

## Consequences

Zebra-centric users must wait for v0.2; the roadmap states this plainly.
In exchange, the cross-language support matrix is always truthful.
