# ADR-0013: Cadence, honest estimates, and a pre-registered cut order

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The project is maintained by one person alongside a primary job. Printed
roadmaps that assume unlimited capacity die by silent abandonment; the
risk isn't competition, it is chronic underinvestment.

## Decision

1. **Versioning:** 0.x releases may break between minors; strict semver
   from 1.0.
2. **Estimates** carry P50/P90 per milestone. If a milestone closes above
   P90, later milestones are re-planned against the **pre-registered cut
   order** instead of slipping silently:
   ZPL CJK bitmap route → channel reference-implementation docs →
   a language tier dropping to community-maintained (announced in the
   README; never claimed as core-supported while unmaintained).
3. **Adoption gates** at 90 days after each artifact's release (external
   device reports verified by a printed-nonce challenge, external
   contributions, external dependents, real MCP usage) trigger an
   explicit go/no-go review; a no-go freezes further milestone spend and
   moves to requirement diagnosis instead of louder publishing.

## Consequences

Slowing down is an announced, ordered degradation — never a zombie
roadmap.
