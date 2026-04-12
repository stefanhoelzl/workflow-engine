## Why

Security knowledge for this project is scattered across `openspec/project.md`,
individual capability specs (`action-sandbox`, `github-auth`, `oauth2-proxy`),
application code (`api/auth.ts`, `sandbox/bridge.ts`), and infrastructure
(`oauth2-proxy.tf`, `routing.tf`). There is no single authoritative threat
model that enumerates trust boundaries, threats, mitigations, residual
risks, and the rules that must hold when changing security-sensitive code.

AI coding agents — the primary daily contributors to this repo — have no
consolidated reference to consult before touching security surfaces. The
result is implicit assumptions about what is protected (e.g. that the
sandbox prevents SSRF, which it does not) and inconsistent decisions about
where auth belongs when new routes are added.

This change introduces a root-level `SECURITY.md` as that authoritative
reference, wires compact invariants into `CLAUDE.md` so they are visible
in every agent session, and cross-references the threat model from the
capability specs whose behavior it governs.

## What Changes

- **NEW** `/SECURITY.md` — attack-surface-based threat model, written for AI
  agents as the primary audience. Five sections: header and trust-boundary
  overview (§1), sandbox boundary (§2), webhook ingress (§3), authentication
  for UI and API (§4), infrastructure and deployment (§5). Each attack-surface
  section lists trust level, entry points, threats, mitigations, residual
  risks (including known high-priority gaps: no SSRF filter on `__hostFetch`,
  verbatim header forwarding on webhooks, missing NetworkPolicy,
  missing pod `securityContext`), and hard rules for AI agents. Includes
  a "Production deployment notes" checklist for the UpCloud migration.
- **MODIFIED** `CLAUDE.md` — add a "Security Invariants" section listing 7
  hard `NEVER` rules (one per attack surface plus two cross-cutting) with a
  pointer to `/SECURITY.md` for the full model.
- **MODIFIED** `openspec/project.md` — trim the `### Security Model` section
  (currently lines 73–83) to a one-line pointer to `/SECURITY.md`. Prevents
  drift between two sources of truth.
- **MODIFIED** existing security-relevant specs — each gains a "Security
  context" Requirement that names the governing `/SECURITY.md` section and
  mandates threat-model alignment when the capability changes. Affected
  specs: `action-sandbox`, `context`, `github-auth`, `oauth2-proxy`,
  `dashboard-auth`, `dashboard-middleware`, `runtime-config`, `triggers`,
  `payload-validation`, `reverse-proxy`, `infrastructure`.

Non-goals (explicitly out of scope):

- Event store integrity and confidentiality.
- Supply-chain security (SBOM, dependency audit, signed builds, image-digest
  pinning).
- Remediation of the residual risks themselves. The threat model documents
  gaps; fixes land through separate proposals.

## Capabilities

### New Capabilities

_None._ `SECURITY.md` is meta-documentation that cross-cuts existing
capabilities; it is not a capability in its own right. Testable security
invariants continue to live in the per-capability specs listed below.

### Modified Capabilities

- `action-sandbox`: add a `Security context` Requirement pointing to
  `/SECURITY.md §2`, establishing that sandbox changes must update the
  threat model when they introduce threats, remove mitigations, or alter
  the host-bridge surface.
- `context`: add a `Security context` Requirement pointing to
  `/SECURITY.md §2`, covering `ActionContext` as the sandbox bridge.
- `github-auth`: add a `Security context` Requirement pointing to
  `/SECURITY.md §4`.
- `oauth2-proxy`: add a `Security context` Requirement pointing to
  `/SECURITY.md §4`.
- `dashboard-auth`: add a `Security context` Requirement pointing to
  `/SECURITY.md §4`.
- `dashboard-middleware`: add a `Security context` Requirement pointing to
  `/SECURITY.md §4`, covering the trust placed in `X-Auth-Request-*`
  headers.
- `runtime-config`: add a `Security context` Requirement pointing to
  `/SECURITY.md §4`, covering configuration gates that enable or disable
  authentication (notably `GITHUB_USER`).
- `triggers`: add a `Security context` Requirement pointing to
  `/SECURITY.md §3`.
- `payload-validation`: add a `Security context` Requirement pointing to
  `/SECURITY.md §3`, covering Zod validation as the only pre-sandbox
  filter on public ingress.
- `reverse-proxy`: add a `Security context` Requirement pointing to
  `/SECURITY.md §4` and `§5`, covering route-to-middleware bindings.
- `infrastructure`: add a `Security context` Requirement pointing to
  `/SECURITY.md §5`.

## Impact

- **Documentation**: introduces `/SECURITY.md`; modifies `CLAUDE.md` and
  `openspec/project.md`. No code behavior changes.
- **Specs**: adds a single new Requirement to each of the 11 listed specs.
  No existing Requirements are modified or removed.
- **Developer workflow**: AI agents consult `CLAUDE.md`'s Security
  Invariants on every session; `/SECURITY.md` becomes the required
  reference when touching sandbox, webhook, auth, or infrastructure code.
  Future change proposals that modify a listed capability must check the
  corresponding `/SECURITY.md` section for alignment.
- **Residual-risk backlog**: the documented high-priority gaps (SSRF,
  webhook header forwarding, NetworkPolicy, pod `securityContext`,
  resource limits) become visible follow-up work, tracked through their
  own future proposals rather than in this change.
- **No runtime, build, dependency, or infrastructure code changes.**
