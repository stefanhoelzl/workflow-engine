## ADDED Requirements

### Requirement: Env-keyed Bunny deployment for staging and prod

The `infrastructure/` project SHALL deploy BOTH the `staging` and `prod`
environments on bunny.net Magic Containers through a single **env-keyed** Bunny
configuration (a `for_each`/locals map over `{ staging, prod }`), not two
copy-pasted files. There SHALL be no VPS-hosted application environment; the
Scaleway VPS and its Caddy reverse proxy do not exist after this change.

Each env SHALL declare exactly one `bunnynet_compute_container_app` with
`autoscaling_min = autoscaling_max = 1`, a single EU region (Frankfurt, `DE`),
the container listen port (8080), and `PERSISTENCE_PATH=/data` set (the runtime
config requires it, but it is never touched at runtime under
`STORAGE_BACKEND=bunny` + a remote `DATABASE_URL`). The `staging` app SHALL
reference image `ghcr.io/stefanhoelzl/workflow-engine:main`; the `prod` app SHALL
reference `ghcr.io/stefanhoelzl/workflow-engine:release`. Each app's
event-store and per-workflow queues SHALL run on that env's own remote Bunny
Database (`DATABASE_URL` from the env's `bunnynet_database` `url`,
`DATABASE_AUTH_TOKEN` set, `DATABASE_WAL` NOT set), and each app SHALL select the
Bunny Edge Storage bundle backend (`STORAGE_BACKEND=bunny` plus
`STORAGE_BUNNY_ENDPOINT`, `STORAGE_BUNNY_STORAGE_ZONE`,
`STORAGE_BUNNY_ACCESS_KEY`) pointed at that env's own zone. With both stores
remote, each container holds NO local state and runs with no `/data` volume.

#### Scenario: Both envs are single always-on Frankfurt apps

- **WHEN** the operator inspects the planned Bunny apps
- **THEN** there SHALL be exactly one `bunnynet_compute_container_app` per env (`staging`, `prod`), each with `autoscaling_min = autoscaling_max = 1` and a single Frankfurt region
- **AND** the `staging` app image SHALL be `…:main` and the `prod` app image SHALL be `…:release`
- **AND** each container env SHALL set `DATABASE_URL` to its env's `bunnynet_database` `url`, SHALL set `DATABASE_AUTH_TOKEN`, and SHALL NOT set `DATABASE_WAL`

#### Scenario: No VPS application environment remains

- **WHEN** the `infrastructure/` tofu is inspected
- **THEN** there SHALL be no `scaleway_instance_server`, no Caddy Quadlet, and no VPS-hosted `wfe-prod`/`wfe-staging` application unit
- **AND** both `staging` and `prod` SHALL resolve to Bunny CDN endpoints

### Requirement: State-preserving generalization via moved blocks

The refactor from the staging-only layout to the env-keyed layout SHALL preserve
existing resource state for BOTH envs via Terraform `moved {}` blocks, so the
plan shows MOVES, never destroy/create, for any resource carrying durable state
or identity. In particular:

- The **prod workflow-secrets sealing key** SHALL be preserved: the existing
  `random_bytes.secrets_key["prod"]` value SHALL be carried to its new env-keyed
  address by a `moved {}` block. A fresh key SHALL NOT be generated for prod —
  regenerating it would make every already-sealed tenant secret undecryptable
  until each external author re-uploads.
- The existing staging Bunny resources (app, CDN, `bunnynet_pullzone_hostname`,
  `bunnynet_database`, the `restful_operation` token mint, `bunnynet_storage_zone`,
  and the staging sealing key) SHALL likewise be carried by `moved {}` blocks so
  staging does not churn (no token re-mint, no sealing-key regeneration, no
  database replacement).

#### Scenario: Prod sealing key is moved, never regenerated

- **WHEN** the operator runs `tofu plan` for this change
- **THEN** no `random_bytes` resource SHALL be planned for destroy/create
- **AND** the prod sealing key SHALL appear as a `moved` address
- **AND** the rendered prod `SECRETS_PRIVATE_KEYS` value SHALL be byte-identical before and after the refactor

#### Scenario: Staging does not churn

- **WHEN** the operator runs `tofu plan` for this change
- **THEN** the staging app, CDN, hostname, database, token mint, storage zone, and sealing key SHALL appear as moves (or no-ops), not destroy/create

### Requirement: Per-env CDN endpoint provides managed HTTPS

Each env SHALL expose a CDN-type endpoint (NOT Anycast) routing HTTP(S) to the
container's 8080 port, providing automatic TLS — the replacement for the
retired Caddy TLS termination. Each env's public hostname
(`staging.workflow-engine.stho.net`, `workflow-engine.stho.net`) SHALL be
attachable as a custom hostname (`bunnynet_pullzone_hostname`,
`tls_enabled = true`, `force_ssl = true`) composed from the `base_domain`
variable, so `BASE_URL` and the GitHub OAuth callback resolve to the same public
host.

