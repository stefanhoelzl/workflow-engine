# Security Model

This document is the authoritative threat model for this workflow engine. It
is written **primarily for AI coding agents** to consult when adding or
modifying security-sensitive code. Human contributors are welcome readers,
but the prose is optimized for machine consumption: explicit rules, clear
trust boundaries, and enumerated threats per attack surface.

## How to use this document

Before writing or reviewing code that touches security-sensitive areas,
consult the relevant section:

- **Adding or modifying a sandbox global / host bridge API** → §2 Sandbox
  Boundary
- **Adding or changing an HTTP route** → determine trust level first
  (§3–§4)
- **Adding a new webhook handler or trigger type** → §3 Webhook Ingress
- **Changing authentication, authorization, or route protection** → §4
  Authentication
- **Changing container, network, or secret configuration** → §5
  Infrastructure and Deployment

Each section below follows the same structure:

1. **Trust level** — classification of what crosses this boundary.
2. **Entry points** — concrete routes, APIs, or code paths.
3. **Threats** — what can go wrong.
4. **Mitigations** — what is in place today.
5. **Residual risks** — known gaps (labelled `v1 limitation`, `High
   priority`, or `Accepted`).
6. **Rules for AI agents** — hard invariants that must not be violated.
7. **File references** — relevant source and spec files.

Compact invariants also appear in `CLAUDE.md`. `SECURITY.md` is the full
reference.

Section numbering (§1..§5) is stable. Future edits that introduce new
sections must append (§6 and onward), not renumber.

## §1 Trust boundaries overview

```
                         Internet (untrusted)
                                │
                                ▼
                     ┌──────────────────────┐
                     │   Traefik Ingress    │  TLS termination
                     │   (websecure :443)   │
                     └──────────┬───────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
  /webhooks/*           /dashboard, /trigger        /api/*
  PUBLIC                oauth2-proxy forward-auth   App middleware:
  (intentional)         (GitHub OAuth)              Bearer + GITHUB_USER
        │                       │                       │
        ▼                       ▼                       ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                  Runtime (Node.js, Hono)                    │
  │                                                             │
  │   ┌──────────────┐    ┌──────────────┐   ┌──────────────┐   │
  │   │ Webhook      │    │ UI (dashboard│   │ API handlers │   │
  │   │ handlers     │    │  + trigger)  │   │              │   │
  │   └──────┬───────┘    └──────────────┘   └──────────────┘   │
  │          │                                                  │
  │          ▼                                                  │
  │   ┌──────────────┐   EventBus   ┌──────────────────────┐    │
  │   │ Event source │─────────────►│ Action scheduler     │    │
  │   └──────────────┘              └──────────┬───────────┘    │
  │                                            │                │
  │                                 ══════════ ▼ ══════════     │
  │                                 Sandbox boundary (WASM)     │
  │                                 ┌──────────────────────┐    │
  │                                 │ QuickJS WASM context │    │
  │                                 │  (UNTRUSTED action)  │    │
  │                                 │   ctx.emit / fetch   │    │
  │                                 └──────────────────────┘    │
  └─────────────────────────────────────────────────────────────┘
                                │
                                ▼
                   ┌──────────────────────────┐
                   │  Internal K8s services   │
                   │  (S3 storage, GitHub     │
                   │   API for auth checks)   │
                   └──────────────────────────┘
```

| # | Surface | Trust level | Entry points | Auth mechanism | Section |
|---|---------|-------------|--------------|----------------|---------|
| 1 | Sandbox | **UNTRUSTED** (user-authored action code) | `sandbox.spawn(source, ctx)` | Isolation, not auth | §2 |
| 2 | Webhook ingress | **PUBLIC** (intentionally unauthenticated) | `POST /webhooks/{name}` | None — payload-schema validation only | §3 |
| 3 | UI / API | **AUTHENTICATED** | `/dashboard`, `/trigger`, `/api/*` | oauth2-proxy (GitHub) for UI; Bearer (GitHub) for API | §4 |
| 4 | Infrastructure | **INTERNAL** | K8s pods, Secrets, S3, Traefik | K8s RBAC, pod network | §5 |

**Trust-level semantics** (applies across the whole document):

- **UNTRUSTED** — Code or data that the runtime must assume is hostile.
  Never granted direct access to host APIs, filesystem, process, or
  un-allowlisted network destinations.
- **PUBLIC** — Accepts requests from anyone on the Internet. Must validate
  payloads; must not trust any request metadata.
- **AUTHENTICATED** — Caller identity is established by a named mechanism.
  Authorization is a separate check.
- **INTERNAL** — Cluster-local, reachable only by other pods. Not exposed
  externally. Not a substitute for authentication at the app level.

## §2 Sandbox Boundary

### Trust level

**UNTRUSTED.** All code inside `sandbox.spawn(source, ctx)` is
user-authored action code. Treat it as hostile: it may attempt to read
host state, reach network services it shouldn't, run indefinitely, or
exfiltrate secrets through any channel available to it.

