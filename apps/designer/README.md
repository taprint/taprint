# taprint-designer

Visual print-template designer for the taprint DSL: a full SPA (template
list / designer / version history / lineage pages) plus an embeddable
double mode driven by a signed postMessage host contract.

## Modes

- **full** — standalone SPA with history routing (`/`, `/design/:id`,
  `/versions/:id`, `/lineage/:id`); mounts `#app`.
- **embed** — mounts `#designer-root` via `window.TaprintDesigner`
  (`mount`/`destroy`), intended for host shells (web iframe, WPF/Flutter
  WebView). The host contract — message types, origin allowlist, token
  injection, HMAC signing — is protocol version 2, published as
  [`schema/message-protocol.json`](../../schema/message-protocol.json)
  (neutral names only, ADR-0003/0011).

## Development

```bash
npm install       # from the repository root (workspaces)
npm test          # vitest unit suites (jsdom)
npm run typecheck # vue-tsc --noEmit
npm run build     # schema drift gate + vue-tsc + vite build
npm run test:e2e  # Playwright (chromium); set DESIGNER_E2E_PORT to override 3200
```

## Assets

`schemas/` and `samples/` are build-time copies of the repository's
authoritative `schema/` and `fixtures/templates/` files, produced by
`scripts/sync-assets.mjs` with a sha256 manifest
(`assets-manifest.json`). The copy is verified twice: a `--check` gate
in the build script and hash assertions in `tests/unit/assets.spec.ts`.

## Session transports

`VITE_SESSION_API_BASE` (optional) switches the session/template layer
from the in-memory mock to a real backend over fetch. `VITE_ADMIN_ORIGIN`
(optional) overrides the post-expiry redirect origin; the default is a
neutral placeholder domain.
