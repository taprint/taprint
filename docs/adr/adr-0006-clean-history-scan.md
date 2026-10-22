# ADR-0006: Clean history, forbidden-content scan, negative controls

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The kernel was extracted from a production system whose git history
contains non-public data (real deployments, internal hosts, operational
documents). Importing that history would leak it; hand-cleaning file by
file without a gate would not scale or stay honest.

## Decision

1. **No history import.** The public repository starts from a fresh
   initial commit; nothing from the source systems' history is pushed.
2. **Forbidden-content scan.** Every text file must pass
   `tools/forbidden_scan.py` before commit (CI enforces on every push).
   The scan covers the whole tree outside build directories — including
   configuration layers and schema annotations, which is where internal
   references most often hide.
3. **Negative controls.** `tools/test_compliance.py` plants decoy files
   violating every pattern category in a temporary tree and asserts each
   is caught, plus clean files that must produce zero hits. CI runs the
   self-test before the scan, so a broken scanner cannot fake a clean
   report.
4. **Frozen pattern set.** The rule set is defined in
   `tools/forbidden_scan.py`; changes to it are a governance act requiring
   maintainer sign-off and an updated negative-control test. Exemptions
   are an explicit per-file registry with reasons (currently only the
   scanner and its own test).

## Consequences

Accidental leaks are caught mechanically instead of by memory; the price
is maintaining the pattern set as governance vocabulary evolves.