The sandbox is **the single strongest isolation boundary in the system**.
Most security decisions in this document reduce to: *does this expose
new capability across the sandbox boundary?*

### Entry points

- `sandbox.spawn(source, ctx)` — executes action source in a fresh
  QuickJS WASM context with a bridged `ctx` object.
- Globals exposed inside the sandbox: `console.*`, `performance.now`,
  `crypto.*` (full WebCrypto), `setTimeout` / `setInterval` /
  `clearTimeout` / `clearInterval`, `ctx.event`, `ctx.env`, `ctx.emit`,
  `fetch` (via `__hostFetch` bridge).
- No other globals are present. `process`, `require`, `fs`, and Node
  APIs are absent.

### Threats

| ID | Threat | Category |
|----|--------|----------|
| S1 | Action escapes sandbox by manipulating the host bridge (e.g. forging promise resolution, re-entering host code) | Elevation of privilege |
| S2 | Action consumes unbounded memory in the WASM heap, starving the host | DoS |
| S3 | Action runs an infinite loop, blocking the host event loop on the `vm.evalCode` call | DoS |
| S4 | Action schedules infinite timers to keep the host pumping jobs | DoS |
| S5 | Action uses `ctx.fetch` / `__hostFetch` to reach internal K8s services, cloud metadata endpoints, or private network ranges (SSRF) | Information disclosure / EoP |
| S6 | Action reads secrets via `ctx.env` that were declared by another workflow's action | Information disclosure |
| S7 | Action exfiltrates event data or secrets via `ctx.emit` payloads that are later indexed, logged, or stored | Information disclosure |
| S8 | Action generates cryptographic material and exports it through `ctx.emit` or `ctx.fetch` | Information disclosure |
| S9 | A new host-bridge API is added that accepts a raw host-object reference, allowing reflection / mutation of host state | Elevation of privilege |

### Mitigations (current)

- **Fresh context per invocation.** `newRuntime()` + `newContext()` are
  called on every `spawn`; `vm` and `runtime` are disposed in a
  `finally` block. No state survives across actions.
  (`packages/runtime/src/sandbox/index.ts`)
- **No Node.js surface.** QuickJS WASM has no built-in `process`,
  `require`, `fs`, `child_process`, or network APIs. Only the explicit
  globals set in `packages/runtime/src/sandbox/globals.ts` are present.
- **Allowlist of globals.** Adding a global requires editing `globals.ts`
  explicitly — there is no dynamic extension path.
- **Event and env are JSON-serialized.** `ctx.event` and `ctx.env` are
  injected via `vm.evalCode` with `JSON.stringify`. The sandbox receives
  a copy; mutations inside do not leak out.
  (`packages/runtime/src/sandbox/bridge.ts` lines 16–47)
- **Per-action env scoping.** `ctx.env` exposes only the keys declared by
  that action's `env` record. Other workflows' env vars are not reachable
  (mitigates S6 at the host side).
- **Emit payload validation.** `ctx.emit(type, payload)` is validated
  against the declared Zod schema in the host before the event is
  published (limits S7 to schema-shaped data).
  (`packages/runtime/src/event-source.ts`)
- **Static analysis.** TypeScript strict mode and Biome `all` rules are
  enabled to catch unsafe bridge patterns early.

### Residual risks

These are **known gaps**. AI agents must not assume protection where none
exists. Each item should be tracked as a follow-up security task.

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-S1 | No QuickJS `setMemoryLimit()` wired | S2 unmitigated | v1 limitation |
| R-S2 | No QuickJS interrupt handler / execution timeout | S3 unmitigated | v1 limitation |
| R-S3 | Host timers (`setTimeout` / `setInterval`) run on the Node event loop with no per-spawn cap | S4 unmitigated | v1 limitation |
| R-S4 | `__hostFetch` has **no URL allowlist/denylist** at the app layer — the sandbox can reach any public URL the pod can reach. Infrastructure half (RFC1918 + cloud metadata) closed by K8s NetworkPolicy (§5). Public URL allowlist is a pending app-layer control. | S5 partial | **High priority** (app-layer half) |
| R-S5 | K8s `NetworkPolicy` on the runtime pod restricts cross-pod traffic and blocks RFC1918 + link-local egress | S5 in-cluster / metadata half mitigated | **Resolved** (see §5 R-I1 / R-I9) |
| R-S6 | Action `env` is resolved at build time; secrets baked into the action's declared env appear in event logs if emitted back out via `ctx.emit` | S7 partial | Behavioural; document per-action |

### Rules for AI agents

1. **NEVER add a new global to the sandbox without updating this section
   and the threat list.** New globals expand the attack surface by
   definition.
2. **NEVER pass a live host-object reference into the sandbox.** Only
   JSON-serializable snapshots cross the boundary. If a new bridge API
   needs to accept data from the sandbox, receive it as a string or
   number and validate it with Zod on the host side before acting on it.
3. **NEVER expose Node.js APIs, `process`, `require`, or filesystem
   access to sandbox code** — directly or through a bridge wrapper.
