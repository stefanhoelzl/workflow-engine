## 1. Infra — domain + Bunny DNS

- [x] 1.1 Add `variable "base_domain"` (default `"stho.net"`) to `infrastructure/variables.tf`; remove `variable "dynu_api_key"`; update the OAuth-callback comment block to the stho.net URLs.
- [x] 1.2 In `infrastructure/main.tf`, compose `local.envs.prod.domain = "workflow-engine.${var.base_domain}"` and `local.envs.staging.domain = "staging.workflow-engine.${var.base_domain}"`; set `dns_node` to the zone-relative names (`workflow-engine` / `staging.workflow-engine`).
- [x] 1.3 In `infrastructure/main.tf`, remove the `provider "restapi"` block and the `restapi` entry from `required_providers`.
- [x] 1.4 Rewrite `infrastructure/dns.tf`: replace the two `restapi_object` resources with `data "bunnynet_dns_zone" "stho"` (lookup by `domain = var.base_domain`) + `bunnynet_dns_record.prod_a` (A → `scaleway_instance_ip.vps.address`) and `bunnynet_dns_record.staging_cname` (CNAME → `local.bunny_staging_cdn_host`), both `ttl = 300`, `zone = data.bunnynet_dns_zone.stho.id`, `name` from `dns_node`. No `depends_on` (preserves the two-step targeted-apply ordering).
- [x] 1.5 In `infrastructure/bunny-staging.tf`, confirmed `bunnynet_pullzone_hostname.staging.name` resolves to `local.bunny_staging.domain` (reads `local.envs["staging"].domain`) — no resource edit. Updated stale `Dynu`/"not wired yet" comments to the Bunny-DNS two-step-targeted-apply reality.
- [x] 1.6 Ran `tofu init -backend=false` to regenerate `.terraform.lock.hcl` (dropped `Mastercard/restapi`); lockfile staged.
- [x] 1.7 `tofu fmt -check -recursive infrastructure/` and `tofu -chdir=infrastructure validate` pass.
- [x] 1.8 Fix latent Caddy-reload bug surfaced at cutover: the `caddyfile` managed-file entry (`caddy.tf`) had `on_change = ""`, relying on `caddy_quadlet`'s restart — but a Caddyfile-only change (a domain swap) doesn't touch the quadlet, so the new config never loaded. Set a tolerant `on_change` that restarts `caddy.service` (with `|| true` for the first-apply / service-not-yet-present case). Makes the domain cutover self-contained (no manual Caddy restart).

## 2. CI, CLI default, docs

- [x] 2.1 `.github/workflows/plan-infra.yml`: removed the `TF_VAR_dynu_api_key` env line.
- [x] 2.2 `infrastructure/.proton.yaml`: removed the `TF_VAR_dynu_api_key` mapping.
- [x] 2.3 `.github/workflows/deploy-staging.yml`: changed the readiness `URL` and the `wfe upload --url` to `https://staging.workflow-engine.stho.net`.
- [x] 2.4 `.github/workflows/deploy-prod.yml`: changed the environment `url` to `https://workflow-engine.stho.net`.
- [x] 2.5 Flipped the `wfe` CLI built-in default base URL (`packages/sdk/src/cli/cli.ts` `DEFAULT_URL`) to `https://workflow-engine.stho.net`. No test hardcodes the URL literal (verified via grep), so no test edit needed.
- [x] 2.6 `README.md`: updated both `workflow-engine.webredirect.org` references to the stho.net default.
- [x] 2.7 `docs/infrastructure.md`: updated prod/staging URLs, the DNS-provider description (Bunny DNS via data-source), the `dns.tf` comment, removed the `TF_VAR_dynu_api_key` secret entry, the staging-revert note (CNAME→A on Bunny DNS), and corrected the stale "staging Bunny cutover not yet wired" note.

## 3. Local verification

