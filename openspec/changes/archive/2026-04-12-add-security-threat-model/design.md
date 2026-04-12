## Context

Security-sensitive code in this repository lives at four distinct trust
boundaries: the QuickJS WASM sandbox (executes untrusted action code),
public webhook ingress (`POST /webhooks/*`), authenticated surfaces (UI
routes behind `oauth2-proxy`, API routes behind a GitHub Bearer-token
middleware), and the Kubernetes-hosted infrastructure. Existing
documentation covers these boundaries in fragments — a short "Security
Model" subsection in `openspec/project.md`, per-capability specs such as
`action-sandbox/spec.md`, and inline HCL/TypeScript comments in
infrastructure and runtime code. No single document enumerates the
threats, the mitigations in place, or the gaps that remain.

AI coding agents are the principal day-to-day contributors. Without a
consolidated reference they either re-derive the threat model on each
task (slow, inconsistent) or proceed on assumptions that the codebase
silently violates. A concrete example surfaced during this change's
research: `__hostFetch` is exposed to sandboxed action code with no URL
filtering, so action code can reach internal Kubernetes services and
cloud metadata endpoints. That gap is not currently documented anywhere
an agent would see it before writing sandbox-adjacent code.

The project already uses OpenSpec to drive capability-level requirements
via `Requirement`/`Scenario` blocks. A threat model does not fit that
format: it is narrative, cross-cutting, and describes system state rather
than testable behaviors. This change introduces the threat model as a
peer to `openspec/project.md` — architectural documentation that
accompanies the spec set without being a spec itself.

## Goals / Non-Goals

**Goals:**

- Produce a single authoritative threat model at `/SECURITY.md` that
  enumerates trust boundaries, threats, current mitigations, residual
  risks, and hard rules for every security-sensitive surface in scope.
- Optimize the document for AI agent consumption: explicit rules, clear
  trust-level semantics, enumerated threat IDs, inline file references.
- Make the model discoverable from the contexts in which agents already
  operate: compact invariants in `CLAUDE.md`, a pointer from
  `openspec/project.md`, and a `Security context` Requirement in each
  capability spec whose behavior is governed by the model.
- Establish a maintenance contract: changes to the listed capabilities
  must check alignment with the relevant `/SECURITY.md` section.

**Non-Goals:**

- Remediate the residual risks documented by the model. Fixes (e.g. URL
  allowlist on `__hostFetch`, webhook header allowlist, `NetworkPolicy`,
  pod `securityContext`) land through their own proposals.
- Event store integrity, confidentiality, or recovery semantics.
- Supply-chain concerns: SBOM generation, dependency auditing, signed
  builds, image-digest pinning.
- Production-readiness automation (cert-manager wiring, secret rotation
  runbooks). The design includes a "Production deployment notes"
  checklist for the UpCloud migration, but does not implement it.
- Creating a new capability spec for security. Testable security
  behaviors continue to live in the per-capability specs.

## Decisions

### D1. Document lives at `/SECURITY.md` (repo root)

Alternatives considered:

- `openspec/SECURITY.md` as a peer of `project.md`.
- A dedicated `openspec/specs/security-model/spec.md`.
- A section inside `CLAUDE.md`.

Chosen: **root `/SECURITY.md`**. Rationale: it is the conventional
location for security documentation on GitHub, is easy to reference
from anywhere (`/SECURITY.md`), and keeps the OpenSpec directory focused
on capability specs. A root placement also signals that this document
governs the whole repository, not just the work tracked in OpenSpec.

Trade-off: the document is outside the OpenSpec toolchain (no schema
validation, no `openspec status` coverage). Maintenance relies on the
`Security context` Requirements added to capability specs to enforce
updates. Acceptable because the document is narrative; no machine
validation of a threat model exists anyway.

### D2. Attack-surface-based structure

Alternatives considered:

- **STRIDE-based**: sections per threat category (Spoofing, Tampering,
  Repudiation, Info Disclosure, DoS, EoP).
- **Asset-centric**: sections per protected asset (event store, session
  cookies, sandbox boundary, workflow definitions).
- **Custom hybrid**: trust boundaries at the top level, STRIDE inside.

Chosen: **attack-surface-based**. Rationale: AI agents arrive at this
document because they are editing code in one place — the sandbox
bridge, a new webhook, an auth middleware, a Kubernetes manifest.
Attack-surface organization puts everything relevant to their current
task in one section. STRIDE would scatter sandbox-related threats
across six categories; asset-centric would obscure the trust-boundary
semantics that drive most security decisions here.

Each surface section follows the same subsection order (trust level →
entry points → threats → mitigations → residual risks → rules → file
references) to make navigation predictable.

### D3. Scope: sandbox, webhooks, auth, infrastructure

Alternatives considered:

- Broader: include event store integrity and supply chain.
- Narrower: sandbox and auth only; treat webhooks and infra as
  secondary.

Chosen: the four surfaces above. Rationale: these are the surfaces
where agents make code changes that can break security invariants.
Event store integrity is important but the existing `persistence`
and `event-store` specs cover it adequately for now, and adding it
would require additional research out of proportion to the AI-agent
use case. Supply chain is a CI/CD concern, not a code concern.

### D4. Audience: AI agents primarily; humans secondary

The prose avoids narrative padding; threats and rules are numbered
(`S1..S9`, `R-S1..R-S6`, `W1..W8`, etc.) so future changes and
conversations can reference them concisely. Human readers are still
supported — the structure is readable top-to-bottom — but the
document does not spend budget on story-telling where a table or
bullet list serves.