4. **NEVER reuse a sandbox context across invocations.** Fresh
   `newRuntime()` + `newContext()` per `spawn`; always dispose in a
   `finally` block.
5. **NEVER return a host `Promise`'s original reference to the sandbox.**
   Use the existing `bridge-factory` deferred-promise pattern, which
   translates host results through `vm.newPromise()`.
6. **When adding an outbound capability (fetch, emit, etc.), explicitly
   consider SSRF and exfiltration.** If there is no URL allowlist today,
   say so in the change proposal; do not claim the sandbox "prevents"
   the action from reaching an internal service.
7. **Sandbox-related changes MUST include security tests** (per
   `openspec/config.yaml` task rules) covering: escape attempts, global
   visibility, context disposal, and any new bridge API's failure modes.

### File references

- Sandbox factory: `packages/runtime/src/sandbox/index.ts`
- Host bridge (ctx): `packages/runtime/src/sandbox/bridge.ts`
- Bridge factory (promise / host-function plumbing): `packages/runtime/src/sandbox/bridge-factory.ts`
- Globals allowlist: `packages/runtime/src/sandbox/globals.ts`
- WebCrypto bridge: `packages/runtime/src/sandbox/crypto.ts`
- Payload validation: `packages/runtime/src/event-source.ts`
- OpenSpec spec: `openspec/specs/action-sandbox/spec.md`
- OpenSpec spec: `openspec/specs/context/spec.md`

## §3 Webhook Ingress

### Trust level

**PUBLIC.** `POST /webhooks/{name}` is reachable by anyone on the
Internet without authentication. This is an **intentional design
choice**: webhooks are how external systems deliver events. Do not add
authentication here without an OpenSpec change proposal — existing
integrations depend on unauthenticated ingress.

Everything received on this surface must be treated as
attacker-controlled: body, headers, query string, URL parameters, and
timing.

### Entry points

- `POST /webhooks/{trigger_name}` with JSON body.
- Path matching via URLPattern; supports `:param` path segments. Static
  segments are prioritized over parameterized
  (`packages/runtime/src/triggers/http.ts` lines 86–121).
- Request data delivered to the action as `ctx.event.payload`:

  ```typescript
  { body, headers, url, method, params, query }
  ```

### Threats

| ID | Threat | Category |
|----|--------|----------|
| W1 | Attacker sends malformed JSON or schema-violating payload to crash the handler or poison the event store | Tampering |
| W2 | Attacker sends a very large payload, exhausting memory or stream buffers | DoS |
| W3 | Attacker floods an endpoint with high-rate requests | DoS |
| W4 | Attacker impersonates a legitimate upstream (e.g. GitHub, Stripe) — no signature verification | Spoofing |
| W5 | Attacker injects headers (`Authorization`, `Cookie`, `X-Forwarded-*`) that action code treats as trusted | Spoofing / information disclosure |
| W6 | Attacker probes path variants to discover registered trigger names | Information disclosure |
| W7 | Attacker sends a payload that matches schema but triggers expensive downstream fan-out (event storm) | DoS |
| W8 | Query-string or URL-parameter injection, passed unsanitized into action code | Tampering |

### Mitigations (current)

- **Zod runtime validation** on the `body` against the trigger's
  declared event schema. Invalid payloads return **422** with issue
  details and never reach the sandbox.
  (`packages/runtime/src/event-source.ts` lines 37–68;
  `packages/runtime/src/triggers/http.ts` lines 186–197)
- **Payload scope reaches the sandbox only via events**, so any
  downstream code that consumes the payload runs in the sandbox with no
  host APIs (see §2).
- **TLS termination at Traefik** (HTTPS only on the websecure
  entrypoint).
- **Deterministic path matching** via URLPattern; static segments beat
  parameterized, reducing ambiguity.
- **Separate trust domain** — webhook handlers cannot read the session
  cookies or bearer tokens used by the UI / API routes, because those
  headers are not forwarded to this route family.

### Residual risks

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-W1 | **No signature verification** on incoming payloads (HMAC, GitHub signature, Stripe signature, etc.) | W4 unmitigated | v1 limitation; add per-integration |
| R-W2 | **No payload size limit** configured at the application or Traefik level | W2 unmitigated | v1 limitation |
| R-W3 | **No rate limiting** at the application or Traefik level | W3, W7 unmitigated | v1 limitation |
| R-W4 | **All request headers are forwarded verbatim** into the event payload's `headers` field, including any `Authorization` / `Cookie` the caller sent | W5 unmitigated | **High priority** — move to per-trigger header allowlist |
| R-W5 | Trigger names are reflected in 404 vs 422 vs 200 response differences, enabling enumeration | W6 low | Accepted; triggers are not secret |
| R-W6 | Query-string and path parameters are placed unsanitized into `ctx.event.payload.query` / `.params` | W8 partial | Mitigated by sandbox (§2), but authors must still treat as untrusted |

### Implementation guidance for signed webhooks

