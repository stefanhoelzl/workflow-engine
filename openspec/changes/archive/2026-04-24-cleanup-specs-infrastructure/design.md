## Context

`infrastructure/spec.md` carries the heaviest content-level rot of any live spec: 1235 lines across 75 requirements, updated piecemeal as `envs/upcloud/cluster/` → `envs/persistence/ + envs/cluster/ + envs/prod/ + envs/staging/` and `image_tag` → `image_digest` and operator-applied-prod → GHA-applied-prod and committed-`auth_allow` → GH-repo-variable `auth_allow` shipped in separate upgrade notes. No single change in the archive reconciled the spec end-to-end against the resulting tree; each change updated the sections it touched and left adjacent sections referencing the old model.

Because the spec is large and because the rot is systematic rather than pointy (most sections have at least one outdated fact), the reconciliation is closer to a rewrite than a polish. Bundling it into `cleanup-specs-content` would dominate that proposal's review surface. Keeping it independent lets reviewers focus on the Terraform/K8s/DNS/ACME domain in isolation.

Sample rot from explore-mode thread 2:

- L703: `image_tag` variable requirement. Real: `image_digest` variable, sha256 form, required (no default).
- L707-708: `ghcr.io/stefanhoelzl/workflow-engine:v2026.04.11` example. Real: `@sha256:...` digest form only; calver tags retired.
- L710: "Traefik with LoadBalancer and TLS-ALPN-01". Real: HTTP-01 via cert-manager ClusterIssuer; TLS-ALPN-01 resolver is gone; cert-manager is a separate module with its own Helm release.
- L896: mentions `envs/upcloud/persistence/` layout → replaced by `envs/persistence/`.
- No requirement documents the four-project layout (`persistence` / `cluster` / `prod` / `staging`) that `separate-app-projects` introduced.
- No requirement documents `plan-infra.yml` or the `main` ruleset's `plan (cluster)` + `plan (persistence)` required-status-checks from `guard-infra-drift`.
- No requirement captures the apply-first-then-PR flow for operator-driven projects.
- No requirement captures the `TF_VAR_auth_allow` injection from `AUTH_ALLOW_PROD` + `AUTH_ALLOW_STAGING` GH variables per `auth-allow-to-github-variables`.

Structure is not in scope — `cleanup-specs-structure` already confirmed `infrastructure` stays as a single capability.

## Goals / Non-Goals

**Goals**

- Every requirement in `infrastructure/spec.md` reflects the current `infrastructure/` tree, the current `.github/workflows/`, and the current `SECURITY.md` invariants that touch infrastructure.
- The four-project topology (`persistence` / `cluster` / `prod` / `staging`) is specced in full: per-project state keys, per-project TF variable scopes, per-project remote_state reads (prod reads persistence; staging owns its own bucket), per-project TF_VAR secret requirements.
- The cert-manager + ACME HTTP-01 issuance flow is specced with all its caveats: chart-version-bumps need manual CRD apply; per-app-project Certificate + acme-solver NetworkPolicy; cert-readiness `kubectl wait`.
- The `release` branch + GHA deploy-prod + GHA deploy-staging + GHA plan-infra model is specced end-to-end: required secrets, `environment: production` reviewer gate, two-job plan/apply split, `image_digest` capture via `docker/build-push-action`, cherry-pick workflow, rollback via `git revert` on `release`.
- The `auth_allow` injection model is specced: no committed value in prod/staging tfvars; GH-variable `AUTH_ALLOW_PROD` / `AUTH_ALLOW_STAGING`; `TF_VAR_auth_allow` at apply time; unset variable → disabled mode (fail-closed runtime 401).
- The drift-guard model is specced: `plan-infra.yml` matrix (`cluster`, `persistence`); `-detailed-exitcode -lock=false -no-color` invocation; `main` ruleset required checks; escape hatches (`gh secret set`, ruleset enforcement toggle); known gaps (Helm-release rendered objects invisible to the gate).

**Non-Goals**

- No changes to the `infrastructure/` code itself. This is spec-only.
- No renaming of the `infrastructure` capability; no split into sub-capabilities (`infrastructure/envs/prod` etc.). The spec stays as one file; structural split would be a separate proposal and has not been argued for.
- No `SECURITY.md §5` rule additions. If current `SECURITY.md` §5 (pod-security-baseline, secrets discipline, automount token) needs token updates those are in scope; new rules are out.
- No CI-workflow spec changes beyond aligning with `infrastructure` — if `cleanup-specs-content` Task 12 already did the work on `ci-workflow/spec.md`, this proposal defers.

## Decisions

### Treat this as a guided rewrite rather than delta-by-delta edits

A 1235-line spec with systematic rot is awkward to reconcile requirement-by-requirement because adjacent requirements share context (e.g., `image_tag` appearing in one requirement and `calver tagging scheme` appearing two requirements later means a piecemeal fix leaves inconsistent framing). The tasks list groups requirements by topic (apply-order, state-backend, app-projects, cert-manager, traefik, networkpolicy, deploy, drift-guard, cert-readiness) so each group is reconciled as a coherent section.

