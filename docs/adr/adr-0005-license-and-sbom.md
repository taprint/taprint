# ADR-0005: Apache-2.0, SBOM-generated third-party notices

- **Status:** Accepted
- **Date:** 2026-10-22

## Decision

The project is licensed Apache-2.0. Third-party notices are generated
from an SBOM (CycloneDX) as part of every release rather than maintained
by hand, covering every runtime dependency across the four language
ecosystems and the designer's frontend stack.

Notable third-party stances:

- **OpenPDF** is consumed as an unmodified jar under its
  `MPL-2.0 OR LGPL-2.1+` dual license (MPL route chosen); modifying any
  of its source lines triggers file-level MPL obligations, so this project
  never forks it — upstream patches or replace.
- Permissive dependencies (MIT / BSD / MulanPSL-2) are listed with their
  license texts in the generated notices.
- Fonts follow ADR-0002.

## Consequences

The release pipeline must generate and attach the SBOM; a CI check fails
the build when a new dependency appears without entering the notice set.