When adding signature verification for a specific integration (e.g.
GitHub webhooks, Stripe webhooks), implement the verifier as a
**pre-validation step in the handler** — before Zod validation — and
reject unsigned or incorrectly signed requests with 401 before any
event is emitted. Store the signing secret as a K8s Secret per §5,
never in the trigger definition. The verifier must not skip the Zod
schema check; a valid signature on a schema-violating payload still
returns 422.

### Rules for AI agents

1. **NEVER add authentication to `/webhooks/*` without an explicit
   OpenSpec proposal.** Public ingress is deliberate.
2. **NEVER strip the Zod validation step** between the incoming request
   and event emission. It is the only pre-sandbox filter.
3. **NEVER treat webhook payload metadata (headers, IP, query string)
   as authenticated.** Even if a caller sets `Authorization: Bearer
   …`, that header is just user input on this surface.
4. **ALWAYS define a Zod schema for new webhook event types.** A
   trigger without a schema is a trigger that accepts arbitrary
   untrusted JSON.
5. **When adding signature verification for a specific integration**,
   follow the "Implementation guidance for signed webhooks" above —
   verifier in the handler, before Zod, never in action code.
6. **DO NOT extend the webhook payload shape** (`body` / `headers` /
   `url` / `method` / `params` / `query`) without updating this section
   and the `triggers` spec. New fields expand what untrusted data
   reaches the sandbox.
7. **When adding a new trigger type**, decide its trust level first:
   public (like HTTP webhooks) → §3 rules apply; authenticated
   (scheduled, internal) → document separately.

### File references

- Webhook handler: `packages/runtime/src/triggers/http.ts`
- Event source / payload validation: `packages/runtime/src/event-source.ts`
- Trigger registry: `packages/runtime/src/triggers/`
- Traefik routing: `infrastructure/modules/workflow-engine/modules/routing/routing.tf`
- OpenSpec spec: `openspec/specs/triggers/spec.md`
- OpenSpec spec: `openspec/specs/payload-validation/spec.md`

## §4 Authentication

### Trust level

**AUTHENTICATED** — but with different mechanisms and different trust
chains for different routes. This section is the most nuanced: a single
mistake in wiring (a missing env var, a bypassed middleware, a trusted
forwarded header) can collapse the whole auth boundary.

Two distinct auth surfaces:

1. **UI routes** (`/dashboard`, `/trigger`, and any future authenticated
   UI prefix) — authenticated by **oauth2-proxy** at the **Traefik
   forward-auth** layer. The application receives
   `X-Auth-Request-User` and `X-Auth-Request-Email` headers and trusts
   them.
2. **API** (`/api/*`) — authenticated **in the application** by
   `githubAuthMiddleware`, which validates a Bearer token against
   `https://api.github.com/user` and checks the login against a
   comma-separated allow-list configured via the `GITHUB_USER` env
   var. The middleware operates in one of three modes
   (`restricted` / `disabled` / `open`) resolved from config at
   startup — see §4 Mitigations and the `github-auth` spec.

"UI" is used throughout this section as the category name (rather than
"Dashboard") because the trust domain spans `/dashboard`, `/trigger`,
and any future authenticated UI prefix.

### Entry points

| Route family | Auth mechanism | Enforced by | Bypass check |
|---|---|---|---|
| UI routes (`/dashboard`, `/trigger`, future UIs) | GitHub OAuth2 via oauth2-proxy | Traefik `ForwardAuth` middleware | Any new UI prefix must be added to the forward-auth-protected list |
| `/api/*` | GitHub Bearer token + allow-list; three modes (`restricted` / `disabled` / `open`) | App-level middleware, always registered | `disabled` (fail-closed 401) when allow-list is missing; `open` requires the explicit `__DISABLE_AUTH__` sentinel |
| `/webhooks/*` | **None (PUBLIC)** | Intentional | See §3 |
| `/static/*`, `/livez`, `/` | None | Intentional | Must stay non-sensitive |
| `/oauth2/*` | N/A (OAuth2 callback itself) | oauth2-proxy | Never add application logic on these paths |

### Threats

| ID | Threat | Category |
|----|--------|----------|
| A1 | Attacker steals a session cookie (XSS, shared device) and accesses a UI route | Spoofing |
| A2 | Attacker steals a Bearer token and accesses `/api/*` | Spoofing |
| A3 | Request bypasses Traefik and reaches the app pod directly, sending forged `X-Auth-Request-User` | Spoofing / EoP |
| A4 | A new authenticated route is added but not wired through the forward-auth middleware | EoP |
| A5 | Deployment sets the `__DISABLE_AUTH__` sentinel in production (intended for local dev only), opting `/api/*` into `open` mode and reaching the handler unauthenticated | EoP |
| A6 | oauth2-proxy cookie secret is leaked or reused across deployments, enabling cookie forgery | Spoofing |
| A7 | GitHub API is unreachable; `/api/*` returns 401 for all callers (availability) | DoS |
| A8 | GitHub API rate-limits the application's IP (no caching of token validation) | DoS |
| A9 | Bearer token is logged via request / response logging or included in an event payload | Information disclosure |
| A10 | User is removed from the `GITHUB_USER` / `OAUTH2_PROXY_GITHUB_USERS` allowlist but an existing session cookie stays valid until expiry | EoP (stale access) |
| A11 | Open redirect via `/oauth2` callback parameters | Spoofing (phishing) |

