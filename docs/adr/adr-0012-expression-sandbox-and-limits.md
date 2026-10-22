# ADR-0012: Expression sandbox and hard resource limits for the render service

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The render service evaluates untrusted templates and untrusted data. An
expression language that permits member-method calls is template-as-code;
unbounded options (dpi × width × copies) turn a render endpoint into a
resource amplifier; a server-side URL-fetch parameter would hand every
caller an SSRF primitive.

## Decision

1. **Sandbox:** expressions are evaluated under an AST allowlist — pure
   functions, literals, property access only; member-method calls and
   imports are rejected. Identical enforcement in all four languages;
   fuzz cases run in CI.
2. **Hard limits,** enforced with explicit 4xx responses: width ≤ 300 mm,
   copies ≤ 200, dpi ∈ {203, 300}, template ≤ 1 MB, wall clock ≤ 10 s,
   output ≤ 50 MB. Rendering runs in a resource-capped worker process.
3. **v1 accepts inline templates only** — no `templateUrl` parameter,
   so the service has no outbound-fetch surface to attack. A signed-URL
   variant can return behind its own ADR if a real need appears.

## Consequences

Some expressions are rejected that a permissive engine would run; the
rejected class (arbitrary method invocation) is exactly the class that
made templates untrusted in the first place.
