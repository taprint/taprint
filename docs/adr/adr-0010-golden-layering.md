# ADR-0010: Golden layers — frame order for everything, bytes for a frozen subset

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Cross-language conformance needs a referee. Byte-equality on every
template would fail CI forever on harmless representation drift;
asserting nothing would let implementations drift silently.

## Decision

Two layers, one shared fixture manifest:

- **L1 — frame/token order:** the ordered sequence of protocol commands
  with their parameters, asserted for every template in every language.
- **L2 — byte digests:** SHA-256 of the exact command stream, asserted
  only for templates inside the frozen coverage matrix
  (`docs/coverage-matrix.md`), which mandates cases for midpoint
  rounding, unmapped-character encoding, float ratios, and every
  feature×protocol cell.

Templates calling host functions (ADR-0007) are excluded from L2. Known
cross-language divergences are recorded in `docs/conformance.md` instead
of failing CI. The Java implementation is the reference generator for
expected outputs; the other three languages compare against it.

## Consequences

CI signal stays meaningful (real regressions fail; documented drift
doesn't), and the conformance document is the honest record of what is
byte-identical versus merely semantically equal.
