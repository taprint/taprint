# ADR-0003: Neutral embed-protocol names, no legacy aliases in this repo

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The visual designer's host-embedding contract (window globals, message
types, expression language id) originally carried internal brand strings.
Renaming them is required for a neutral public contract, but an internal
adopter still runs the legacy names in production.

## Decision

The public contract (protocol version 2) uses neutral `taprint` names
exclusively. **No legacy aliases ship in this repository** — compatibility
is the adopter's problem: one internal adopter keeps a private adapter
that maps its legacy global names to the new entry points until its own
migration completes. The adapter's removal is event-driven (migration
done), not tied to a taprint version deadline.

## Consequences

This repo stays free of brand strings (enforced by the forbidden-content
scanner); adopters on legacy names carry a thin adapter for one migration
window.
