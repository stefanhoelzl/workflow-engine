## Why

`infrastructure/spec.md` is the largest live spec (1235 lines, 75 requirements) and has absorbed the most change in the last month: `separate-app-projects` replaced `envs/upcloud/cluster/` with `envs/persistence/`, `envs/cluster/`, `envs/prod/`, `envs/staging/` as four independent projects; `automate-prod-deployment` replaced operator-driven `tofu apply` with a GHA-driven flow keyed on a long-lived `release` branch and replaced `image_tag` with `image_digest`; `auth-allow-to-github-variables` moved `auth_allow` out of committed `tfvars` and into GitHub repo variables injected at apply time; `guard-infra-drift` added `.github/workflows/plan-infra.yml` and required-status-check rulesets for `plan (cluster)` + `plan (persistence)`; `replace-oauth2-proxy` deleted the oauth2-proxy sidecar and its Helm release. The spec has not fully caught up on any of these.

Sample stale content from explore-mode thread 2:

- L703-708 scenario: `image_tag = "v2026.04.11"` with default `:latest`. Real: `image_digest = "sha256:..."` (required); `:latest` is never used; the calver-tag mechanism was retired with `automate-prod-deployment`.
- L710 "Traefik with LoadBalancer and TLS-ALPN-01": Real: HTTP-01 via cert-manager's `letsencrypt-prod` ClusterIssuer; TLS-ALPN-01 is gone; cert-manager is its own module.
- The cluster/app-instance module split: the spec still documents the old shared-cluster-owns-app layout; current modules isolate per-app-project Certificate + NetworkPolicy.
- `auth_allow` tfvar: spec documents it as committed; current wiring injects via `TF_VAR_auth_allow` from GH repo variable.
- `plan-infra.yml` + `main` ruleset `plan (cluster)` / `plan (persistence)` required checks: not documented in `infrastructure` spec at all.

The reconciliation budget from explore-mode is ~6-8 hours and is the largest single-capability chunk of work across all three cleanup proposals. Bundling it with `cleanup-specs-content` would dominate that proposal's review surface; keeping it independent lets it land in its own review cycle.

This is the third of three cleanup proposals. It applies after `cleanup-specs-structure` and is independent of `cleanup-specs-content`.

## What Changes

- **MODIFIED** `infrastructure`: comprehensive content reconciliation against the current `infrastructure/` tree:
  - Replace all `image_tag` references with `image_digest` (sha256 form).
  - Replace TLS-ALPN-01 requirement with HTTP-01 via cert-manager's `letsencrypt-prod` ClusterIssuer; document cert-manager as its own module.
  - Replace `envs/upcloud/cluster/` + `envs/upcloud/persistence/` layout references with the four-project layout (`envs/persistence/`, `envs/cluster/`, `envs/prod/`, `envs/staging/`). Cluster project no longer owns apps; each app project owns its namespace, Certificate, acme-solver NetworkPolicy, app workloads, and Dynu DNS record.
  - Replace the oauth2-proxy Helm release requirement set with the in-app auth flow (referenced from the `auth` capability) and Traefik's `strip-auth-headers` middleware on all non-UI routes.
  - Replace the committed-`auth_allow` requirement with the GH-repo-variable + `TF_VAR_auth_allow` injection pattern. Document both `AUTH_ALLOW_PROD` and `AUTH_ALLOW_STAGING` variable names.
  - Add requirements for the `plan-infra.yml` drift-guard flow: `tofu plan -detailed-exitcode -lock=false -no-color` on every PR to `main` for each operator-driven project; `main` ruleset requires `plan (cluster)` and `plan (persistence)` checks; apply-first-then-PR flow for operator-driven projects; escape-hatch via `gh secret set` or ruleset-disable for workflow-file regressions.
  - Update apply-order documentation: `persistence` → `cluster` → `prod` → bootstrap-staging (GHA workflow_dispatch to capture digest, then `tofu apply` locally with the digest).
  - Update per-project credential table: which projects get which `TF_VAR_upcloud_token` scope; which projects get which secrets.
  - Update K8s cluster config (hardcoded as locals in `infrastructure/modules/kubernetes/upcloud/upcloud.tf`) if the spec documents specific zone / version / node plan.
  - Cert-manager chart CRD-upgrade caveat (CRDs installed via Helm on first release only; must apply new CRDs manually on chart version bump).
  - Cert-readiness `kubectl wait` commands for the prod + staging Certificate resources.
  - Remove any remaining references to removed mechanisms: `envs/upcloud/`, calver tags, release-tag-triggered `release.yml`, kustomize overlays (if any mentioned), `docker-compose.yml` (if any lingering), `caddy` references.

## Capabilities

### New Capabilities
(None.)

### Modified Capabilities
- `infrastructure`: comprehensive reconciliation. Expected ~15-25 requirements touched; mix of MODIFIED (most), REMOVED (e.g., `image_tag` requirement, oauth2-proxy Helm release requirement, TLS-ALPN-01 requirement), and ADDED (e.g., `plan-infra.yml` drift-guard flow, `image_digest` apply-time injection, GH-repo-variable `auth_allow` injection, per-app-project isolation).
- `ci-workflow`: only if the `plan-infra.yml` + deploy-prod / deploy-staging / cert-readiness interactions are better documented in `ci-workflow` than `infrastructure`. Default placement: operational details in `infrastructure`, GHA workflow structure in `ci-workflow`. If `cleanup-specs-content`'s Task 12 already covers these in `ci-workflow`, this proposal only touches `infrastructure`.

## Impact

- **Specs.** One capability (`infrastructure`) substantially rewritten; one (`ci-workflow`) potentially touched for cross-file consistency.
- **Code.** None. Spec-content-only.
- **Tenants.** None.
- **Ordering.** Applies after `cleanup-specs-structure`. Independent of `cleanup-specs-content`; the two can land in either order.
