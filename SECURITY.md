# Security Policy

## Supported versions

| Version | Support |
|---|---|
| latest 0.x release | security fixes |
| older 0.x releases | best effort, until the next minor ships |

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository
(Security tab). Please do not open public issues for security problems.

Include, where possible:

- affected package(s) and version;
- a minimal template/expression that reproduces the issue;
- expected vs. actual behavior.

## Security-relevant design surfaces

Two areas are hardened by design — bypass reports are especially welcome:

- **Expression sandbox** (ADR-0012): template expressions are evaluated
  under an AST allowlist (pure functions, literals, property access; no
  member-method calls, no imports). The render service evaluates untrusted
  templates, so sandbox escapes are treated as high severity.
- **Resource limits** (ADR-0012): the render service enforces hard caps
  (dimensions, copies, dpi, template size, wall-clock, output size) and
  renders in a resource-capped worker; bypassing a cap is a reportable
  issue.
