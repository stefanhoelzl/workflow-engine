## Context

Tenant isolation is enforced across at least four code surfaces (API, UI, event store, webhook ingress) by at least four distinct mechanisms (membership gate, structural API shape, tenant-stamping in the sandbox, registry lookup by tenant-key). Two recent changes — F1 "prevent X-Auth-Request-* header spoofing" (`c691ff7`) and F2 "tenant-scope event store reads" (`2ac4c13`) — closed specific attack paths and each carried their own documentation deltas, but neither named the invariant they uphold. The invariant is implicit, load-bearing, and spread across multiple documents.

`CLAUDE.md` has three tenant-related rules (lines 108–110). One of them (line 110, about `X-Auth-Request-*` and `NetworkPolicy`) is stale post-F1 — it framed the `NetworkPolicy` as load-bearing, which it no longer is.

This change is documentation-only. No code or infrastructure is touched. The goal is to make I-T2 (the "non-members cannot access" invariant) readable as a single statement, navigable to each enforcement mechanism, and anchored by cross-references in the existing OpenSpec `Security context` requirement pattern so future changes are forced to keep documentation and reality aligned.

## Goals / Non-Goals

**Goals:**
- Name I-T2 as a single authoritative statement in `SECURITY.md §1`.
- Map each data path (workflow upload, invocation event read/write, webhook ingress, workflow bundle storage) to its enforcement mechanism and the spec that documents it.
- Enumerate the two post-F1/F2 threats that remain in the threat model (`A13`, `A14`) in `SECURITY.md §4` so mitigations and residual risks link to named attacks.
- Refresh stale `CLAUDE.md` rules to match post-F1/F2 reality.
- Extend the OpenSpec `Security context` cross-reference pattern (already used by `github-auth`, `dashboard-auth`, `http-trigger`) to also cite `§1` and to add a matching entry for `event-store`.

**Non-Goals:**
- No new capability. A dedicated `tenant-isolation` capability was considered and rejected.
- No behavioural changes to any code or any spec Requirement other than the `Security context` text.
- No restructuring of `SECURITY.md`'s section layout.
- No attempt to generalize the invariant beyond today's resource types (workflows, invocation events).
- No mitigation of the generic "tenant-owned resources" case for future types. When a new tenant-owned type is added, that change proposal updates I-T2.

## Decisions

### D1 — State only I-T2, not a pair I-T1/I-T2

Exploration considered stating both a functional invariant ("members CAN access") and a security invariant ("non-members CAN'T access") as a pair. Rejected — `SECURITY.md` is a threat-model document; the functional half adds noise without clarifying any attack path. The "members CAN access" behaviour is already implied by the positive-case scenarios in `github-auth` and `dashboard-auth`. Stating it in `SECURITY.md` would add one statement to maintain without enabling any new review check.

### D2 — Put the invariant in `§1`, not `§4`

Rejected options:
- A (`§4` only): `§4` is titled "Authentication" — tenant isolation is authorization, not authentication, and it extends beyond the auth subsystem (event store, storage keys). Placing I-T2 in `§4` makes `§4` look like it owns a cross-cutting property it does not.
- C (new `tenant-isolation` capability): OpenSpec capabilities conventionally map to concrete code artifacts (a middleware, a module, a Terraform module). A `tenant-isolation` capability would map to a property that lives in many modules. That mismatch would show up as a capability whose specs describe no single code location. Ceremony for no gain.

Chosen: B — `§1 "Trust boundaries overview"` is designed to be the cross-cutting anchor; it already names every trust boundary. Adding "invariants that span boundaries" alongside "trust boundaries" fits the section's existing genre.

### D3 — Medium depth for the §1 pointer table

Rejected options:
- Terse (invariant statement alone): a reader wouldn't know where to look for "how". Forces re-derivation.
- Deep (narrative of each mechanism in `§1`): duplicates content from `§3`, `§4`, `§5`, and the relevant capability specs. Drift risk.

Chosen: Medium — invariant statement plus a five-row pointer table (Data path | Mechanism | Documented in). Pointers rarely drift; content stays canonical in its owning section.

### D4 — Explicit resource enumeration (workflows, invocation events), not "tenant-owned resources"

The invariant scope should be exactly what we're prepared to defend today. Listing "workflows and invocation events" is accurate; listing "tenant-owned resources" is an unbounded set. When we add (e.g.) secrets or audit logs, the proposal that introduces them updates I-T2 in the same change. This matches the repo's "don't design for hypothetical future requirements" stance in `CLAUDE.md`.

### D5 — Single rewrite of the stale `CLAUDE.md` header rule

Rejected: splitting the stale rule into two (one code-side, one infra-side). Both guards (bearer/header middleware split + Traefik `strip-auth-headers`) have the same failure mode: a forged `X-Auth-Request-*` header reaches a handler that reads it. One rule covers both guards; two rules would double the rule count for one guarantee.