### Mitigations (current)

- **HTTPS-only cookies** (`OAUTH2_PROXY_COOKIE_SECURE=true`) — cookies
  are not sent over plain HTTP.
  (`infrastructure/modules/workflow-engine/modules/oauth2-proxy/oauth2-proxy.tf` line 166)
- **Per-deployment random cookie secret** (32 bytes, generated at apply
  time, stored in a K8s Secret, marked sensitive).
- **Single-source-of-truth allow-list.** The Terraform
  `oauth2.github_users` variable feeds both `OAUTH2_PROXY_GITHUB_USERS`
  (UI) and `GITHUB_USER` (API), so the UI and API authorize the same
  set of GitHub logins by construction.
  (`infrastructure/modules/workflow-engine/modules/app/app.tf`;
  `infrastructure/modules/workflow-engine/modules/oauth2-proxy/oauth2-proxy.tf`)
- **Multi-user API allow-list.** `GITHUB_USER` is parsed as a
  comma-separated list (pflag `StringSlice` parity with oauth2-proxy);
  any login in the list is accepted. Matching is case-sensitive.
- **Fail-closed three-mode API middleware.** The API middleware is
  **always registered** and resolves to one of three modes from config
  at startup: `restricted` (token validated + login on allow-list),
  `disabled` (every request → 401, no outbound call to GitHub),
  `open` (middleware not installed). Unset `GITHUB_USER` →
  `disabled`; the explicit sentinel `__DISABLE_AUTH__` → `open`.
  A missing config **never** silently opens the API.
  (`packages/runtime/src/api/auth.ts`; `packages/runtime/src/config.ts`;
  `openspec/specs/github-auth/spec.md`,
  `openspec/specs/runtime-config/spec.md`)
- **Allow-list enumeration protection.** All negative outcomes in
  `restricted` mode (missing header, invalid token, wrong login,
  GitHub network error) return `401 Unauthorized` with an identical
  body; the status code does not distinguish "wrong user" from "bad
  token", preventing enumeration by holders of valid PATs.
- **Startup-logged auth mode.** The runtime emits a log record at
  startup identifying the effective `githubAuth.mode`, at `warn` level
  for `disabled` or `open`. Misconfigured deployments are visible in
  logs immediately.
- **Per-request token validation against GitHub** for the API — no
  long-lived stale sessions; a revoked GitHub token is rejected on the
  next request.
  (`packages/runtime/src/api/auth.ts`)
- **TLS termination at Traefik** — session cookies and Bearer tokens are
  not in cleartext on the wire.
- **Forward-auth integration** — Traefik calls oauth2-proxy's
  `/oauth2/auth` endpoint on every UI request; unauthenticated requests
  are redirected to the sign-in flow.
- **Separate trust domains for UI vs API** — the UI's cookie does not
  authenticate the API; the API's Bearer token does not sign a UI
  session.

### Residual risks

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-A1 | The `__DISABLE_AUTH__` sentinel exists for local development; a production deployment that sets it puts `/api/*` into `open` mode. The `warn`-level startup log is the only guard against accidental production use. | A5 | Mitigated by operational discipline and startup logs; consider refusing `open` mode when a production marker is set |
| R-A2 | No caching of GitHub token validation — every `/api/*` request makes a live GitHub API call. Exposes the application to GitHub availability and rate limits (A7, A8). | High | Design follow-up |
| R-A3 | K8s `NetworkPolicy` restricts app-pod ingress on `:8080` to Traefik pods only (`app.kubernetes.io/name=traefik`) plus the UpCloud node CIDR for kubelet probes. Forged `X-Auth-Request-User` from a neighbouring pod is no longer possible. | High | **Resolved** (see §5 R-I1) |
| R-A4 | Forwarded-header trust is implicit — the application does not verify requests came via Traefik / oauth2-proxy; it just reads `X-Auth-Request-User`. Now load-bearing on the NetworkPolicy from R-A3 to ensure only Traefik is a legitimate source. | Medium | Accepted given R-A3 resolution |
| R-A5 | No logout-on-allowlist-removal — removing a user from `OAUTH2_PROXY_GITHUB_USERS` does not invalidate existing sessions until cookie expiry. | Low-Medium | Accept or add session store |
| R-A6 | No explicit request / response logging policy for `Authorization` headers — nothing guarantees tokens are redacted from pino logs. | Medium | Verify logger config |
| R-A7 | GitHub OAuth is the only identity provider — no local fallback, no MFA enforcement beyond what GitHub offers. | Accepted | By design |
| R-A8 | No CSRF tokens on state-changing UI routes — session cookie is the only auth; if any cross-site POST is possible, forms could be submitted cross-origin. | TBD | Audit UI mutations |

### Rules for AI agents

