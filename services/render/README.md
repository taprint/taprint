# taprint-render

Self-hosted HTTP render service over the taprint Java kernel: template +
data → ESC/POS / TSPL / CPCL command streams, with hard resource limits and a
sandboxed expression engine by design (ADR-0004, ADR-0012). The service is
best-effort community software — **no SLA is claimed**; capacity planning and
hardening for production deployments are the operator's responsibility.

## API surface (v1, contract: `schema/render-api.json`)

| Endpoint | Method | In | Out |
|---|---|---|---|
| `/v1/render` | POST | `{template, data?, target, options?}` | binary command stream + `X-Render-Meta` header |
| `/v1/preview` | POST | same request shape | PNG (see capability note) |
| `/healthz` | GET | — | `{"status":"ok"}` |

- `target` ∈ `escpos | tspl | cpcl | zpl`. `zpl` is contract-valid but the
  Java kernel does not ship a ZPL renderer yet (ADR-0001) → explicit
  `422 target-unsupported`, never a silent dialect substitution.
- `options.dpi` ∈ `{203, 300}`; `options.widthMm` ≤ 300; `options.copies`
  ∈ `[1, 200]` (label targets only — `escpos` + `copies` is an explicit
  `422 option-not-supported`, mirroring the MCP compile contract).
- **Inline templates only** — there is no `templateUrl` parameter
  (ADR-0012), so the service has no outbound-fetch surface.
- `meta` (`byteCount`, `frameSummary[]`) rides in the `X-Render-Meta`
  response header as ASCII-escaped JSON and shares the MCP `compile`
  response shape, so the two surfaces cannot drift (ADR-0004).
- Preview: PNG rasterization is **outside the current Java kernel
  capability** (kernel emits command streams and PDF only). `/v1/preview`
  answers an explicit `422 preview-unsupported` instead of substituting a
  format; the endpoint flips to 200 automatically once a raster pipeline
  lands in the kernel.

## Hard limits (ADR-0012)

Every limit answers an explicit 4xx, never a silent clamp.

| Limit | Default | Status on exceed |
|---|---|---|
| Template DSL | 1 MiB | `413 template-too-large` |
| Request envelope (template + data) | 9 MiB + 64 KiB | `413 request-too-large` |
| Rendered output | 50 MiB | `413 output-too-large` |
| Wall clock per render | 10 s | `422 wall-clock-exceeded` (worker cancelled; renderers check the interrupt flag between frames) |
| `widthMm` | ≤ 300 | `422 option-out-of-range` |
| `copies` | ≤ 200 | `422 option-out-of-range` |
| `dpi` | ∈ {203, 300} | `422 option-out-of-range` |

Rendering runs in a bounded worker pool (default 4 threads, queue 32). A
saturated pool answers `503 worker-saturated`.

## Status-code discipline

- **400** — syntactic: malformed JSON, missing/wrong-typed fields, unknown
  target value.
- **413** — size caps (above).
- **422** — well-formed but unprocessable: option ranges, target unsupported,
  `sandbox-violation`, `template-invalid`, `missing-presentation`,
  `render-failed`, `wall-clock-exceeded`, `preview-unsupported`.
- **401** — auth failures (`missing-api-key` / `invalid-api-key`).
- Errors use one envelope: `{"error":{"code","message","details"?}}`.

## Sandbox

Expressions are evaluated under the kernel's AST allowlist (QLExpress4
`StrategyIsolation`: literals, pure functions, property access only; member
method calls, constructors, static access and imports are rejected). On top,
the service front-gate (`SandboxGate`) runs the kernel's own
`ExpressionAudit` function whitelist — **no host functions are registered by
default** (`HostFunctions.EMPTY`), so templates calling unregistered
functions fail explicitly — and rejects statement-shaped input the kernel
would otherwise tolerate (`import`, `new`, `;`, `@`, assignments) inside
`{{ ... }}` placeholders. A fuzz corpus of 18 escape payloads (member calls,
java.lang escapes, import chains, static-access syntax, prototype-escape
string variants) runs in CI asserting every one is rejected with 422 and two
negative controls proving whitelisted expressions still render.

## Running

The monorepo has no root Maven aggregator, so build the kernel into the
local repository first:

```bash
mvn -B -f packages/taprint-java/pom.xml install -DskipTests
mvn -B -f services/render/pom.xml spring-boot:run
```

Tests:

```bash
mvn -B -f packages/taprint-java/pom.xml install -DskipTests
mvn -B -f services/render/pom.xml test
```

### Docker (multi-stage, non-root)

```bash
docker build -t taprint-render -f services/render/Dockerfile .
docker run --rm -p 8080:8080 \
  -e TAPRINT_RENDER_API_KEYS=change-me \
  --memory=1g --cpus=2 \
  --ulimit nofile=256:256 \
  taprint-render
```

The image is temurin 17-jre, runs as uid 10001, and takes `JAVA_OPTS` for
JVM sizing (`-XX:MaxRAMPercentage=75.0` by default). Resource caps
(`--memory`, `--cpus`) are runtime samples — tune for your host.

## Authentication — read this before exposing the service

Auth is **off by default**. Set keys via the environment:

```bash
TAPRINT_RENDER_API_KEYS=key1,key2   # clients send: X-API-Key: key1
```

While the key list is empty, every `/v1/*` request is accepted without
credentials. That is acceptable only for loopback evaluation. **Exposing the
service on any shared or public network without `TAPRINT_RENDER_API_KEYS`
set is strongly discouraged** — rendering is a compute resource and the
template language is attacker-controlled input. `/healthz` always stays
open for liveness probes.

## Configuration

| Property | Env | Default |
|---|---|---|
| `taprint.render.api-keys` | `TAPRINT_RENDER_API_KEYS` | empty (auth off) |
| `taprint.render.wall-clock-millis` | — | 10000 |
| `taprint.render.template-max-bytes` | — | 1048576 |
| `taprint.render.output-max-bytes` | — | 52428800 |
| `taprint.render.worker-pool-size` | — | 4 |

See `application.yml` for the full list.
