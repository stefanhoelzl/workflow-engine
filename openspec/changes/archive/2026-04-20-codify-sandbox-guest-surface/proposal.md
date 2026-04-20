## Why

The sandbox spec at `openspec/specs/sandbox/spec.md` under-documents the guest-visible global surface: `fetch`, `Request`, `Response`, `Headers`, `Blob`, `File`, `FormData`, the full Streams family, `Observable`, `scheduler`, `structuredClone`, `queueMicrotask`, `indexedDB`, `atob`/`btoa`, and the non-`now` members of `performance` are all installed into the guest but have no "Safe globals — X" requirements. Readers cannot enumerate the guest contract from the spec, and the implicit contract has drifted during recent polyfill commits.

The same surface has one outstanding security gap: guest `fetch()` performs outbound HTTP without app-layer egress validation. Infra-layer `NetworkPolicy` blocks RFC1918 + link-local in production, but local kind dev silently no-ops NetworkPolicy and any future K8s misconfiguration removes the sole control. `SECURITY.md §2 R-S4` marks this "High priority, app-layer half outstanding."

Both items are fixed together because reviewing the new egress control requires being able to enumerate the guest fetch surface it mediates, and the backfill establishes the very "Safe globals — fetch" requirement the hardened-fetch delta amends.

## What Changes

- **Document every guest-visible global** that the sandbox installs via its polyfill IIFE. Adds ~20 new "Safe globals — X" requirements covering `fetch`, `Request`, `Response`, `Headers`, `Blob`, `File`, `FormData`, `ReadableStream`, `WritableStream`, `TransformStream`, queuing strategies, `TextEncoderStream`/`TextDecoderStream`, `CompressionStream`/`DecompressionStream`, `Observable`, `scheduler`, `structuredClone`, `queueMicrotask`, `indexedDB` + IDB classes, `atob`/`btoa`, and the `performance.mark`/`measure`/`clearMarks`/`clearMeasures` surface.
- **Add `hardenedFetch`** as the default host-side `SandboxOptions.fetch`. Implementation in `packages/sandbox/src/hardened-fetch.ts` using `ipaddr.js` (new explicit dep) + `undici` (promoted from transitive to explicit). Pipeline per request: scheme allowlist (`http`/`https`, any port), `dns.lookup(host, {all: true})` resolving all A + AAAA, unwrap IPv4-mapped IPv6 and reject IPv6 zone identifiers, reject if **any** resolved address is in the IANA special-use blocklist (loopback, RFC1918, CGNAT 100.64/10, link-local 169.254/16, unspecified 0/8, broadcast 255.255.255.255, multicast 224/4, reserved 240/4, TEST-NET 192.0.2/24 + 198.51.100/24 + 203.0.113/24, benchmark 198.18/15, 6to4 relay 192.88.99/24; IPv6 ::1, fe80::/10, fc00::/7, ::, discard 100::/64). Connect to the validated IP directly, preserving SNI = original hostname. Follow redirects manually (`redirect: "manual"`, cap **5** hops, re-run the full pipeline on each `Location`). Total wall-clock timeout **30s** composed with any caller-supplied `AbortSignal`. Single shared `undici.Agent` for the whole runtime process.
- **Introduce `FetchBlockedError`** — exported class with `reason: "bad-scheme" | "private-ip" | "redirect-to-private" | "zone-id"`. Thrown by `hardenedFetch` on policy violation.
- **Enrich the `__hostFetchForward` worker-to-main protocol envelope** with `{invocationId, tenant, workflow, workflowSha}`. The worker already has these labels from the `run` init message; the main-thread `forwardFetch` handler uses them for warn-log enrichment.
- **Main-thread `forwardFetch` handler** (in `packages/sandbox/src/index.ts`) catches errors from the underlying fetch, discriminates `FetchBlockedError`, emits a pino **warn** log `sandbox.fetch.blocked` with `{invocationId, tenant, workflow, workflowSha, url, reason}` via the already-injected `options.logger`, and sanitizes the error to a generic `TypeError("fetch failed")` before replying to the worker so the guest cannot distinguish blocked-by-policy from network failure.
- **No `InvocationEvent` changes.** Blocked fetches continue to emit the existing `system.request` / `system.error` events for `host.fetch` with the sanitized error message. Block reason lives only in the ops-facing pino log.
- **MODIFIED `__hostFetch bridge` requirement** — narrowed to describe only the QuickJS-side host-bridged entry; egress policy moves to the new `Hardened outbound fetch` requirement.
- **`SandboxOptions.fetch` default becomes `hardenedFetch`** (Option Y, secure-by-default). The signature stays `typeof globalThis.fetch` — no public API break. Test callers that pass a mock are unaffected.
- **SECURITY.md** — rewrite `R-S4` and flip status to **Resolved**; add a new row documenting that S8 (public-URL exfiltration) remains open and would require per-tenant allowlist UX work that is deferred.
- **CLAUDE.md** — add a new "NEVER" invariant: never bypass `hardenedFetch` when exposing outbound HTTP to guest code, never weaken the IANA private-range blocklist without a written rationale.

**Not changed (explicit non-goals):**

- Per-tenant or per-workflow fetch allowlist. Public-URL egress remains unrestricted at the app layer. S8 exfiltration stays deferred.
- Guest-side `fetch` shim. The shim in `packages/sandbox/src/polyfills/fetch.ts` is untouched; all new behaviour is host-side.
- DNS caching. We explicitly do not introduce a cache and do not depend on any caching resolver.
- IPv6 preference / happy eyeballs. OS-native `getaddrinfo` ordering (P1) is accepted.

## Capabilities

### New Capabilities

None. All changes land as delta requirements on the existing `sandbox` capability.

### Modified Capabilities

- `sandbox`: amends one existing requirement (`__hostFetch bridge`, narrowed) and adds ~22 new requirements — one per previously-undocumented guest global, plus `Hardened outbound fetch` codifying the new host-side egress pipeline.

## Impact

- **Code**
  - NEW: `packages/sandbox/src/hardened-fetch.ts`, `packages/sandbox/src/hardened-fetch.test.ts`.
  - MODIFIED: `packages/sandbox/src/index.ts` (default `fetch` in `SandboxOptions`, enriched handler error path + warn log), `packages/sandbox/src/worker.ts` (piggy-back `{invocationId, tenant, workflow, workflowSha}` onto `__hostFetchForward`), `packages/sandbox/src/protocol.ts` (request envelope type).
  - UNCHANGED: guest polyfills, QuickJS bridge, bridge-factory event emission, runtime wiring (runtime no longer needs to pass an explicit `options.fetch`; the default is now secure).
- **Deps** — `packages/sandbox/package.json` gains `ipaddr.js` and `undici` as explicit direct dependencies.
- **Docs** — `SECURITY.md` §2 R-S4 (rewritten + status Resolved), new R-S row for deferred S8 mitigation; `CLAUDE.md` new NEVER invariant.
- **Tenants / bundles** — no bundle re-upload required, no storage migration, no env-var change. Existing `workflows/src/cronitor.ts` (the only checked-in workflow using `fetch`) continues to work: its target is a user-configurable public Nextcloud URL.
- **Runtime behaviour** — any workflow that currently reaches a private-range address (e.g., during local dev against `127.0.0.1`) will now fail with a generic `TypeError`. Ops-visible warn log identifies the blocked URL + reason. No production workflow is known to rely on private-range egress.