1. **NEVER add a UI route (under `/dashboard`, `/trigger`, or any new
   authenticated UI prefix) without confirming the Traefik
   `oauth2-forward-auth` middleware applies to it.** Check
   `infrastructure/modules/workflow-engine/modules/routing/routing.tf`.
2. **NEVER add a route under `/api/` without the `githubAuthMiddleware`
   in front of it.**
3. **NEVER trust `X-Auth-Request-User`, `X-Auth-Request-Email`, or any
   `X-Forwarded-*` header as authoritative outside the current
   NetworkPolicy assumption.** The §5 `NetworkPolicy` restricts ingress
   on app `:8080` and oauth2-proxy `:4180` to Traefik pods only (plus
   the node CIDR for kubelet probes). Any change that weakens the
   NetworkPolicy selectors — e.g. relaxing the Traefik pod-label
   `app.kubernetes.io/name=traefik` — collapses this trust and MUST be
   flagged in the same review.
4. **NEVER log, emit, or store** the `Authorization` header, a session
   cookie, or an OAuth client secret. When adding new logging,
   explicitly allowlist which request fields go to logs.
5. **NEVER add a silent short-circuit for auth in development.** The
   only supported dev bypass is the explicit `__DISABLE_AUTH__`
   sentinel, which opts into `open` mode *visibly* (warn log at
   startup, documented in the `github-auth` spec). Do not introduce
   new implicit bypasses (env checks, `NODE_ENV`, debug flags).
6. **When adding a new config gate for auth enforcement**, make it
   fail-closed by default and visible at startup (warn-level log when
   the weaker mode is active). Document the gate and its three modes
   here so future agents can reason about it without reading code.
7. **Bearer tokens and session cookies live at different trust levels**
   — never design a feature that accepts either interchangeably. Pick
   one per surface.

### File references

- API auth middleware: `packages/runtime/src/api/auth.ts`
- Config / env: `packages/runtime/src/config.ts`
- API wiring: `packages/runtime/src/api/index.ts`
- UI header-trust middleware: `packages/runtime/src/ui/dashboard/middleware.ts`
- oauth2-proxy deployment: `infrastructure/modules/workflow-engine/modules/oauth2-proxy/oauth2-proxy.tf`
- Traefik routing / forward-auth: `infrastructure/modules/workflow-engine/modules/routing/routing.tf`
- OpenSpec spec: `openspec/specs/dashboard-auth/spec.md`
- OpenSpec spec: `openspec/specs/dashboard-middleware/spec.md`
- OpenSpec spec: `openspec/specs/github-auth/spec.md`
- OpenSpec spec: `openspec/specs/oauth2-proxy/spec.md`
- OpenSpec spec: `openspec/specs/runtime-config/spec.md`

## §5 Infrastructure and Deployment

### Trust level

**INTERNAL** — components that run inside the Kubernetes cluster, not
directly exposed to the Internet. "Internal" is **not** a substitute for
authentication: a compromised pod, a missing NetworkPolicy, or a rogue
workload can reach everything else in the cluster.

This section covers the current dev stack and production deployment
requirements (noted inline). The production target is an UpCloud K8s
cluster; see `openspec/specs/infrastructure/spec.md`.

### Entry points

| Component | Exposure | Port | Who can reach it |
|---|---|---|---|
| Traefik Ingress (HTTPS) | Public (LB → 443, NodePort 30443 → 443 in dev) | 443 | Internet |
| Traefik Ingress (HTTP) | Public (LB → 80) | 80 | Internet — redirects to HTTPS, plus serves `/.well-known/acme-challenge/*` to cert-manager's HTTP-01 solver |
| oauth2-proxy | In-cluster Service | 4180 | Traefik (forward-auth) |
| App (runtime) | In-cluster Service | 8080 | Traefik; **any pod** (no NetworkPolicy) |
| S2 (S3-compatible storage) | In-cluster Service | 9000 | App pod; **any pod** (no NetworkPolicy) |
| cert-manager controllers | In-cluster Service (webhook) | 9402 | kube-apiserver (admission webhooks) |
| DuckDB | Process-local | — | App process only (in-memory) |
| GitHub API | External egress | 443 | App pod (auth validation) |
| Let's Encrypt ACME (egress) | External egress | 443 | cert-manager (prod only, issuance + renewal) |

### Threats

| ID | Threat | Category |
|----|--------|----------|
| I1 | K8s Secret is leaked via logs, etcd snapshots, or a pod with broad RBAC read | Information disclosure |
| I2 | A compromised pod or sidecar reaches the app pod's `:8080` directly, bypassing Traefik and forging `X-Auth-Request-User` (A3 from §4) | EoP |
| I3 | A compromised pod or action (via SSRF, §2) reaches cloud metadata endpoints (e.g. `169.254.169.254`) or internal admin APIs | Information disclosure / EoP |
| I4 | App container runs with unnecessary capabilities, a writable root filesystem, or as a privileged user | EoP |
| I5 | No resource limits → a runaway action or memory leak crashes the node, not just the pod | DoS |
| I6 | OAuth2 client secret or S3 credentials committed to a `.tfvars` file checked into git | Information disclosure |
| I7 | Traefik accepts weak TLS ciphers or outdated TLS versions | Tampering / eavesdropping |
| I8 | Self-signed dev cert used in production by mistake | Spoofing |
| I9 | S3 bucket policy permits unintended readers (production deployment) | Information disclosure |
| I10 | Events stored to S3 / filesystem in plaintext, containing secrets that leaked via action env vars | Information disclosure |
| I11 | Default ServiceAccount token auto-mounted into a pod becomes a latent `kube-apiserver` bearer credential. A sandbox escape, RCE, or future RoleBinding to `default` converts it into active cluster access. Amplified by R-I1 (no NetworkPolicy blocks pod → apiserver) and §2 R-S4 (no `__hostFetch` URL allowlist). | EoP / Information disclosure |

