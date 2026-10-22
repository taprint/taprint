# ADR-0011: The designer↔host message protocol ships with the designer (v0.3)

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The kernel's v0.1 release has no embeddable designer yet, so the
postMessage protocol between a host page and the embedded designer would
be a published contract with zero consumers — and any early mistake would
freeze into compatibility obligations before first use.

## Decision

`schema/` carries the template DSL schemas from v0.1; the designer↔host
message-protocol schema ships in v0.3 together with the designer itself,
already renamed under the neutral contract (ADR-0003).

## Consequences

The embed contract's first published version is also its first used
version; no deprecation cycles before there is anyone to deprecate.
