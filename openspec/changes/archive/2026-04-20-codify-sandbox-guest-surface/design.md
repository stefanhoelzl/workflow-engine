## Context

The `sandbox` capability is classified UNTRUSTED in `SECURITY.md` (line 103): guest code runs author-supplied JavaScript and must be assumed hostile. The guest-visible global surface is today implemented across `packages/sandbox/src/polyfills/` but only partially mirrored in the spec. Recent commits (`e8944c0` added `Request`/`Response`/`Blob`/`File`/`FormData`; `6dc52fa` added Observable + Scheduler; `54bb722` added importScripts) expanded the surface without backfilling the per-global "Safe globals — X" requirements, so a reader cannot enumerate the contract from the spec alone.

Separately, `__hostFetch` has no app-layer URL filter. The host-side fetch is Node's built-in `globalThis.fetch` (undici) with default redirect-follow and OS-resolver DNS. The only current egress control is a Cilium `NetworkPolicy` (RFC1918 + link-local egress blocked) enforced in the UpCloud K8s prod cluster; kindnet silently no-ops NetworkPolicy in local dev, and any future netpol regression removes the sole control. `SECURITY.md R-S4` marks this "High priority, app-layer half outstanding."

Stakeholders:

- **Guest workflow authors** — need `fetch` for external API calls (the one in-repo example, `workflows/src/cronitor.ts`, hits a user-configurable Nextcloud URL).
- **Ops** — need to identify blocked fetches quickly when a workflow misbehaves.
- **Security reviewer** — needs to read one place and know the full guest surface + the egress control.

Constraints:

- Guest-side polyfills MUST NOT change. The `fetch` shim at `packages/sandbox/src/polyfills/fetch.ts` is part of the locked-down guest surface and its "capture then delete `__hostFetch`" pattern is load-bearing.
- The sandbox spec's scenario style (GIVEN/WHEN/THEN) is the house template.
- The existing `InvocationEvent` stream format is frozen — changing event shapes requires archive wipe per `/CLAUDE.md` upgrade notes; we avoid that.
- `SandboxOptions.fetch` is already a public surface used by tests and the WPT harness to inject mocks.

## Goals / Non-Goals

**Goals:**

- Produce a spec where every guest-visible global has a dedicated "Safe globals — X" requirement, so `SECURITY.md §2` can be cross-checked against a single, complete list.
- Close the app-layer half of SSRF threat S5: guest `fetch` cannot reach loopback, RFC1918, link-local, cloud metadata, or any other IANA special-use range, regardless of hostname, redirect chain, or DNS trickery.
- Fail-closed: any guest fetch that the host refuses SHALL yield a generic `TypeError` with no reason leaked to the guest.
- Secure-by-default: a sandbox constructed without an explicit `options.fetch` SHALL use `hardenedFetch`. Test callers that supply a mock are unaffected.
- Observable: every blocked fetch produces one pino warn log with the invocation labels (`invocationId`, `tenant`, `workflow`, `workflowSha`) + URL + block reason.

**Non-Goals:**

- Per-tenant or per-workflow public-URL allowlist (S8 exfiltration remains deferred; the proposal marks this explicitly and `SECURITY.md` records it).
- DNS caching or happy-eyeballs. OS `getaddrinfo` ordering is fine.
- Any change to `InvocationEvent` kinds or the bridge-factory event emission.
- Backfill documentation for the WASI/QuickJS internals (structured-clone bridges, WASI clock/random overrides, etc.). Those are engine-internals, not guest-visible globals, and already have coverage elsewhere in the spec.
- Removing the `SandboxOptions.fetch` override. Tests and WPT harness must keep working.

## Decisions

### D1. One change bundling backfill + egress hardening

**Chosen:** Single change named `codify-sandbox-guest-surface` that lands the full guest-global backfill and the hardened-fetch control together.

