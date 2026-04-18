## 1. SECURITY.md §1 — Tenant isolation invariants subsection

- [x] 1.1 Add a new "Tenant isolation invariants" subsection to `SECURITY.md §1 "Trust boundaries overview"`, placed after the existing subsections and before `§2`.
- [x] 1.2 Write the I-T2 statement: "No caller (authenticated or not) SHALL read, modify, or execute another tenant's workflows or invocation events."
- [x] 1.3 Add the five-row pointer table: `/api/workflows/:tenant` → `isMember` gate + tenant regex → §4, A12; invocation event reads → `EventStore.query(tenant)` API → `event-store/spec.md`; invocation event writes → sandbox stamps from registration → §2 sandbox invariants; `/webhooks/:tenant/:workflow` → registry lookup by `(tenant, workflow)` → §3, `http-trigger/spec.md`; workflow bundle storage → key = `workflows/<tenant>.tar.gz` → `workflow-registry/spec.md`.
- [x] 1.4 Add the note: "The regex-validated tenant identifier is NOT a permission check — it is a format check. Every mechanism above is load-bearing."

## 2. SECURITY.md §4 — threats, mitigations, residual risks, rules

- [x] 2.1 Add `A13` to the §4 threats table: "Allow-listed Bearer caller forges `X-Auth-Request-*` headers to impersonate tenant membership on `/api/*`." Category: EoP (cross-tenant).
- [x] 2.2 Add `A14` to the §4 threats table: "Authenticated caller reads workflow or invocation-event data by id or name on a surface whose handler omits the tenant scope." Category: EoP (cross-tenant) / Information disclosure.
- [x] 2.3 Update the existing "App-side trust-domain split for user-context population" mitigation to reference `A13` (currently it only references R-A4a).
- [x] 2.4 Update the existing "Edge-side strip of forward-auth headers" mitigation to reference `A13` (currently it only references R-A4b).
- [x] 2.5 Add a new §4 mitigation bullet for `A14`: "Tenant-scoped query API. The `EventStore.query(tenant)` method requires the tenant at the call site and pre-binds `.where("tenant", "=", tenant)`; no unscoped read path against the `events` table exists. See `event-store/spec.md`."
- [x] 2.6 Add `R-A14` to the §4 residual-risks table as "**Resolved**", pointing at `event-store/spec.md`'s tenant-scoped query requirement.
- [x] 2.7 Add a new rule to §4 "Rules for AI agents": "NEVER read `X-Auth-Request-*` headers on any code path reachable from `/api/*`, `/webhooks/*`, `/static/*`, or any non-UI route. They are stripped by Traefik's `strip-auth-headers` and ignored by `bearerUserMiddleware`; reading them anywhere else would break both guards simultaneously."
- [x] 2.8 Add a new rule to §4 "Rules for AI agents": "NEVER read or list workflow or invocation-event data without a tenant scope. For invocation events, the only scoped read API is `EventStore.query(tenant)` — do not construct raw queries. For workflows, route through `WorkflowRegistry` which is keyed by tenant."

## 3. CLAUDE.md — Security Invariants refresh

- [x] 3.1 Strengthen the existing rule at line 109 ("NEVER expose workflow or invocation data cross-tenant...") to add API pointers: "For invocation events, the only scoped read API is `EventStore.query(tenant)`; for workflows, route through `WorkflowRegistry`."
- [x] 3.2 Rewrite the stale rule at line 110 ("NEVER trust `X-Auth-Request-*` or `X-Forwarded-*` headers as authoritative while a K8s `NetworkPolicy` is absent") to name the current load-bearing controls: "NEVER read `X-Auth-Request-*` on any code path reachable from `/api/*`, `/webhooks/*`, or any non-UI route. They are stripped by Traefik's `strip-auth-headers` and ignored by `bearerUserMiddleware`; reading them elsewhere would break both guards simultaneously."
- [x] 3.3 Add a new defence-in-depth rule: "NEVER weaken the app-pod NetworkPolicy (§5 R-I1) — it's defence-in-depth for forged-header threats and a baseline for blast-radius on any future in-cluster compromise."

## 4. OpenSpec spec deltas

- [x] 4.1 Apply the `specs/github-auth/spec.md` delta from this change to `openspec/specs/github-auth/spec.md` (MODIFIED "Security context" requirement).
- [x] 4.2 Apply the `specs/dashboard-auth/spec.md` delta (MODIFIED "Security context" requirement).
- [x] 4.3 Apply the `specs/event-store/spec.md` delta (ADDED "Security context" requirement).
- [x] 4.4 Apply the `specs/http-trigger/spec.md` delta (MODIFIED "Public ingress security context" requirement).

## 5. Verification

- [x] 5.1 Run `pnpm exec openspec validate` and confirm the change validates.
- [x] 5.2 Grep `SECURITY.md` and `CLAUDE.md` for any remaining references to the old header/NetworkPolicy framing; confirm none remain outside the NetworkPolicy DiD rule. (Only stale references remain in archived changes and in this change's own tasks.md quoting the old rule; acceptable.)
- [x] 5.3 Confirm the `§1` pointer table entries each resolve to a real section or spec (manual walk). §2, §3, §4 exist; `event-store/spec.md`, `http-trigger/spec.md`, `workflow-registry/spec.md` exist.
- [x] 5.4 Confirm no capability spec that references `/SECURITY.md §4` or `§3` has been left out of the cross-reference update (grep `openspec/specs/**/spec.md` for `SECURITY.md` and audit the result). Audit found one gap: `sandbox/spec.md` — the sandbox is load-bearing for I-T2 on invocation-event writes (stamps `tenant` from registration, not guest input). Added a fifth MODIFY to this change (see `specs/sandbox/spec.md`); proposal and design D9 updated accordingly.
