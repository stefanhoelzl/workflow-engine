## Why

The deployment currently lives under a free Dynu dynamic-DNS subdomain (`workflow-engine.webredirect.org`) managed by a second DNS provider (the Mastercard `restapi` provider against the Dynu API). We now own `stho.net`, delegated to Bunny DNS — the same vendor already in the tofu project for Magic Containers. Moving both environments onto our own domain, managed through the existing `bunnynet` provider, retires the Dynu dependency, collapses DNS onto one provider/credential, and gives us a stable, owned namespace.

## What Changes

- **BREAKING (operator/users):** Canonical hostnames change.
  - prod: `workflow-engine.webredirect.org` → `workflow-engine.stho.net`
  - staging: `staging.workflow-engine.webredirect.org` → `staging.workflow-engine.stho.net`
- DNS records move from Dynu to **Bunny DNS**, managed by the existing `bunnynet` provider via a `data "bunnynet_dns_zone"` lookup of `stho.net` (the zone is owned out-of-band; tofu manages only the two subdomain records, never the apex or the zone). prod = A → VPS IP; staging = CNAME → the Bunny Magic Containers CDN host.
- **Remove** the Dynu integration entirely: the `restapi` provider + provider block, the `dynu_api_key` variable, the `TF_VAR_dynu_api_key` wiring in `plan-infra.yml` and `.proton.yaml`, and the regenerated `.terraform.lock.hcl` (drops the Mastercard provider).
- Introduce a `base_domain` variable so the env FQDNs compose as `[staging.]workflow-engine.${base_domain}` — future domain swaps become a one-line change.
- TLS unchanged in mechanism: Caddy issues the prod Let's Encrypt cert via HTTP-01; Bunny issues the staging cert via `bunnynet_pullzone_hostname`. The staging hostname is re-registered for the new name (two-step targeted apply so the CNAME resolves before cert validation).
- Flip the `wfe` CLI built-in default base URL and README to `https://workflow-engine.stho.net`.
- Update the two GitHub OAuth Apps' callback URLs **in place** to the stho.net URLs (no secret rotation) — operator/manual step.
- Update `deploy-prod.yml` / `deploy-staging.yml` hardcoded URLs and `docs/infrastructure.md` (including correcting the stale "staging Bunny cutover not yet wired" note — staging is already live on Magic Containers).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `infrastructure`: the "Dynu CNAMEs owned by tofu" requirement is rewritten as Bunny-DNS-records-owned-by-tofu (provider `dynu`→`bunnynet`, new hostnames, the staging-revert note); the "Caddyfile renders one site block per env" requirement's two hardcoded FQDNs change to the stho.net names.
- `bunny-staging`: the staging custom-hostname / `BASE_URL` / OAuth-callback assertions move from `staging.workflow-engine.webredirect.org` to `staging.workflow-engine.stho.net`.
- `cli`: the built-in default base URL changes to `https://workflow-engine.stho.net`.
- `ci-workflow`: the staging deploy/readiness/upload URLs change to stho.net; `plan-infra` no longer consumes `TF_VAR_dynu_api_key`.

## Impact

- **Infra:** `infrastructure/{main.tf,dns.tf,bunny-staging.tf,variables.tf,.proton.yaml,.terraform.lock.hcl}`, `infrastructure/files/Caddyfile.tmpl` (no change — driven by `local.envs.domain`).
- **CI:** `.github/workflows/{plan-infra.yml,deploy-prod.yml,deploy-staging.yml}`.
- **App/docs:** the `wfe` CLI default URL, `README.md`, `docs/infrastructure.md`.
- **External (manual, operator):** two GitHub OAuth App callback URLs; the `stho.net` Bunny DNS zone must pre-exist (verified live) and the `BUNNYNET_API_KEY` account key must carry DNS permissions.
- **Cutover:** brief prod blip accepted (new Caddy cert issues on cutover); old `webredirect.org` records destroyed — old URLs and un-upgraded CLIs stop working. Not in scope: the EventBus consumer pipeline, the sandbox boundary, and the manifest format (untouched).
