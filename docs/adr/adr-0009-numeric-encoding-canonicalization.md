# ADR-0009: Canonical numeric and encoding rules for byte parity

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Four languages cannot agree on byte streams if the representation layer
is undefined. The extracted implementations already disagreed: one used
its platform's banker's rounding for millimeter→dot conversion while the
others rounded half away from zero, so identical templates produced
different coordinates before a single golden test existed.

## Decision

1. **Rounding:** mm→dot conversion is half-up away-from-zero everywhere;
   languages whose default differs (banker's rounding) convert explicitly.
2. **Number formatting:** all numeric fields in command streams use pinned
   fixed-point formats; platform-default float-to-string (shortest
   representation, 15-significant-digit variants) is banned in encoders.
3. **Encoding tables:** the GBK/GB18030 mapping is verified by an
   automated full-codepoint round-trip oracle against platform
   references (JDK / ICU); uncovered characters are replaced with U+FFFD
   and the actual coverage is generated from the oracle, never hand-written.
4. Golden fixtures include midpoints (x.5 dot values), unmapped
   characters, and float-ratio cases so the rules are enforced, not just
   documented.

## Consequences

Languages needing behavior changes migrate once, at v0.1; after that the
rules are part of the public conformance contract.
