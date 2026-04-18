## Why

Tenant isolation is enforced by multiple mechanisms scattered across the codebase — an `isMember` gate on `/api/workflows/:tenant`, the bearer/header middleware split on auth routes, `strip-auth-headers` at Traefik, `EventStore.query(tenant)` at the event store, tenant-keyed workflow bundles, and workflow-lookup scoping on webhook ingress. Each mechanism is documented locally in its own spec or `SECURITY.md` subsection, but the invariant those mechanisms collectively uphold is **never stated as text**. A future contributor adding a new data access path has no single canonical reference for "what does tenant isolation mean in this codebase?" and has to re-derive the answer from scattered rules.

Two docs are also stale after F1: the `CLAUDE.md` rule about `X-Auth-Request-*` headers frames the `NetworkPolicy` as load-bearing, which is no longer true — post-F1 the `NetworkPolicy` is defence-in-depth and the load-bearing controls are the `bearerUserMiddleware` / `headerUserMiddleware` split and the Traefik `strip-auth-headers` middleware.

This change names the invariant, enumerates the attacks that would break it as first-class threats, cross-references where each mechanism is documented, and refreshes the stale `CLAUDE.md` rules to match post-F1/F2 reality.

## What Changes

- **`SECURITY.md` §1 "Trust boundaries overview"**: add a new subsection "Tenant isolation invariants" stating I-T2 and a pointer table mapping each data path (workflow upload, invocation event reads, invocation event writes, webhook ingress, workflow bundle storage) to its enforcement mechanism and canonical documentation location.
- **`SECURITY.md` §4 "Authentication" threats table**: add `A13` (allow-listed Bearer caller forges `X-Auth-Request-*` to impersonate membership) and `A14` (authenticated read by id/name without tenant scope).
- **`SECURITY.md` §4 mitigations**: cross-reference the existing bearer/header split and `strip-auth-headers` mitigations to `A13`; add a new mitigation for `A14` pointing at the `EventStore.query(tenant)` API shape.
- **`SECURITY.md` §4 residual risks**: add `R-A14` as "Resolved" (closed by the `EventStore.query(tenant)` required-argument pattern documented in `event-store/spec.md`).
- **`SECURITY.md` §4 "Rules for AI agents"**: add two new rules — (1) never read `X-Auth-Request-*` outside `headerUserMiddleware`; (2) never read or list workflow / invocation event data without a tenant scope (name the `EventStore.query(tenant)` and `WorkflowRegistry` APIs).
- **`CLAUDE.md` Security Invariants**: rewrite the stale `X-Auth-Request-*` / `NetworkPolicy` rule to name the current load-bearing controls; strengthen the existing "every query must be scoped by tenant" rule with API pointers; add a new defence-in-depth rule about not weakening the app-pod `NetworkPolicy`.
- **Cross-reference from capability specs**: `openspec/specs/github-auth/spec.md`, `dashboard-auth/spec.md`, `event-store/spec.md`, `http-trigger/spec.md`, `sandbox/spec.md` each add (or extend) a "Security context" requirement that cites `SECURITY.md §1 "Tenant isolation invariants"` so any future change to those capabilities that weakens I-T2 is forced to update both the capability spec and `SECURITY.md`.

No code changes. No runtime behaviour changes. Pure documentation work.

## Capabilities

### New Capabilities

None. The `tenant-isolation` invariant is cross-cutting and does not map to a single code module; a dedicated capability was considered and rejected during exploration because OpenSpec capabilities conventionally map to concrete code artifacts.

### Modified Capabilities

- `github-auth`: extend the existing "Security context" requirement to additionally cite `SECURITY.md §1 "Tenant isolation invariants"`. No behavioural change.
- `dashboard-auth`: extend (or add) a "Security context" requirement citing `SECURITY.md §1` and `§4`. No behavioural change.
- `event-store`: extend the existing tenant-scoped query requirement with a "Security context" clause citing `SECURITY.md §1`. No behavioural change.
- `http-trigger`: extend the existing "Public ingress security context" requirement to additionally cite `SECURITY.md §1 "Tenant isolation invariants"`. No behavioural change.
- `sandbox`: extend the existing "Security context" requirement to additionally cite `SECURITY.md §1 "Tenant isolation invariants"` — the sandbox is the load-bearing enforcement point for I-T2 on invocation-event writes (it stamps `tenant` on emitted events from the workflow's registration context, not from guest-controllable input). Added during verification (task 5.4 audit) when the existing cross-reference pattern was checked. No behavioural change.

## Impact

- `SECURITY.md` — additions to §1 and §4 (invariant block, two threat rows, one mitigation bullet, one residual-risk row, two rules).
- `CLAUDE.md` — one rule rewritten, one rule strengthened, one rule added.
- `openspec/specs/github-auth/spec.md`, `openspec/specs/dashboard-auth/spec.md`, `openspec/specs/event-store/spec.md`, `openspec/specs/http-trigger/spec.md`, `openspec/specs/sandbox/spec.md` — each gains cross-reference text in its Security-context requirement.
- No code or infrastructure changes.
- No dependency or API surface changes.
- Blast radius: documentation; a reader of `SECURITY.md` gets a canonical statement of I-T2 plus a navigation map; reviewers get two explicit rules that were previously implicit; future capability proposals that touch tenant isolation are forced (via the extended Security-context requirements) to update `SECURITY.md` in the same change.
