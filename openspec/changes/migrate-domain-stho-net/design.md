## Context

Today prod runs on the Scaleway VPS behind Caddy (`workflow-engine.webredirect.org` → A → VPS IP, Caddy HTTP-01 cert) and staging runs on Bunny Magic Containers (`staging.workflow-engine.webredirect.org` → CNAME → `mc-p5hgd353u8.b-cdn.net`, Bunny-issued cert via `bunnynet_pullzone_hostname`). Both are verified live. DNS is managed by a second provider — the Mastercard `restapi` provider hitting the Dynu API with `var.dynu_api_key`.

`stho.net` is registered (Scaleway) and delegated to Bunny DNS (`kiki/coco.bunny.net`, verified). The `bunnynet` provider is already in the project for Magic Containers compute; it also exposes `bunnynet_dns_zone` (data source) and `bunnynet_dns_record`.

Two project constraints shape the cutover:
1. **Empty-plan gate.** `plan-infra.yml` fails the merge unless `tofu plan` is empty. The operator runs `apply-infra` from the feature branch *before* review, so the committed config is the final desired state and convergence happens on the branch.
2. **Bunny TLS validation.** Bunny issues the staging Let's Encrypt cert the moment `tls_enabled` flips true, and only if the CNAME already resolves to Bunny — otherwise it fails ("domain is not pointing to our servers"). Thrashing risks a ~1-week LE lockout.

## Goals / Non-Goals

**Goals:**
- Serve both envs on `stho.net` with TLS, retiring `webredirect.org` and the Dynu/`restapi` provider entirely.
- Manage the two stho.net subdomain records in tofu via the existing `bunnynet` provider.
- Keep the cutover to a single OpenSpec change / single PR while respecting the empty-plan gate and avoiding an LE lockout.

**Non-Goals:**
- Owning or mutating the `stho.net` zone itself or its apex / any non-workflow-engine records (zone is referenced read-only via a data source).
- Changing the TLS *mechanism* (Caddy HTTP-01 for prod; Bunny-managed for staging) or moving prod off the VPS.
- A `staging_backend` toggle, dual-domain operation, or a webredirect→stho.net redirect (hard cutover).
- Any app/runtime, EventBus, sandbox, or manifest change.

## Decisions

### D1 — DNS on the `bunnynet` provider via a zone data source
Replace the two Dynu `restapi_object` records with `data "bunnynet_dns_zone" "stho"` (lookup `stho.net`) + two `bunnynet_dns_record` resources: A (prod → `scaleway_instance_ip.vps.address`) and CNAME (staging → `local.bunny_staging_cdn_host`), `ttl = 300`, `zone = data.bunnynet_dns_zone.stho.id`.
- *Why:* one provider/credential; the zone is on Bunny anyway; data-source (not resource) means tofu never owns the zone or sibling records.
- *Alternative rejected:* manage records by hand in the Bunny UI — leaves DNS out of IaC and the staging→CDN-host coupling becomes a manual, drift-prone step.

### D2 — One PR, two-step **targeted** apply, `tls_enabled = true` committed throughout
The committed config carries the staging hostname at `tls_enabled = true` (final state). The operator reaches an empty plan in two ordered applies on the branch:
1. `tofu apply -target=bunnynet_dns_record.prod_a -target=bunnynet_dns_record.staging_cname` — creates DNS only.
2. After `dig` confirms both resolve: `tofu apply` — Caddy reloads the new site block (prod HTTP-01 cert issues, A is live) and the Bunny hostname validates first try (CNAME is live).
- *Why:* this repo already documents the same two-step targeted-apply pattern for the Dynu A→CNAME swap, so it's a known operator motion. It keeps the two-phase TLS dance as an *apply-ordering* detail rather than two committed states, honoring "both envs, one change."
- *Alternative rejected:* two PRs (phase-1 `tls_enabled=false`, phase-2 `true`) as the original Bunny cutover did — safest against an LE lockout but splits the change. Recorded here so we can fall back if Bunny validation proves less forgiving than expected.
- *Alternative rejected:* single non-targeted apply with `tls=true` — the hostname and CNAME are created in the same pass, so Bunny validates before propagation and burns an LE attempt.