- [x] 3.1 `pnpm validate` passes (lint + check + test + `tofu fmt -check -recursive` + `tofu validate`) — exit 0.
- [x] 3.2 No `pnpm dev` boot performed: this change has no runtime behaviour `pnpm dev` would exercise. The only app-surface change is the `wfe` CLI `DEFAULT_URL` constant, which is the `--url` flag default; `pnpm check` confirms it compiles and it is wired as `default: DEFAULT_URL`. `pnpm dev` passes an explicit `--url http://localhost:<port>`, so it never exercises the default — a boot would add zero signal.
- [x] 3.3 Grepped `webredirect`/`dynu`/`restapi`: the only live straggler was `SECURITY.md` (the `dns.tf` file-pointer) — fixed. Remaining hits are in `openspec/specs/*` (canonical specs, rewritten at archive time by this change's delta specs) — correct to leave.

## 4. Cluster smoke (human)

> Operator-driven; agents do NOT run `tofu apply`. There is NO `apply-infra` workflow in this repo — every apply below is a LOCAL `tofu -chdir=infrastructure apply` run with the usual tofu env (`TF_VAR_*` + AWS/SCW creds per `.proton.yaml`). Order is load-bearing to avoid a Let's Encrypt lockout. Runs from the feature branch's working tree.

- [x] 4.1 Pre-flight: confirmed `dig NS stho.net` → kiki/coco.bunny.net and both new hostnames resolved to nothing; `data.bunnynet_dns_zone.stho` read succeeded at apply (zone `817890`), confirming the `BUNNYNET_API_KEY` has DNS-zone access.
- [x] 4.2 Updated BOTH GitHub OAuth Apps' callback URLs in place to the stho.net `/auth/github/callback` hosts (no secret rotation).
- [x] 4.3 `tofu init` (real S3 backend) — note: this RE-ADDED `mastercard/restapi` to the lockfile because the two Dynu records were still in state (init pulls providers required by state, not just config). Cleared by 4.4 + lockfile re-prune.
- [x] 4.4 `tofu state rm 'restapi_object.dns_a_record["prod"]' restapi_object.dns_staging_cname` — `Successfully removed 2 resource instance(s).` Records stayed live in Dynu; prod uninterrupted.
- [x] 4.5 Apply #1 (DNS only) — `Plan: 2 to add, 0 to change, 0 to destroy`; both `bunnynet_dns_record` created (A → 163.172.161.96, CNAME → mc-p5hgd353u8.b-cdn.net).
- [x] 4.6 Propagation confirmed via `@1.1.1.1`: prod A → VPS IP; staging CNAME → Bunny CDN.
- [x] 4.7 Apply #2 (full) — `4 to add, 1 to change, 4 to destroy`: pullzone hostname renamed to stho.net (cert validated first try), Caddyfile reloaded (1.8 fix), both Quadlets restarted with new BASE_URL, staging app BASE_URL updated, `urls` output flipped.
- [x] 4.8 Verified: prod `/readyz` → **200** over a valid LE chain (`workflow-engine.stho.net`); staging `/livez` and `/readyz` → **200** after the container roll, valid LE chain (`staging.workflow-engine.stho.net`). A 200 on `/readyz` confirms the BASE_URL `domain`/`webhooks` self-checks pass. GitHub OAuth login confirmed working on both hosts (operator, browser).
- [x] 4.x Lockfile re-pruned: real `init` had re-added `mastercard/restapi`; after 4.4 cleared it from state, the stanza was removed so the committed `.terraform.lock.hcl` is restapi-free (matches what a fresh CI `init` will produce).
- [ ] 4.9 Commit + push the branch; confirm the pre-merge `plan (vps)` gate reports an **empty plan** (config fully reconciled on the branch), then merge.
- [ ] 4.10 Cleanup: delete the two `*.workflow-engine.webredirect.org` records in the Dynu dashboard (orphaned by 4.4; low urgency — Caddy no longer holds a webredirect cert). Retire the Dynu key/secret from the secret store (`BUNNYNET_API_KEY` is now the only DNS credential).
