## Context

This proposal applies after `cleanup-specs-structure` has reshaped `openspec/specs/` into its post-cleanup layout. With the structural work out of the way, the remaining rot in runtime-facing specs is content-level: requirement bodies that describe mechanisms, signatures, env vars, URL shapes, or identity sources that have changed in the code since the spec was last touched.

Sample findings from explore-mode thread 2:

- `runtime-config/spec.md` has an entire requirement about `Dockerfile sets WORKFLOW_DIR default`, and a scenario feeds `createConfig({WORKFLOW_DIR: "/app", ...})` — but `WORKFLOW_DIR` is not in the live zod schema. `FILE_IO_CONCURRENCY`, the `PERSISTENCE_PATH`/`PERSISTENCE_S3_BUCKET` mutex `.refine()`, and the `restricted` → missing-OAuth-credentials `.refine()` are not documented.
- `trigger-ui/spec.md` scenario L22 reads identity from `X-Auth-Request-User: stefan` + `X-Auth-Request-Email: stefan@example.com` — but `packages/runtime/src/auth/` contains only `sessionMiddleware` and `bearerUserMiddleware`; `headerUserMiddleware` (referenced by `SECURITY.md §4 A13` and `CLAUDE.md`) was deleted by `replace-oauth2-proxy`. No live code reads `X-Auth-Request-*` on `/trigger/*`.
- `action-upload/spec.md` Purpose line still says `POST /api/workflows` without the tenant prefix; the rest of the spec correctly says `/api/workflows/<tenant>`.
- `infrastructure/spec.md` references `TLS-ALPN-01` and `image_tag = "v2026.04.11"` — both replaced (HTTP-01 via cert-manager; `image_digest` via GHA). That capability is handled by `cleanup-specs-infrastructure`.

The reconciliation budget estimated in explore-mode is ~15-20h. That is too large for a single focused review but small enough to do in one proposal if the tasks list breaks the work into spec-by-spec units each reviewable in a sitting.

## Goals / Non-Goals

**Goals**

- Every MODIFIED capability's requirement bodies reflect what `packages/runtime/src/`, `packages/sdk/src/`, `packages/sandbox-stdlib/src/`, and `infrastructure/Dockerfile` actually do today.
- Every dead env-var reference, dead middleware name, dead signature, and dead URL-shape is eliminated from `openspec/specs/` (outside `infrastructure/`).
- `SECURITY.md` and `CLAUDE.md` stop referencing `headerUserMiddleware`, `__dispatchAction`, `__hostCallAction`, `__emitEvent`, and `bridge.setRunContext`.
- `openspec validate --specs --strict` stays at 0 failures after apply.

**Non-Goals**

- `infrastructure/spec.md` — scope of `cleanup-specs-infrastructure`.
- No new capabilities, no capability renames, no additional deletions. Structure is frozen by `cleanup-specs-structure`.
- No SECURITY.md §N new rule additions. `SECURITY.md` edits are limited to fixing stale component/file names.
- No sandbox / sandbox-stdlib / sandbox-plugin changes. Structure proposal already handled the sandbox split.
- No implementation code changes.

## Decisions

### Reconcile against code, not against upgrade notes

Upgrade notes in `CLAUDE.md` are a source of truth for what a specific change did, but they can miss subsequent changes that touched the same surface. The reconciliation process for each capability reads `packages/.../*.ts` first, then consults upgrade notes for context. When the two disagree, code wins. The `headerUserMiddleware` finding in explore-mode — referenced by `SECURITY.md` + `CLAUDE.md` but absent from `packages/runtime/src/auth/` — is the canonical motivating example.

Alternative considered: reconcile against upgrade notes and trust their completeness. Rejected because the `headerUserMiddleware` case proves upgrade-note drift is real and propagating it into the spec would amplify the lie.

### One task per capability, grouped by domain