**Rationale:** Reviewing the new egress control depends on being able to point at a concrete "Safe globals — fetch" requirement. Bundling means the SSRF delta sits next to the requirement it amends. The follow-up risk (one of the two concerns getting a shallow review) is accepted because the backfill is mechanically verifiable against polyfill source, and the SSRF portion is well-scoped (one module, ~200 LOC).

**Alternative rejected:** Two sequential changes — a pure-docs backfill first, then the SSRF change. Cleaner review character but doubles the openspec lifecycle overhead and leaves an intermediate spec state where the SSRF work has nothing to amend.

### D2. Secure-by-default `SandboxOptions.fetch`

**Chosen:** `hardenedFetch` becomes the default when `SandboxOptions.fetch` is omitted. Signature stays `typeof globalThis.fetch` — no public API break. A single `undici.Agent` is created lazily at first sandbox construction and shared process-wide.

**Rationale:** Shifts the "is fetch hardened?" invariant from "runtime remembered to wire it" to "sandbox package guarantees it." This is the invariant that the new CLAUDE.md NEVER rule depends on.

**Alternatives rejected:**
- *Runtime wires it via `createSandboxFactory`.* Works but relies on every future sandbox consumer doing the same; easy to forget and silently unsafe.
- *Make `SandboxOptions.fetch` required (non-optional).* Hardest guarantee but forces every test file to pass an explicit mock even when the test doesn't touch fetch. Violates "no-useless-changes."

### D3. Logger + labels plumbing — reuse existing surface

**Chosen:** The main-thread `forwardFetch` handler owns logging and sanitization. The worker enriches the `__hostFetchForward` envelope with `{invocationId, tenant, workflow, workflowSha}` (the worker already has them from the `run` init message). The handler reads those labels and calls `options.logger.warn(...)` via the closure that already exists at `index.ts:141`. `hardenedFetch` itself has no logger dependency — it throws typed errors.

**Rationale:** The logger is already wired end-to-end (runtime → `createSandboxFactory` → `sandbox(...)` → `options.logger`). Zero new plumbing is needed; we only piggy-back labels on an existing protocol envelope. Keeps `hardenedFetch` pure and easily unit-tested against mocked DNS/undici without a logger fake.

**Alternative rejected:** Thread a per-request context object through `SandboxOptions.fetch`'s signature. Cleaner boundary but tightens the public type and forces mocks to either accept an extra arg or break in TypeScript. The handler-owns-logging approach needs no signature change.

### D4. Fail-closed error shape

**Chosen:** `hardenedFetch` throws a `FetchBlockedError` (exported class) with `reason: "bad-scheme" | "private-ip" | "redirect-to-private" | "zone-id"` on policy violation. The main-thread handler discriminates on `instanceof FetchBlockedError`, logs with the specific reason, then replies to the worker with a sanitized `{name: "TypeError", message: "fetch failed"}`. DNS lookup failures, TCP/TLS errors, and timeouts also sanitize to the same `TypeError`.

**Rationale:** Guest cannot distinguish blocked-by-policy from unrelated network failure, preventing the "use `fetch` as an internal-network probe" attack. Ops retain full visibility via the warn log.

**Alternative rejected:** Leak the reason to the guest (nicer DX). Lets guest code enumerate internal topology by observing which URLs yield which errors. Threat explicitly in scope.

### D5. Resolve once, connect by IP, validate on every redirect hop

**Chosen:** Custom `undici.Agent` with a `connect` hook. For each URL the pipeline processes (initial + each redirect `Location`):

```
connect(opts, callback) {
  addrs = dns.lookup(opts.hostname, {all: true});
  for each addr in addrs:
    if isIPv6MappedIPv4(addr): unwrap;
    if hasZoneId(addr): throw FetchBlockedError("zone-id");
    if isBlocked(addr): throw FetchBlockedError("private-ip");
  chosen = addrs[0];  // accept OS-native ordering (P1)
  net.connect({ host: chosen.address, port, servername: opts.hostname })
}
```