### D3 — `base_domain` variable
Introduce `variable "base_domain" { default = "stho.net" }` and compose `local.envs[*].domain` as `workflow-engine.${base_domain}` / `staging.workflow-engine.${base_domain}`.
- *Why:* the FQDN appears across `local.envs`, Caddy, BASE_URL, the pullzone hostname, and DNS record names; a single var makes the next swap one line.
- *Alternative rejected:* keep literal strings — better grep-ability, but five hardcoded copies invite drift.

### D4 — OAuth callback URLs updated in place (manual)
Edit the two existing GitHub OAuth Apps' callback URLs to the stho.net hosts. No client-id/secret rotation, no new GHA secrets.
- *Why:* simplest; the four `gh_oauth_*` secrets stay valid. The brief window where webredirect logins break is acceptable under hard cutover.

### D5 — Retire Dynu fully, including the lockfile
Remove the `restapi` provider block + `required_providers` entry, `var.dynu_api_key`, the `TF_VAR_dynu_api_key` lines in `plan-infra.yml` and `.proton.yaml`, and commit the regenerated `.terraform.lock.hcl` (drops `Mastercard/restapi`).
- *Why:* `ci.yml`'s `git diff --exit-code` lockfile gate flaps unless the regenerated lockfile is committed in the same PR.

## Cutover sequence

```
[pre]  Edit both GitHub OAuth App callback URLs → stho.net hosts
  │
[apply #1]  tofu apply -target prod_a -target staging_cname   (DNS only)
  │
[wait]  dig @resolver workflow-engine.stho.net  → VPS IP
        dig @resolver staging.workflow-engine.stho.net → CNAME → Bunny
  │
[apply #2]  tofu apply  (full)
  │   ├─ local.envs.domain flips → Caddyfile re-renders → Caddy HTTP-01 prod cert
  │   ├─ bunnynet_pullzone_hostname (tls_enabled=true) → staging cert validates
  │   ├─ BASE_URL flips on both apps (brief prod blip)
  │   └─ Dynu records + restapi provider destroyed; webredirect goes dark
  │
[gate]  plan (vps) → empty → merge
  │
[verify]  curl -I https://workflow-engine.stho.net/readyz   → 200
          curl -I https://staging.workflow-engine.stho.net/livez → 200
          OAuth login on both hosts
```

## Risks / Trade-offs

- **LE lockout from premature staging validation** → D2's targeted apply creates the CNAME first; the operator gates apply #2 on `dig`. Fallback: split to the two-PR phase-1/phase-2 shape.
- **`/readyz` red during the cutover window** (its `domain`/`webhooks` checks self-reach the new BASE_URL before DNS/cert settle) → expected and transient; verify *after* apply #2 converges. Staging's Bunny readiness probe already uses `/livez`, so it doesn't deadlock.
- **`BUNNYNET_API_KEY` lacking DNS scope** → it's an account key (provider requires account, not team-member, keys); confirm DNS-zone permission before apply #1.
- **Prod cert issuance delay** (Caddy HTTP-01 on the new name) → A record must be live first (ordering in D2); brief blip accepted per the hard-cutover choice.
- **Un-upgraded `wfe` CLIs / old bookmarks break** when webredirect is destroyed → intended consequence of retiring the domain; the CLI default flip + README update land in the same change.

## Open Questions

- Exact `data "bunnynet_dns_zone"` lookup attribute (likely `domain = "stho.net"`) — confirm against the installed `~> 0.15` provider schema when writing the HCL.
- Whether `apply-infra` (workflow_dispatch) can run a `-target`ed apply or whether apply #1 must be an operator *local* apply (docs already describe local applies with `TF_VAR_bunnynet_api_key`).
