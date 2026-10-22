# Changelog

All notable changes to taprint are documented in this file.
The format follows Keep a Changelog; versioning: 0.x releases may break
between minors, strict semver applies from 1.0.

## [Unreleased]

### Added

- Repository scaffold: Apache-2.0 license, community files
  (CODE_OF_CONDUCT, SECURITY), compliance tooling (forbidden-content
  scanner with negative-control self-test, license header gate), CI
  skeleton, ADR seeds 0001–0013, frozen L2 coverage matrix v1.
- `taprint-mcp` v0.1 (apps/mcp, ADR-0008): MCP server on stdio with
  `validate_template` (schema + kernel business rules + host-function
  audit), `compile` (ESC/POS receipt / TSPL / CPCL label byte streams
  with frame summaries), and `list_examples` (6 bundled templates);
  schema/example assets ship in-package with a sync script, sha256
  manifest, and drift-asserting tests.

### Fixed

- Scanner 1.0.2: the email rule no longer flags SCM clone URLs
  (`git@host:org/repo.git` form) — the guard is backtracking-safe
  (`(?![A-Za-z0-9-]*:)`); negative control extended accordingly, and a
  pre-commit hook runs the full compliance gate locally.