The DNS resolution happens once per hop, then the socket is opened by IP directly. No second resolution exists, so DNS rebinding has no window to exploit. SNI on the TLS socket preserves the original hostname.

**Rationale:** Simpler than happy-eyeballs, tighter than "trust undici default." Accepts a marginal UX cost (first-returned address may be suboptimal) in return for straightforward validation semantics.

**Alternatives rejected:**
- *Happy eyeballs (RFC 8305).* Browser-grade UX, meaningful implementation complexity. Overkill for server-to-server workflows.
- *Trust infra netpol.* Fails the "works in local kind dev" goal and leaves one-line-of-defense posture.

### D6. Follow redirects manually, cap 5 hops

**Chosen:** Issue fetches with `redirect: "manual"`. On 3xx with a `Location` header, re-parse the new URL, re-run the full validation pipeline (D5), re-issue the request. Cap the chain at **5 hops**. Strip `Authorization` on cross-origin redirects (defensive hygiene, aligns with browser behavior).

**Rationale:** Automatic redirect-follow would let a public URL 302-bounce into a private one, bypassing the validation we put on the initial URL. Cap of 5 matches typical library defaults and prevents redirect-loop DoS.

**Alternative rejected:** Disable redirects entirely. Breaks legitimate OAuth and CDN flows.

### D7. IANA special-use blocklist via `ipaddr.js`

**Chosen:** Use `ipaddr.js` for parsing + range classification. Explicit CIDR set: IPv4 `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (CGNAT), `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24` (TEST-NET-1), `192.88.99.0/24` (6to4 relay), `192.168.0.0/16`, `198.18.0.0/15` (benchmark), `198.51.100.0/24` (TEST-NET-2), `203.0.113.0/24` (TEST-NET-3), `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255/32`; IPv6 `::1/128`, `::/128`, `fe80::/10`, `fc00::/7`, `100::/64` (discard). IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are unwrapped and rechecked as IPv4 before classification. Zone-identifier syntax in IPv6 addresses is rejected outright.

**Rationale:** `ipaddr.js` is ~15M downloads/week with zero deps, used inside Node core tooling. The explicit CIDR list is ~20 entries — small enough to enumerate in-spec and review directly. Avoids depending on a wrapper library whose blocklist definition we'd inherit blindly.

**Alternative rejected:** Minimal blocklist matching only the netpol (RFC1918 + loopback + link-local). Leaves CGNAT, reserved, and TEST-NET ranges reachable — some can route to internal cluster infra depending on K8s CNI configuration.

### D8. Undici explicit dep

**Chosen:** Add `undici` to `packages/sandbox/package.json` as an explicit direct dependency. Keeps `Agent`, `Dispatcher`, and `fetch` typings stable across Node versions and pins behavior.

**Rationale:** undici is transitively available via Node's built-in `fetch`, but that surface's stability is a Node concern. Pinning the version protects the security-critical connect hook from silent behavior changes.

### D9. `InvocationEvent` stream unchanged

**Chosen:** No new event kind for blocked fetches. The existing `system.request host.fetch` already records the URL in `input[1]`; the existing `system.error host.fetch` records the sanitized `TypeError`. Block reason lives exclusively in the pino warn log.

**Rationale:** Adding a new event kind would require archive-format coordination and risks giving guest-observable signal (event ordering is reachable from some paths). Keeps the change additive-only on the ops side.

**Alternative rejected:** Emit a dedicated `system.blocked` event with the reason. Would let tenant owners self-diagnose blocks via dashboard but forks the event taxonomy for one failure mode.

### D10. Defer S8 (public-URL exfiltration)

**Chosen:** Acknowledge S8 in `SECURITY.md` as a known-open gap. Do not attempt to address it here.

**Rationale:** Closing exfiltration requires a per-tenant allowlist schema, upload-time validation, and dashboard UX. That is multiple changes' worth of work. Bundling into this change dilutes reviewer attention on the SSRF control and blocks landing it on something that is not yet designed.

## Risks / Trade-offs

- **Workflow regression in local dev** → Any workflow that currently relies on reaching a local-dev service (e.g. `http://localhost:xxxx`) will break. Mitigation: the one checked-in workflow (`cronitor.ts`) hits a public Nextcloud URL. Developers iterating on new workflows will see a clear `TypeError` and an ops warn log naming the blocked URL, making diagnosis fast. Tests that need to simulate HTTP endpoints continue to use `SandboxOptions.fetch` mock override.
- **New deps add supply-chain surface** → `ipaddr.js` and `undici` (already transitive) become explicit. Both are widely reviewed. Mitigation: pin exact versions via pnpm lockfile; `undici` version stays aligned with the Node version the image ships.
- **Blocklist incompleteness** → IANA may allocate new special-use ranges in future. Mitigation: CIDR set lives in one constant in `hardened-fetch.ts`; the spec lists it explicitly so drift between code and spec is detectable via review. A follow-up task tracks re-examining the list annually or on IANA changes.
- **Performance — DNS lookup per request** → `dns.lookup` adds latency. Mitigation: fine for workflow scale (workflows already spend most of their time in guest code or remote-API wait); no caching introduced deliberately — a caching resolver that doesn't honor TTLs would re-open the rebinding window.
- **Redirect chain 5-hop cap may be tight** → Some OAuth flows exceed 5. Mitigation: observable via the same warn log with `reason: "redirect-to-private"` or a new `reason: "redirect-cap"` case; can be bumped to 10 in a follow-up if production data shows need.
- **Spec length growth** → ~50% increase in `sandbox/spec.md` size (from ~1,473 to ~2,200 lines). Mitigation: existing `Safe globals — X` template is short and uniform; readers can scan the table of contents.
- **S8 remains open** → Guest code can still POST workflow data to any public URL. Mitigation: explicitly called out in `SECURITY.md`; not a regression from today's state.
- **Sequence-diagram for the blocked-fetch path** — inline below for reference.

