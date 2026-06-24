## Why

The single Scaleway VPS carries a real ops burden (cloud-init/sshd/fail2ban/swap convergence, Caddy ACME, Block Storage formatting, podman-auto-update plumbing) and a single-region/single-host failure domain. bunny.net Magic Containers offers managed container hosting with automatic HTTPS, anycast routing, and IaC via the `bunnynet` provider — potentially dropping most of that host-convergence surface. Before committing prod, we want a **low-risk staging-only spike** that proves the platform's real behaviour (CDN caching, cgroup/memory visibility, volume durability, OAuth round-trip) against our actual image, while prod stays untouched on the VPS.

## What Changes

- **Add a Magic Containers staging deployment** alongside the existing VPS infra: one `bunnynet_compute_container_app` (image `ghcr.io/stefanhoelzl/workflow-engine:main`, one `/data` volume, env from the existing staging secrets, `/readyz` readiness probe, `autoscaling_min=max=1`, one EU region — Frankfurt). Prod remains entirely on the VPS.
- **Expose it via a CDN endpoint (not Anycast)** for automatic HTTPS — the staging replacement for Caddy's TLS termination. We deploy on Bunny's CDN **defaults** (no pre-built edge rules) and verify caching by observation: the app already sends `Cache-Control` only on `/static/*`, so if Bunny respects origin headers, dynamic routes are uncached with zero config. **Gating observation before this shape is ever considered for prod:** a cache hit on an authenticated/owner-scoped route would be a cross-owner data leak (`SECURITY.md §4`). Only if the curl check shows dynamic routes being cached do we react — add an edge rule forcing cache-time 0 except `/static/*`, or fall back to an Anycast endpoint.
- **Cut staging over by re-targeting ONE DNS record:** repoint the existing `staging.workflow-engine.webredirect.org` Dynu record from the VPS IP to the Bunny CDN endpoint. **No VPS staging code is removed or edited** — `wfe-staging.container`, `/etc/wfe/staging.env`, the `/srv/wfe/staging` volume, and the Caddy staging site block all stay. `BASE_URL` and the staging GitHub OAuth callback are **unchanged** (same hostname either way; reuses the existing OAuth App's single callback URL). VPS-staging therefore stays a **live, warm fallback** (still auto-pulling `:main`). Switching back is a hand-edit of that one record + apply — no toggle variable (we don't expect to bounce between them).
- **Extend the staging deploy path:** after `deploy-staging.yml` pushes `:main`, trigger a Bunny rolling update (`BunnyWay/actions/container-update-image`) and poll `/readyz` for `gitSha` convergence on the Bunny-served host.
- **Accept-loss durability (documented):** Bunny volumes have no backups/replication and reattachment is not guaranteed. Staging data is low-stakes; the risk is recorded, not mitigated.
- **No DuckDB `memory_limit` wiring** — assume auto-detect works; capture real behaviour with a read-only memory smoke probe (`/proc/meminfo`, `/sys/fs/cgroup/memory.max`, `nproc`, DuckDB `current_setting('memory_limit')`) to decide whether a follow-up is needed.

## Capabilities

### New Capabilities
- `bunny-staging`: The Magic Containers staging deployment — `bunnynet` provider wiring (app, `/data` volume, CDN endpoint, env block, readiness probe, single-region single-replica), the CDN-must-not-cache-dynamic-routes gating observation, the Bunny rolling-update deploy step + `/readyz`-poll, and the accept-loss volume-durability posture.

### Modified Capabilities
- `infrastructure`: The "Dynu CNAMEs owned by tofu" requirement changes for staging — `staging.workflow-engine.webredirect.org` now resolves to the Bunny CDN endpoint instead of the VPS IP. Staging traffic no longer traverses Caddy, but the VPS staging app, env file, volume, mount, and Caddy site block are **all retained, running, and unedited** as a live warm fallback. The prod CNAME and all other VPS requirements are unchanged.

(The existing `ci-workflow` "Staging deploy workflow" requirement already permits additional non-`tofu` steps, so the Bunny rolling-update step needs no `ci-workflow` delta; the `plan-infra` gate covers the new `bunnynet` resources automatically as part of the single-project plan.)

## Impact

- **New provider/dependency:** `bunnynet` provider added to `infrastructure/`; new TF file(s) for the staging app + endpoint + volume + env + Dynu repoint. State (encrypted, Scaleway Object Storage) now tracks Bunny resources.
- **New secret:** `BUNNYNET_API_KEY` (GHA secret) for provider + `container-update-image` action.
- **CI:** `deploy-staging.yml` extended; `plan-infra` covers the new resources (empty-plan gate still applies).
- **No app/runtime code changes** — image, `/readyz`, `BASE_URL`, OAuth callback, and the DuckDB EventStore are all unchanged. The memory question is observed, not coded against.
- **Security-sensitive surface:** CDN caching of dynamic routes (`SECURITY.md §4`); env-var secrets are plaintext at the platform (no Bunny secret store) — kept out of committed tfvars, encrypted only in tofu state as today.