### Mitigations (current)

- **Secrets in K8s Secret objects** — oauth2 client credentials, S3
  credentials, and the cookie secret are all stored as Kubernetes
  Secrets and injected via `envFrom.secretRef`. None are baked into
  images or committed to source.
  (`infrastructure/modules/workflow-engine/modules/oauth2-proxy/oauth2-proxy.tf` lines 43–53;
  `infrastructure/modules/workflow-engine/modules/app/app.tf` lines 29–41;
  `infrastructure/modules/s3/s2/s2.tf` lines 18–27)
- **Terraform `sensitive = true`** on all secret variables; values are
  expected in `dev.secrets.auto.tfvars` which is gitignored.
- **Distroless non-root base image** — the application runs as
  `nonroot` on `gcr.io/distroless/nodejs24-debian13`. No shell, minimal
  userspace.
  (`infrastructure/Dockerfile`)
- **Internal-only services** — oauth2-proxy, S2, and the app's
  business-logic port are not published via NodePort; only Traefik is.
- **TLS at Traefik** — public traffic is HTTPS-only via the `websecure`
  entrypoint. Port 80 serves only cert-manager ACME HTTP-01 challenges
  and a catch-all 301 redirect to HTTPS; no app traffic flows on
  plaintext.
- **cert-manager-managed TLS** — production TLS certificates are issued
  by Let's Encrypt via the `letsencrypt-prod` ClusterIssuer (HTTP-01
  challenge, `ingressClassName: traefik`) and stored as K8s Secrets.
  Local uses a cluster-internal self-signed CA chain
  (`selfsigned-bootstrap` → `selfsigned-ca`). Chart version is pinned
  in `infrastructure/modules/cert-manager/cert-manager.tf`.
- **Build-time image versioning** — S2 uses a pinned minor tag
  (`0.4.1`); the app image is built from source.
- **`automountServiceAccountToken: false` on `app` and `oauth2-proxy`
  pods** — neither workload talks to the K8s API, so the projected
  `default` SA token is suppressed at the pod spec (authoritative over
  SA-level defaults). Mitigates **I11**.
  (`infrastructure/modules/workflow-engine/modules/app/app.tf`;
  `infrastructure/modules/workflow-engine/modules/oauth2-proxy/oauth2-proxy.tf`)

### Residual risks

| ID | Gap | Impact | Status |
|----|-----|--------|--------|
| R-I1 | Namespace-wide default-deny `NetworkPolicy` plus per-workload allow-rules: app / oauth2-proxy ingress restricted to Traefik (+ node CIDR for probes); Traefik ingress restricted to `0.0.0.0/0:80,443` + node CIDR; cross-pod traffic otherwise dropped. | I2, I3 | **Resolved** (production enforcement via Cilium; kindnet silently no-ops locally, accepted) |
| R-I2 | **App pod has no `securityContext`** — no `runAsNonRoot: true`, no `readOnlyRootFilesystem: true`, no `allowPrivilegeEscalation: false`, no dropped capabilities. The image runs as nonroot, but K8s does not enforce it. | I4 | **High priority** |
| R-I3 | **No resource `requests` / `limits`** on the app, oauth2-proxy, or S2 pods — a runaway process can starve the whole node. | I5 (amplifies §2 R-S1 / R-S2) | **High priority** |
| R-I4 | **S2 container has no user specified** and no securityContext — runs with container defaults. | I4 | Medium |
| R-I5 | ~~TLS cert source not pinned in IaC~~ — **Resolved**: cert-manager codified in `infrastructure/modules/cert-manager/`; prod uses Let's Encrypt (HTTP-01), local uses a cluster-internal self-signed CA chain. Chart version is pinned. | I7, I8 | Resolved |
| R-I10 | **cert-manager has cluster-wide RBAC** — creates/manages Secrets cluster-wide and reconciles ClusterIssuer/Certificate resources. Compromise of the cert-manager controller pod grants broad Secret read/write. | I1, EoP | Accepted — standard upstream Helm-chart RBAC; chart version pinned; runs in `cert-manager` namespace. Revisit if narrower scope becomes available. |
| R-I7 | **No encryption at rest** — the event store and S3 objects are plaintext JSON. Any secret leaked through an action payload (e.g. via emit) is stored in readable form. | I10 | Out of scope for v1; see §2 R-S6 |
| R-I8 | **No secret-management integration** (Vault, SOPS, external-secrets). Secrets live in `terraform.tfvars` files on operator workstations. | I6 | Acceptable for small teams; revisit for production |
| R-I9 | Egress `ipBlock` `0.0.0.0/0` with `except = [10/8, 172.16/12, 192.168/16, 169.254/16]` blocks cluster pod/service CIDRs, the UpCloud node network, and cloud metadata (IMDS `169.254.169.254`). Public Internet egress remains open — URL-level scoping of `__hostFetch` (§2 R-S4 app-layer half) is still outstanding. | I3 (infrastructure half of §2 R-S4) | **Resolved** for metadata/RFC1918 (app-layer URL allowlist still pending under §2 R-S4) |
| R-I11 | **Traefik's SA token remains mounted** because the controller watches `Ingress` / `IngressRoute` via the K8s API. The Helm chart's ClusterRole has not been audited for least privilege; it may grant verbs/resources wider than ingress watching requires. | I11 partial | **Follow-up: audit Traefik chart RBAC scope** |