Tasks are structured so each corresponds to a single capability's spec file, with pre-defined subtasks for the specific rot known from explore-mode. The groupings (auth+UI, executor+SDK+triggers, config+persistence+event-store, CI+build) let a reviewer load one domain at a time without cross-referencing.

Alternative considered: one task per requirement body edited. Rejected because edit granularity within a single spec file is a mechanical detail, not a review unit.

### Keep SECURITY.md edits in-scope

The project's security rules are embedded in `SECURITY.md`, and they reference component names (e.g., `headerUserMiddleware`) that are stale. Fixing those in the same change that fixes the spec bodies preserves the one-source-of-truth invariant between specs and the security doc. `SECURITY.md` is not an OpenSpec capability, so the edits land as file edits alongside spec deltas, documented in the tasks list.

Alternative considered: defer `SECURITY.md` edits to their own change. Rejected because half-updated security docs are worse than dated ones — the risk is an invariant being interpreted with the old-name component in mind.

### Do not open the sandbox or sandbox-stdlib spec files

The structural proposal already rewrote those specs. Touching them again here would create rebase hazard and scope creep. If the content proposal uncovers a requirement that contradicts reality, it gets logged as an out-of-scope finding for a later change, not fixed in this one.

Alternative considered: allow sandbox-spec touch-ups if "small". Rejected because "small" is the slip vector.

## Risks / Trade-offs

- **[Risk] Reconciliation-driven edits accidentally tighten a requirement that the code doesn't actually enforce** → Mitigated by a per-capability pass that runs the live test suite (`pnpm test`) after edits; failing tests flag overreach. Any reconciliation that can't be motivated by a concrete code citation gets reverted.
- **[Risk] `SECURITY.md` rename causes a reviewer to miss a security rule invariant change** → Mitigated by making `SECURITY.md` edits in this change name-only: no rule wording changes, only token replacements (e.g., `headerUserMiddleware` → `sessionMiddleware` with a scope-clarifying phrase). Rule semantics are not touched.
- **[Risk] Some "verify matches code" tasks turn into deep content rewrites** → Accepted. Spec-owner work is not bounded by the task headline; if a capability needs more than a polish, the proposal takes longer but doesn't split.
- **[Trade-off] Running tests after spec-only edits is ceremony-heavy** → Accepted for the capabilities that encode code-level contracts (sdk, executor, http-trigger, payload-validation). Skipped for the capabilities that encode operational or UI contracts (cli, ci-workflow, trigger-ui, dashboard-list-view) where spec-to-code equivalence is established by reading, not by running.

## Migration Plan

Applies after `cleanup-specs-structure` is archived.

1. Pull main, confirm the post-structure layout is in place.
2. Walk each task group in order. For each capability: read the live code, rewrite the spec delta, run the relevant test suite if applicable.
3. Run `pnpm exec openspec validate --specs --strict` — baseline + after each capability. The number must not regress.
4. Run `pnpm validate` to confirm no code changes sneaked in.
5. Archive via `openspec archive cleanup-specs-content`.

**Rollback**: `git revert` the archive commit. Specs return to the post-structure state.

## Open Questions

- Does the `X-Auth-Request-*` header stripping via Traefik's `strip-auth-headers` middleware warrant a requirement in the `auth` capability, or is it an infrastructure-layer concern best left to `infrastructure`? If the former, add ADDED requirement in `auth`. If the latter, note in the infrastructure proposal.
- Does `SECURITY.md §4 A13` need wording changes beyond the `headerUserMiddleware` → `sessionMiddleware` token replacement? A13's security claim is that only one middleware on specific paths reads `X-Auth-Request-*`; if the claim is now "no live middleware reads them, because the Traefik strip step is load-bearing and bearer-middleware's forged-header test is the only regression guard", the invariant is subtler. Resolved at implementation time.
- Is `dashboard-list-view` genuinely already clean (explore-mode sampled only a few requirements)? If fuller audit finds more rot, the proposal handles it in-scope.