```
 Guest QuickJS                Worker thread                  Main thread                          Outside
 ──────────────                ──────────────                 ──────────────                       ──────
      │                              │                              │                                │
      │  fetch(url)                  │                              │                                │
      ├─────────────────────────────▶│                              │                                │
      │                              │ __hostFetchForward(          │                                │
      │                              │   method, url, headers, body,│                                │
      │                              │   {invocationId, tenant,     │                                │
      │                              │    workflow, workflowSha})   │                                │
      │                              ├─────────────────────────────▶│                                │
      │                              │                              │                                │
      │                              │                   ┌──────────┴──────────┐                     │
      │                              │                   │ forwardFetch(url, …)│                     │
      │                              │                   │  = hardenedFetch    │                     │
      │                              │                   │                     │                     │
      │                              │                   │ scheme check        │                     │
      │                              │                   │ dns.lookup all      │                     │
      │                              │                   │ unwrap v4-mapped    │                     │
      │                              │                   │ reject zone-ids     │                     │
      │                              │                   │ ANY private → throw │                     │
      │                              │                   │   FetchBlockedError │                     │
      │                              │                   │   ("private-ip")    │                     │
      │                              │                   └──────────┬──────────┘                     │
      │                              │                              │                                │
      │                              │                     catch (err)                               │
      │                              │                     if err instanceof FetchBlockedError:      │
      │                              │                       logger.warn("sandbox.fetch.blocked",    │
      │                              │                         {invocationId, tenant, workflow,      │
      │                              │                          workflowSha, url, reason: err.reason})│
      │                              │                     reply {ok:false, error:{name:"TypeError", │
      │                              │                                            message:"fetch failed"}}
      │                              │◀─────────────────────────────┤                                │
      │    __hostFetch throws        │                              │                                │
      │    TypeError("fetch failed") │                              │                                │
      │◀─────────────────────────────┤                              │                                │
      ▼                              ▼                              ▼                                ▼
```