### D5. Residual risks are explicit

Each section enumerates known gaps with IDs (e.g. `R-S4` for the
missing URL filter on `__hostFetch`). Each entry includes an impact
assessment and a status label (`v1 limitation`, `High priority`,
`Accepted`). This makes it safe for agents to say "the threat model
notes this is unmitigated" rather than assuming protection where
none exists.

Trade-off: the document publicly documents unmitigated risks. This
is acceptable because the repository is internal to the project and
the risks (missing NetworkPolicy, missing sandbox memory limits) are
discoverable from the code anyway. Making them visible enables
prioritization.

### D6. CLAUDE.md carries 7 compact invariants

Alternatives considered:

- Pointer only (CLAUDE.md just links to `/SECURITY.md`).
- Full content inline in CLAUDE.md.
- Hard invariants plus soft guidelines.

Chosen: 7 hard `NEVER` rules, one per attack surface (4) plus two
cross-cutting (secret handling, Authorization-header logging), plus
a prominent "Forwarded-header trust" rule that bridges §4 and §5.
Each rule ends with the governing section reference. Rationale:
agents need the rules visible at session start; the full model is
too large to inline. The hard-only framing keeps the rules
unambiguous and testable in code review.

### D7. Category name in §4 is "UI", not "Dashboard"

Current authenticated UI routes are `/dashboard` and `/trigger`.
Future UIs (admin tooling, workflow authoring) will extend this
family. Using "Dashboard" as the category name would either exclude
`/trigger` or force periodic renaming as UIs proliferate.

### D8. `openspec/project.md` security section trimmed to a pointer

Alternatives considered:

- Keep both (accept duplication).
- Keep project.md's version and cross-reference `/SECURITY.md`.

Chosen: trim. Rationale: two authoritative sources drift. One
pointer from `project.md` to `/SECURITY.md` ensures anyone entering
through the OpenSpec knowledge base lands on the canonical document.
The current `project.md` content (lines 73–83) is fully subsumed by
`/SECURITY.md §2`.

### D9. Each governed capability spec gets a `Security context` Requirement

Specs in this repository are composed strictly of `Requirement` blocks
with `Scenario` subsections; there is no prose or overview area. To
cross-reference `/SECURITY.md` from a spec without breaking that
convention, each governed spec receives an additional Requirement
whose body references the relevant `/SECURITY.md` section and whose
scenario is process-oriented (change-time alignment with the threat
model). Rationale: this reuses the existing spec primitive rather
than introducing a new spec-file pattern, and it survives automated
spec parsing.

Eleven specs are affected (see `proposal.md`). The choice of eleven
versus a smaller set trades breadth for discoverability. Specs like
`webhooks-status` and `http-server` are omitted because their
security properties are already covered by the specs they depend on
(`webhooks-status` by `triggers` + `payload-validation`; `http-server`
by the route-level auth specs). Specs like `dashboard-middleware` and
`runtime-config` are included because they own non-obvious trust
decisions (header trust, config gates).

### D10. Section numbering is stable

The `/SECURITY.md` table of contents uses `§1`..`§5` for top-level
sections; capability specs and CLAUDE.md reference these numbers.
Future edits that add sections must append (`§6` and onward), not
renumber. Rationale: stable numbering keeps cross-references cheap
and makes diff review trivial.

## Risks / Trade-offs

- **[Risk] The threat model becomes stale as code evolves.**
  Mitigation: the `Security context` Requirement in each governed
  spec requires threat-model alignment as part of any change to that
  capability. Drift is caught at change-review time, not release
  time.

- **[Risk] Residual-risk documentation could be misread as
  acceptance.** Mitigation: each residual risk includes a `Status`
  column (`v1 limitation`, `High priority`, `Accepted`) so readers
  can distinguish deliberate deferral from unresolved work. The
  proposal explicitly states that remediation is out of scope for
  this change.

- **[Risk] Agents still skip the document and rely on CLAUDE.md
  invariants alone.** Mitigation: CLAUDE.md's section explicitly
  instructs agents to consult `/SECURITY.md` before writing
  security-sensitive code, and the rules in CLAUDE.md each end with
  a section reference. The rules cover the most common mistakes; the
  remaining ~20 rules in `/SECURITY.md` are for non-obvious cases.

- **[Trade-off] Eleven specs gain an extra Requirement.**
  Each spec now has a process-oriented Requirement alongside its
  behavioral Requirements. This dilutes the spec's focus slightly
  but is the lowest-friction way to wire discoverability without
  introducing a new file convention. Reviewers should treat the
  `Security context` Requirement as a fixed-shape reference, not a
  place for per-spec variation.

- **[Trade-off] `/SECURITY.md` lives outside OpenSpec tooling.**
  No `openspec validate` coverage, no delta-file mechanism. In
  exchange we get a standard repo convention that GitHub renders,
  external readers recognize, and the OpenSpec flow stays focused on
  capability specs. The capability-spec cross-references provide
  the structural anchor that OpenSpec would otherwise miss.

- **[Trade-off] Publishing unmitigated risks.** The document will
  list the missing SSRF filter, the verbatim webhook header
  forwarding, the absent NetworkPolicy, and the lack of pod
  `securityContext`. This is information an attacker could use, but
  it is also information the attacker can derive from the source.
  Documenting it internally outweighs the marginal disclosure cost.