### Production deployment notes

When deploying to the production UpCloud K8s target, treat the
following as **must-have** before exposing to real traffic:

1. **NetworkPolicy** — DONE. Namespace-wide default-deny plus per-workload
   allow-rules: Traefik → app:8080, Traefik → oauth2-proxy:4180,
   app → Internet (RFC1918 + IMDS blocked) + CoreDNS,
   oauth2-proxy → Internet + CoreDNS, Traefik → Internet + CoreDNS.
   Resolves R-I1, R-A3, and the infrastructure half of R-I9 / §2 R-S4.
   Note: app does NOT need to reach oauth2-proxy directly — forward-auth
   is performed by Traefik, not the app.
2. **Pod `securityContext`** — `runAsNonRoot: true`,
   `runAsUser: <uid>`, `readOnlyRootFilesystem: true`,
   `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`.
   Resolves R-I2.
3. **Resource requests / limits** — at minimum `cpu` and `memory`
   limits on every pod, sized from observed usage. Resolves R-I3.
4. **Real TLS** — cert-manager with the `letsencrypt-prod` ClusterIssuer
   and HTTP-01 challenge is wired in (`infrastructure/upcloud/upcloud.tf`,
   `infrastructure/modules/cert-manager/`). Resolves R-I5 and I8.
5. **Egress policy** — NetworkPolicy half DONE (see item 1). URL
   filtering inside `__hostFetch` (§2 R-S4 app-layer half) is still
   outstanding; combined mitigation resolves R-I9 completely once that
   app-layer control lands.
6. **Encrypted event storage** — if UpCloud Object Storage is used,
   enable server-side encryption. Document the key custody model.
7. **Secret rotation procedure** — document how to rotate the
   `OAUTH2_PROXY_CLIENT_SECRET`, `OAUTH2_PROXY_COOKIE_SECRET`, and S3
   credentials without downtime.

### Rules for AI agents

1. **NEVER commit a `.tfvars` file containing real secrets.** Use the
   `.example` pattern; put the real file in `.gitignore`.
2. **NEVER add a new public NodePort, Ingress, or Route** without
   explicit review. The public surface is currently exactly Traefik
   on 443; widening it requires §3 / §4 treatment.
3. **NEVER hardcode a secret** in Terraform, Kubernetes manifests,
   Helm values, or container images. Secrets come from K8s Secrets
   injected via `envFrom.secretRef`.
4. **NEVER downgrade to HTTP** for any route. Cookies rely on
   `COOKIE_SECURE=true`; serving plain HTTP breaks session security.
5. **When adding a new in-cluster service**, place it on an in-cluster
   Service only (not NodePort). Document who is allowed to reach it
   and plan for a NetworkPolicy.
6. **When adding a new environment variable that holds a secret**,
   route it through a K8s Secret. Mark the Terraform variable
   `sensitive = true`. Do not log it.
7. **Assume "internal" is not a perimeter.** Any new component must
   justify its own auth / isolation story, not rely on "it's only
   cluster-local".
8. **When adding infrastructure for production deployment**, consult
   the "Production deployment notes" checklist above.
9. **When adding a new K8s workload**, set
   `automountServiceAccountToken: false` at the pod spec. If the
   workload genuinely needs the K8s API, create a dedicated
   `ServiceAccount` with the narrowest possible `Role` /
   `ClusterRole`, justify it in the PR, and add it to this section as
   a named exception (I11).

### File references

- App deployment: `infrastructure/modules/workflow-engine/modules/app/app.tf`
- oauth2-proxy deployment: `infrastructure/modules/workflow-engine/modules/oauth2-proxy/oauth2-proxy.tf`
- Traefik routing: `infrastructure/modules/workflow-engine/modules/routing/routing.tf`
- S2 storage: `infrastructure/modules/s3/s2/s2.tf`
- Dockerfile: `infrastructure/Dockerfile`
- OpenSpec spec: `openspec/specs/infrastructure/spec.md`