Alternative considered: requirement-by-requirement mechanical updates. Rejected because it produces internally-inconsistent wording.

### Anchor everything to the live `infrastructure/` tree as source of truth

Every requirement starts from "read the file(s)", not from "read the upgrade notes". Upgrade notes are context, not spec; they may miss subsequent changes. The cert-manager-separate-module point, for example, is observable in the tree (`infrastructure/modules/cert-manager/cert-manager.tf`) regardless of which upgrade note mentioned it.

Alternative considered: rebuild specs from upgrade notes. Rejected (same reason as `cleanup-specs-content` — `headerUserMiddleware` meta-rot proved upgrade-note drift is real).

### Document the Helm-rendered-objects blind spot as a first-class requirement

`guard-infra-drift` added an operational gap: `tofu plan` only detects drift in Terraform-managed fields, not inside rendered Helm release objects. `kubectl edit` on a Helm-rendered Traefik Deployment produces invisible drift. This is captured in `CLAUDE.md` but nowhere in `infrastructure/spec.md`. Promoting it to a requirement (with a "Do not bypass Helm" constraint) makes the gap visible to any future change author working on the cluster module.

Alternative considered: keep the gap in `CLAUDE.md` only. Rejected because operational invariants belong in specs, not tribal knowledge.

### Cross-file consistency with `cleanup-specs-content`

This proposal and `cleanup-specs-content` are independent but share one surface: `ci-workflow/spec.md`. `cleanup-specs-content` owns the CI workflow structure (deploy-prod, deploy-staging, plan-infra, wpt, ci, docker-build). This proposal only references CI where it bears on infrastructure semantics (required secrets per deploy; `environment: production` gate). Both proposals must leave the same `ci-workflow/spec.md` state after archive. This is resolved by: `cleanup-specs-content` authors canonical `ci-workflow` requirements; this proposal cross-links via inline text, no MODIFIED deltas on `ci-workflow`.

Alternative considered: let both proposals touch `ci-workflow` and merge on archive. Rejected because the second-archived proposal would see stale MODIFIED deltas. Clean ownership avoids the conflict.

## Risks / Trade-offs

- **[Risk] The infrastructure rewrite ships with an undetected divergence from live code** → Mitigated by requiring every task to open the corresponding `.tf` or `.yml` file and grep-confirm the cited behaviour. Tasks that cannot cite a specific file/line get held.
- **[Risk] Helm-rendered-object drift documentation contradicts a future decision to manage individual Helm resources via Terraform** → Mitigated by phrasing the requirement as "Do not bypass Helm for drift-guard-protected workloads" — a guidance norm, not a physical constraint.
- **[Risk] `plan-infra.yml` drift-guard documentation ossifies a CI choice that may change** → Accepted; spec drift from future changes is a known cost and the drift-guard change recently landed, so stability is high.
- **[Risk] Contention with `cleanup-specs-content` on `ci-workflow/spec.md`** → Mitigated by explicit ownership allocation above. If conflict materializes at archive time, rebase the later proposal.
- **[Trade-off] Not splitting `infrastructure` into multiple capabilities** → Means the single spec stays long. Alternative (structural split) would be a larger change requiring its own proposal; worth considering in a future iteration if the spec grows further.

## Migration Plan

Applies after `cleanup-specs-structure` is archived. Order-independent of `cleanup-specs-content`.

1. Pull main. Confirm the live `infrastructure/` tree matches the state the spec will describe (i.e. no uncommitted local infra work).
2. Walk task groups in order. Each group: open the files, rewrite the relevant requirements, re-read for coherence within the group, move on.
3. Run `pnpm exec openspec validate cleanup-specs-infrastructure --strict`. Must pass.
4. Run `pnpm exec openspec validate --specs --strict`. Must remain at 0 failures.
5. Archive via `openspec archive cleanup-specs-infrastructure`.

**Rollback**: `git revert` the archive commit. Spec returns to its pre-rewrite state.

## Open Questions

- Should the four-project layout be specced as four separate requirements (one per `envs/<project>/`) or as a single "four-project topology" requirement with per-project scenarios? Leaning: one requirement per project for searchability; resolved during task-level writing.
- Does `SECURITY.md §5` need a token update (`oauth2-proxy` → the in-app auth flow's infrastructure components)? Tracked as part of `cleanup-specs-content`'s SECURITY.md task; cross-check at archive-time.
- Is `cert-manager` a separate capability worth extracting? Today the cert-manager Helm release + ClusterIssuer + per-app Certificate + acme-solver NetworkPolicy are spread across infrastructure modules. Extracting a `cert-manager` capability would clean the `infrastructure` spec but expand the structural surface, which this cleanup pass is trying to reduce. Decision: no structural change here; revisit if the infrastructure spec remains unwieldy after content reconciliation.