Because Bunny issues the managed Let's Encrypt cert at the moment `tls_enabled`
is true and only if the hostname's CNAME already resolves to Bunny, each env's
DNS CNAME (see the `infrastructure` capability) SHALL be created and propagated
BEFORE the apply that registers/validates that env's hostname — a two-step
targeted apply (records first, full apply after `dig` confirms). For the prod
cutover specifically, the prod CNAME flip and managed-TLS issuance SHALL complete
while the prod hostname's cert is live BEFORE the VPS is destroyed, so there is
no cert-issuance downtime gap.

#### Scenario: Each env serves its hostname over HTTPS from a CDN endpoint

- **GIVEN** an env's Bunny DNS CNAME points at its Bunny CDN endpoint and Bunny has issued the cert
- **WHEN** an external client runs `curl -I https://<env-hostname>/livez`
- **THEN** the response SHALL be served over a valid TLS chain
- **AND** the endpoint type SHALL be CDN, not Anycast

#### Scenario: Prod cert is live before the VPS is destroyed

- **WHEN** the prod cutover is performed
- **THEN** the prod DNS CNAME SHALL be flipped and the managed cert issued (verified) in an apply that runs BEFORE the apply that destroys the VPS

### Requirement: CDN SHALL NOT cache dynamic routes

The deployment SHALL rely on Bunny's CDN defaults with no pre-built edge rules.
For BOTH envs, the CDN SHALL NOT cache dynamic (authenticated/owner-scoped)
responses — only `/static/*` (which the app marks `Cache-Control: public,
max-age=…, immutable`) may be cached. A cache hit on a dynamic route is a
cross-owner data leak (`SECURITY.md §4`). This invariant was verified by
observation on staging and applies identically to prod (same image, same
response headers). If observation ever shows dynamic routes being cached, the
deployment SHALL be remediated with an edge rule forcing cache-time 0 except
`/static/*`, or by switching the endpoint to Anycast.

#### Scenario: Dynamic routes observed uncached on both envs

- **WHEN** an authenticated/owner-scoped route is requested through either env's CDN endpoint
- **THEN** the responses SHALL show no CDN cache hit (`cdn-cache: MISS` or no caching)
- **AND** each session SHALL receive only its own response (no cross-session bleed)

#### Scenario: Static assets may be cached

- **WHEN** a `/static/*` asset is requested through either env's CDN endpoint
- **THEN** it MAY be served from the CDN cache

### Requirement: Per-env Bunny Database provisioning and in-tofu token mint

The `infrastructure/` project SHALL provision a managed Bunny Database **per env**
and mint each one's access token within the same `tofu apply`. Each env SHALL
have its OWN `bunnynet_database` (`regions_primary = ["DE"]`, no
`regions_replica`) and its OWN minted token; staging and prod SHALL NOT share a
database or token, because Bunny's token revoke is database-wide and a shared
token would couple the two envs.

Each env's token SHALL be minted in-tofu via the `magodo/restful` provider's
`restful_operation` resource, which on create issues `PUT
https://api.bunny.net/database/v2/databases/{db_id}/auth/generate` with body
`{ "authorization": "full-access", "expires_at": null }` and header
`AccessKey = var.bunnynet_api_key`, capturing the response `token` into a
`sensitive` output (`use_sensitive_output = true`) feeding that env's
`DATABASE_AUTH_TOKEN`. The `{db_id}` SHALL be that env's `bunnynet_database.id`
so the operation is create-only (not re-minted on plan refresh; a database
replacement re-mints for the new id), and SHALL invoke `POST
…/auth/revoke` on destroy. No `DATABASE_AUTH_TOKEN` value SHALL be required as a
`TF_VAR_*` input — the account API key (`var.bunnynet_api_key`) is the only
credential needed.

#### Scenario: Each env has its own database and token

- **WHEN** the operator inspects the planned Terraform
- **THEN** there SHALL be one `bunnynet_database` per env (`regions_primary = ["DE"]`, no replicas)
- **AND** there SHALL be one `restful_operation` token mint per env, keyed on that env's database id
- **AND** the prod env SHALL NOT reference staging's database id or token (and vice versa)

#### Scenario: Token minted via an authenticated HTTP action, revoked on destroy

- **WHEN** the operator inspects an env's token-mint resource
- **THEN** it SHALL be a `magodo/restful` `restful_operation` issuing `PUT …/auth/generate` with `authorization = "full-access"` and `AccessKey = var.bunnynet_api_key`
- **AND** the captured token attribute SHALL be `sensitive` and feed that env's `DATABASE_AUTH_TOKEN`
- **AND** destroying it SHALL issue `POST …/auth/revoke` for that env's database

### Requirement: Per-env workflow-secrets sealing key

Each env SHALL have its OWN standalone workflow-secrets sealing key
(`random_bytes`, 32 bytes, base64, runtime format `v1:<base64>` in
`SECRETS_PRIVATE_KEYS`), generated once and preserved across applies in tofu
state. Keys SHALL NOT be shared across envs. The prod key value SHALL be the
SAME value as before this change (carried by a `moved {}` block — see the
"State-preserving generalization" requirement), so prod tenant secrets sealed
against it continue to decrypt with no author action. Rotating an env's key is
`tofu taint` on that env's key resource + apply.

