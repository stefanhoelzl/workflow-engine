## MODIFIED Requirements

### Requirement: Caddyfile renders one site block per env

The Caddyfile SHALL be rendered by tofu (via `templatefile()`) with one site block per env:

- `workflow-engine.stho.net { tls <acme-email> ; reverse_proxy 127.0.0.1:8081 }`
- `staging.workflow-engine.stho.net { tls <acme-email> ; reverse_proxy 127.0.0.1:8082 }`

The hostnames SHALL be composed from a `base_domain` variable (default `stho.net`) as `workflow-engine.${base_domain}` and `staging.workflow-engine.${base_domain}`, so a future domain change is a single-variable edit. Note: staging's public hostname is served by Bunny Magic Containers, not the VPS; the staging site block remains rendered for the warm-fallback path but is not the live staging frontend.

Caddy's automatic HTTPS SHALL provide HTTP→HTTPS redirect, HSTS, and TLS termination via Let's Encrypt HTTP-01 ACME. ACME state SHALL persist on the host volume mounted at `/data` (i.e. `/srv/caddy/data` on the host).

#### Scenario: Prod hostname serves a publicly-trusted cert

- **GIVEN** the Bunny DNS A record for `workflow-engine.stho.net` has propagated to the VPS IP and Caddy has completed ACME
- **WHEN** an external client runs `curl -I https://workflow-engine.stho.net`
- **THEN** it SHALL return `200` (or whatever the app returns) with a valid Let's Encrypt-issued chain

## REMOVED Requirements

### Requirement: Dynu CNAMEs owned by tofu

**Reason**: DNS moves from the Dynu API (Mastercard `restapi` provider, `var.dynu_api_key`) onto Bunny DNS, managed by the existing `bunnynet` provider, and the canonical hostnames move from `*.webredirect.org` to `*.stho.net`. The `restapi` provider and `dynu_api_key` are removed entirely. Replaced by "Bunny DNS records owned by tofu" below.

**Migration**: Both DNS records are re-created on Bunny DNS under `stho.net` via a two-step targeted apply (DNS records first, then a full apply once `dig` confirms propagation). Old `webredirect.org` records are destroyed; old URLs and un-upgraded `wfe` CLIs stop resolving. The GitHub OAuth App callback URLs are updated in place to the stho.net hosts.

## ADDED Requirements

### Requirement: Bunny DNS records owned by tofu

The project SHALL manage exactly two DNS records under the `stho.net` zone via the `bunnynet` provider. The zone SHALL be referenced through a `data "bunnynet_dns_zone"` lookup (read-only); the project SHALL NOT own or create the `stho.net` zone, its apex, or any record other than the two below.

- `workflow-engine.stho.net` → **A record** to the Scaleway VPS public IP (`scaleway_instance_ip.vps.address`).
- `staging.workflow-engine.stho.net` → **CNAME** to the Bunny Magic Containers CDN endpoint host (`*.b-cdn.net`).

Both records SHALL set `ttl = 300`. `BASE_URL`, the Caddy prod site block, and the staging `bunnynet_pullzone_hostname` SHALL all use the same `base_domain`-composed hostnames. The project SHALL NOT reference the Dynu API, the `restapi` provider, or `var.dynu_api_key`.

Switching staging back to the VPS SHALL be a hand-edit of the staging record from a CNAME (Bunny CDN host) to an A record (VPS IP) followed by `tofu apply`; the project SHALL NOT introduce a `staging_backend` toggle variable.

#### Scenario: Prod A record resolves to the VPS

- **GIVEN** tofu apply has completed and Bunny DNS propagation has occurred
- **WHEN** `dig workflow-engine.stho.net` is run from an external resolver
- **THEN** it SHALL resolve to the Scaleway VPS public IP

#### Scenario: Staging hostname resolves to the Bunny CDN endpoint

- **GIVEN** tofu apply has completed and Bunny DNS propagation has occurred
- **WHEN** `dig staging.workflow-engine.stho.net` is run from an external resolver
- **THEN** it SHALL resolve (via CNAME) to the Bunny Magic Containers CDN endpoint host

#### Scenario: No Dynu / restapi provider remains

- **WHEN** the rendered `infrastructure/` project and its `.terraform.lock.hcl` are inspected
- **THEN** there SHALL be no `restapi` provider, no `provider "restapi"` block, no `Mastercard/restapi` lockfile entry, and no `var.dynu_api_key` reference

#### Scenario: tofu does not own the stho.net zone

- **WHEN** the DNS configuration is inspected
- **THEN** the `stho.net` zone SHALL be referenced via a `data "bunnynet_dns_zone"` source (not a `resource`)
- **AND** only the two `workflow-engine` subdomain records SHALL be managed; the apex and any sibling records SHALL NOT appear in the plan
