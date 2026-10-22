# ADR-0004: The render service lives in this monorepo

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

A self-hosted HTTP render API (template + data → command streams /
PDF / PNG) was decided to be part of the same product, not a separate
project. Splitting it would fork the renderer versions and the template
contract.

## Decision

`services/render` lives in this monorepo and depends on the Java kernel
package. Its version tracks the kernel minor; its HTTP contract schema
lives under `schema/` next to the template DSL schemas and is shared with
the MCP `compile` tool's response shape, so the two surfaces cannot drift.

## Consequences

One release train for kernel and service; API contract changes are
visible in the same review surface as template-contract changes.