#### Scenario: Each env has its own preserved key

- **WHEN** the rendered per-env `SECRETS_PRIVATE_KEYS` is inspected
- **THEN** staging and prod SHALL carry distinct sealing-key values
- **AND** the prod value SHALL equal its value prior to this change

### Requirement: Per-env readiness probe on /livez (not /readyz)

Each env's app SHALL declare a `readiness_probe` of type `http` with path
**`/livez`** against the container port — NOT `/readyz`. `/readyz` runs deep
checks that self-reach the app's own public `BASE_URL`; during a deploy Bunny
serves a 503 on that hostname until the readiness probe passes, so gating
readiness on `/readyz` deadlocks. `/livez` returns 200 once the process is
listening, so the pod goes ready, Bunny routes traffic, and `/readyz`'s
self-checks then pass. The deploy pipeline still polls `/readyz` for the
full-health + `gitSha` gate; only Bunny's traffic-gating probe uses `/livez`.

#### Scenario: Probe targets /livez on both envs

- **WHEN** an env's `bunnynet_compute_container_app` is inspected
- **THEN** it SHALL declare a `readiness_probe` with `http` path `/livez` on the container's listen port

### Requirement: Per-env secrets as plaintext env on the platform

Each env's `bunnynet` `env` block SHALL carry that env's configuration and
secrets (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `AUTH_ALLOW`,
`BASE_URL`, `PORT`, `PERSISTENCE_PATH`, the sealing key, `STORAGE_BUNNY_ACCESS_KEY`,
and `DATABASE_AUTH_TOKEN`). Config and OAuth/sealing secrets are sourced from
`TF_VAR_*` values; `STORAGE_BUNNY_ACCESS_KEY` comes from the env's
`bunnynet_storage_zone` `password` attribute and `DATABASE_AUTH_TOKEN` from the
env's in-tofu token mint. Because Magic Containers has no secret store, env
values are plaintext at the platform. Secret values SHALL NOT appear in committed
`*.tfvars`; they SHALL be encrypted at rest only in tofu state (the `encryption {}`
block). Because the `bunnynet` provider does NOT mark `env.value` sensitive,
every secret-bearing input SHALL be redacted in plan output: secret-bearing
`TF_VAR_*` inputs SHALL be `sensitive = true`; the storage-zone `password` is
provider-marked sensitive; the token-mint response feeding `DATABASE_AUTH_TOKEN`
SHALL be marked `sensitive`.

#### Scenario: Secrets reach each app without entering committed source

- **WHEN** the repository is inspected
- **THEN** no env's secret value SHALL appear in any committed `*.tfvars` file
- **AND** secret values SHALL be supplied via `TF_VAR_*` (or the storage-zone/token-mint resource attributes) and rendered into the `bunnynet` `env` block

#### Scenario: Secrets do not leak into the plan-infra step summary

- **WHEN** `plan-infra` renders the plan into the step summary
- **THEN** each env's OAuth client secret, sealing key, storage access key, and `DATABASE_AUTH_TOKEN` SHALL appear as `(sensitive value)`, not in cleartext

### Requirement: Per-env deploy rolls Bunny forward without Terraform image drift

Each env's deploy workflow SHALL roll that env's Bunny app forward by image digest. After building and pushing its image tag (`deploy-staging.yml` → `:main`, `deploy-prod.yml` → `:release`) and capturing the pushed digest, the workflow SHALL update the container image to that digest (`image_tag: <tag>` + `image_digest: <digest>`), then poll the Bunny-served `/readyz` until `version.gitSha` equals the pushed `github.sha`.
This step SHALL NOT invoke `tofu`. The image update MAY use the official
`BunnyWay/actions/container-update-image` action (SHA-pinned, because it receives
`BUNNYNET_API_KEY`) or an equivalent inline `curl` PATCH; the app id SHALL be
resolved by name. Updating the container image is the only rolling-update
trigger, so a changing digest per deploy is required. Each app SHALL declare
`lifecycle { ignore_changes = [container[0].image_tag, container[0].image_digest,
container[0].image_pull_policy] }` so neither CI nor a `tofu apply` reverts the
out-of-band image fields, keeping the `plan-infra` empty-plan gate green after a
deploy.

#### Scenario: Push rolls the correct env's app and confirms the SHA

- **WHEN** a push triggers an env's deploy workflow
- **THEN** the workflow SHALL roll that env's Bunny app to the pushed digest
- **AND** SHALL poll `/readyz` until `version.gitSha === <github.sha>`
- **AND** no step SHALL invoke `tofu`

#### Scenario: A CI deploy does not break the empty-plan gate

- **GIVEN** an env's app has been rolled forward by a CI deploy
- **WHEN** `plan-infra` runs on a subsequent PR
- **THEN** the plan SHALL be empty for that app's image fields (no drift to revert)
