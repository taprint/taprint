# ADR-0007: Host functions SPI instead of baked-in business functions

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Template data-binding expressions originally contained business-identity
functions (e.g. `tenantName()`, `storeName()`) wired directly into the
expression engine. That couples a generic rendering kernel to one
product's identity model, and the three existing implementations even
wired it three different ways (expression function vs. injected data
field vs. function value in the data map).

## Decision

The expression engine exposes a **host-function registration SPI** with
one call syntax across all four languages. Each language adapts the
registration shape to its idioms (engine-level function registry, or
function values injected into the data map, or delegate registration).
Unregistered functions fail statically at validation time and explicitly
at evaluation time. Templates that call host functions are excluded from
byte-level goldens (ADR-0010) — the kernel only guarantees parity for its
pure core.

## Consequences

Adopters wire their own domain functions; multi-tenant semantics never
enter this repository. Cross-language parity of host functions is the
adopter's contract, documented but not CI-enforced here.
