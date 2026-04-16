## Why

The infrastructure code (~2,700 lines across 14 TF files) is hard to reason about after time away. The 538-line `workflow-engine.tf` mixes four concerns (app composition, plugin vendoring, NetworkPolicies, Traefik routing config), security defaults are scattered with gaps (app and oauth2-proxy pods lack securityContext), and tracing differences between local and production environments requires manual diffing. Staging deployment in the production cluster is blocked by the single-instance module design.

## What Changes

- **Restructure directory layout**: rename roots to `envs/{local, upcloud/{persistence, cluster}}/`, rename modules (`workflow-engine` -> `app-instance`, `routing` -> `traefik`, `s3` -> `object-storage`, `image/local` -> `image/build`), drop `image/registry/` shim.
- **Namespace isolation**: move app workloads out of `default` into per-instance namespaces (`ns/prod`, `ns/staging`), move Traefik to `ns/traefik`. `default` namespace left empty (except S2 in local env).
- **Add `modules/baseline/`**: namespace-wide defaults (default-deny NetworkPolicy, PodSecurity admission `restricted` label, shared pod/container securityContext locals) in one reviewable file.
- **Add `modules/netpol/`**: profile-based NetworkPolicy factory replacing ~180 lines of duplicated NP boilerplate across 4 modules.
- **Add pod securityContext to all workloads**: closes the existing gap where app, oauth2-proxy, and s2 pods have no securityContext. Traefik init container also gets explicit securityContext.
- **PodSecurity `restricted` enforcement**: applied via namespace labels with a warn-then-enforce rollout (Phase 1 sets `warn`, Phase 2 flips to `enforce` after verification).
- **Multi-instance support via `for_each`**: `module "app_instance" { for_each = local.instances }` enables adding staging by uncommenting one map entry.
- **Decouple routes from Traefik Helm release**: IngressRoutes and Middlewares move from Traefik `extraObjects` into a co-located local Helm chart (`routes-chart/`) per app-instance, installed as a separate `helm_release`. Route edits no longer trigger Traefik pod restarts.
- **Commit Traefik plugin tarball to repo**: replaces the `data.external` bash+curl fetch pipeline with a committed ~200KB file read via `filebase64()`. Removes `.plugin-cache/`, `terraform_data` with `ignore_changes`, and the bash/curl runtime dependency.
- **Extract DNS module**: Dynu CNAME management moves from inline in the upcloud root to `modules/dns/dynu/` for provider-swap readiness.
- **Reduce code duplication**: shared security locals from baseline, `dynamic "env"` maps for oauth2-proxy env vars (~80 lines -> ~15), standardized `app.kubernetes.io/name` + `app.kubernetes.io/instance` labels.
- **Dockerfile change**: `USER nonroot` -> `USER 65532` (numeric UID required for PodSecurity admission static validation).

## Capabilities

### New Capabilities

- `pod-security-baseline`: Namespace-level PodSecurity admission enforcement (`restricted`), default-deny NetworkPolicy, shared securityContext defaults, warn-then-enforce rollout.
- `network-policy-profiles`: Profile-based NetworkPolicy factory module that generates NPs from a declarative spec (egress_internet, egress_dns, ingress_from_pods, ingress_from_cidrs).                                                                                                                                                              

### Modified Capabilities

- `infrastructure`: Directory layout restructured, modules renamed/relocated, namespace isolation added, multi-instance `for_each` support, plugin vendoring simplified (committed tarball), routes decoupled from Traefik extraObjects into per-instance Helm chart, DNS extracted to module, Dockerfile UID change.
- `oauth2-proxy`: Pod securityContext added, env vars refactored to dynamic maps, deployment moved to per-instance namespace.
- `reverse-proxy`: Module renamed to `traefik`, moved to `ns/traefik` namespace, plugin vendoring simplified (committed tarball replaces data.external pipeline), explicit container securityContext added to main container and init container, routes/middlewares removed from extraObjects (now per-instance Helm chart).
- `docker`: Dockerfile `USER` directive changed from `nonroot` to `65532`.

## Impact

- **Infrastructure files**: ~14 TF files restructured, ~4 new modules added, ~3 modules renamed, 1 module deleted.
- **Dockerfile**: one-line change (`USER 65532`).
- **CI workflow**: `tofu validate` and `tofu fmt` paths updated to `infrastructure/envs/` and `infrastructure/persistence/`.
- **Production deployment**: one-time ~2-5 minute downtime during namespace migration (destroy+recreate K8s resources). ACME cert re-issues in ~60s.
- **Local development**: clean teardown + rebuild required (`pnpm local:destroy && pnpm local:up`).
- **Git repo**: +200KB committed plugin tarball; `.plugin-cache/` directory removed.
- **State**: S3 remote state keys unchanged. `moved {}` blocks for Dynu DNS resource. All K8s resources destroy+recreate due to namespace change.
- **SECURITY.md**: needs updates for namespace isolation model, PodSecurity enforcement, and securityContext additions.