### D6 — Keep the `NetworkPolicy` as a separate, smaller rule

After D5, the `NetworkPolicy` is not load-bearing for the header threat but remains defence-in-depth and a baseline for blast radius on any future in-cluster compromise. Dropping the rule entirely would risk a future contributor deleting the `NetworkPolicy` thinking it is dead weight. Keeping it in `CLAUDE.md` as a small DiD rule pointing at `§5 R-I1` preserves the signal.

### D7 — Strengthen the "every query must be scoped" rule with API pointers, not replace it

Rejected: making the rule event-store-specific ("never bypass `EventStore.query(tenant)`") — too narrow; it would stop applying to workflow reads and UI registry lookups. Chosen form names the specific APIs (`EventStore.query(tenant)`, `WorkflowRegistry`) without making the rule exclusive to them.

### D8 — Narrow scope, not Wide

Wide scope would reorganize `SECURITY.md` by invariant rather than by trust zone, pulling content from `§3`, `§4`, `§5` into a new `§X "Tenant Isolation"` section. Rejected — SECURITY.md line numbers are referenced from several capability specs; a reorg would cascade into four or five spec edits, and the information architecture benefit is marginal. Narrow preserves existing references and adds a single cross-cutting anchor in `§1`.

### D9 — Five specs to cross-reference

Candidate list: every capability whose code path touches tenant-owned data.
- `github-auth` — already has `Security context`. MODIFY to cite `§1`.
- `dashboard-auth` — already has `Security context`. MODIFY to cite `§1`.
- `event-store` — does not have `Security context`. ADD one that cites `§1`.
- `http-trigger` — already has `Public ingress security context` citing `§3`. MODIFY to also cite `§1`.
- `sandbox` — already has `Security context` citing `§2`. MODIFY to also cite `§1`. The sandbox is the load-bearing enforcement point for I-T2 on invocation-event *writes* (tenant-stamping). Missed in the initial D9 list; surfaced during task 5.4's audit of every spec that references `SECURITY.md`. A future change that added a host-bridge letting guest code override `tenant` would break I-T2 without touching any of the other four specs, so the cross-reference is load-bearing.

Considered but excluded:
- `webhooks-status` — covers only the `GET /webhooks/` health endpoint; no tenant-owned data access.
- `triggers` — registry module; tenant scoping is a property of the registry's lookup API, already covered via `http-trigger` at the ingress edge.
- `workflow-registry` — the workflow bundle storage is keyed by tenant in the key path; this is documented in `workflow-registry/spec.md`. Adding a Security-context requirement there is a candidate for a follow-up if future review finds the cross-link missing; not required for this change because the invariant entry in `§1` points at `workflow-registry/spec.md` directly.
- `infrastructure` — Traefik `strip-auth-headers` is already documented via the F1 delta; adding another cross-link here is redundant.

## Risks / Trade-offs

- **[Doc drift]**: SECURITY.md `§1` pointer table could go stale if a spec file is renamed or a section header moves. → Mitigation: the pointer table uses capability names (`event-store`, `http-trigger`) not file paths, and cites section headers (`§4`, `§3`) not line numbers. Renames are rare; header changes cascade through the existing `Security context` pattern, which the extended specs participate in.
- **[Over-indexing on one invariant]**: Only I-T2 is named. Other cross-cutting invariants (e.g., "secrets are never logged", "sandbox globals are an allowlist") are documented in their home sections but not in `§1`. → Accepted trade-off; adding an `§1` block for each invariant would dilute the section. If a second cross-cutting invariant warrants the same treatment, that is a future change.
- **[CLAUDE.md rule renumbering]**: Rewriting line 110 and adding a new rule changes the numbering of rules that follow. → Internal-only references (SECURITY.md cites `CLAUDE.md` by content, not rule number). Verified with `grep -n "CLAUDE.md" openspec/ SECURITY.md` — no numeric references.
- **[No runtime validation]**: Unlike code-level invariants, I-T2 is not machine-checkable. A future contributor could add a new handler that violates I-T2, and the only catch is review. → The extended `Security context` requirements in the four specs force a documentation update in the same PR, giving the reviewer an explicit checkpoint. This is the same pattern already used for `§4`.

## Migration Plan

Not applicable — documentation only, no runtime state.

## Open Questions

- Should `workflow-registry/spec.md` also gain a `Security context` requirement citing `§1`? Judgement call: the invariant entry in `§1` points at it already, and the registry's tenant-key-in-path isolation is structural. Defer to a follow-up if a future review finds the cross-link useful.
- When F3 (per-tenant S3 credentials / bucket keying for event prefixes) is implemented, does it change I-T2? No — I-T2 describes the app-layer guarantee; F3 is a blast-radius reduction below the app. I-T2 text will not need editing.
