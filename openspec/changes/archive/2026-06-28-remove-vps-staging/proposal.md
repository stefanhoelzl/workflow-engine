## Why

Staging now runs live on bunny.net Magic Containers — the `staging.workflow-engine.stho.net` CNAME points at Bunny's CDN host, and `deploy-staging.yml` rolls it forward on every push to `main`. The VPS staging stack (`wfe-staging` Quadlet, `/srv/wfe/staging` block volume, `wfe-staging` tenant user, the Caddy `staging.*` site) was kept only as a "warm fallback" from the original spike. It still consumes a block volume, a tenant user + subuid range, memory, and a VPS stop/start whenever its volume is touched — for a fallback we no longer intend to use. Retiring it simplifies the VPS to a single-tenant (prod) host.

## What Changes

- Remove the VPS-side staging environment entirely: the `wfe-staging` Quadlet + `/etc/wfe/staging.env`, the `wfe-staging` tenant user (and its subuid range), the `/srv/wfe/staging` data dir + `srv-wfe-staging.mount`, the `scaleway_block_volume.staging` volume (+ its `additional_volume_ids` attachment), and the Caddy `staging.*` site block.
- Relocate the staging configuration that Bunny still needs (domain, dns_node, auth_allow, retention_days, OAuth var references) out of `local.envs` and into `bunny-staging.tf`, so `local.envs` describes only VPS-hosted envs (just `prod`). The `staging_cname` DNS record (→ Bunny, **value unchanged**) and `outputs.urls` source the staging hostname from the relocated config.
- The staging bundle-sealing key moves from `random_bytes.secrets_key["staging"]` to a fresh standalone resource in `bunny-staging.tf`. The old keyed instance is destroyed and a new key is generated (accepted: a one-time unseal gap until the next deploy re-uploads bundles).
- **BREAKING (operational):** the VPS no longer has a staging fallback. Staging availability depends solely on Bunny. The "Switching staging back to the VPS" revert path is removed.
- Reframe `bunny-staging.tf` header, the `main.tf` provider comment, and `docs/infrastructure.md` from "spike / warm fallback running in parallel with the VPS" to "Bunny is the sole staging backend." Fix the already-stale `Dynu CNAMEs` reference in the `infrastructure` spec to `Bunny DNS records` while rewriting that requirement.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `infrastructure`: VPS owns ONE app Quadlet (prod), ONE attached Block Storage volume, and tenant users `wfe-prod` + `wfe-caddy` (drop `wfe-staging`). `/srv/wfe/prod` (not `{prod,staging}`) survives rebuild. The tenant-removal scenario's worked example is re-targeted to a hypothetical `wfe-experimental`. The single-project requirement is corrected to reference Bunny DNS records (not Dynu) and one app Quadlet unit.
- `host-security-baseline`: The privileged-user class, sshd `AllowUsers` rejection scenario, cross-tenant filesystem-isolation scenario, rootless-Podman per-tenant list, and subuid-entries scenario all drop `wfe-staging` — leaving `wfe-prod` and `wfe-caddy`.
- `reverse-proxy`: The pointer to the canonical infrastructure requirement is updated from "caddy-wfe-prod-wfe-staging" to "caddy-wfe-prod" (one app site block).

## Impact

- **Terraform (`infrastructure/`):** `main.tf` (drop `local.envs.staging`, remove `scaleway_block_volume.staging` + `additional_volume_ids` entry), `bunny-staging.tf` (inline staging config, standalone sealing key, header reframe), `dns.tf` (CNAME source only; value unchanged), `host.tf` (drop `wfe-staging` tenant, `/srv/wfe/staging` dir, `data_volume_ids.staging`, `srv-wfe-staging.mount`), `outputs.tf` (staging URL from relocated config).
- **Apply mechanics:** Destroy-heavy, non-empty plan. Operator runs `apply-infra` from the feature branch **before** merge so the `plan (vps)` gate sees an empty plan. Detaching the staging volume is an in-place VPS stop/start → brief prod downtime (accepted). The staging block volume (no `prevent_destroy`) is destroyed → staging data loss (accepted; low-stakes, re-uploaded each deploy). No DNS two-step needed (CNAME unchanged).
- **Docs:** `docs/infrastructure.md` host topology (two Quadlets → one), volume table, tenant-user list, and the deleted "Switching staging back to the VPS" section.
- **Unchanged:** all CI workflows (`deploy-staging.yml` already targets Bunny only; `plan-infra.yml` still passes the staging OAuth vars that Bunny consumes), the `gh_oauth_*_staging` + `bunnynet_api_key` variables, the staging GitHub OAuth app, and the `bunny-staging` capability spec.
