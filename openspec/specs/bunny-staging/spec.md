# bunny-staging Specification

## Purpose
TBD - created by archiving change staging-bunny-magic-containers. Update Purpose after archive.
## Requirements
### Requirement: Magic Containers staging app via the bunnynet provider

The `infrastructure/` project SHALL declare the `bunnynet` provider and exactly one `bunnynet_compute_container_app` resource for staging. The app SHALL reference image `ghcr.io/stefanhoelzl/workflow-engine:main` (a `linux/amd64` image), SHALL set `autoscaling_min` and `autoscaling_max` both to `1`, and SHALL pin a single EU region (Frankfurt) via `regions_required`. The container SHALL expose the app's listen port (8080) and SHALL set `PERSISTENCE_PATH=/data`. Prod SHALL NOT be deployed to Magic Containers by this change — it remains entirely on the Scaleway VPS.

#### Scenario: Staging app exists after apply

- **WHEN** `tofu -chdir=infrastructure apply` completes
- **THEN** exactly one `bunnynet_compute_container_app` SHALL exist referencing `:main`
- **AND** it SHALL run with one replica in the Frankfurt region
- **AND** no `bunnynet_compute_container_app` SHALL reference the prod image `:release`

#### Scenario: Prod is untouched

- **WHEN** the plan for this change is inspected
- **THEN** no `scaleway_*` resource serving prod SHALL be created, replaced, or destroyed
- **AND** the prod Dynu record SHALL be unchanged

### Requirement: Staging persistent volume mounted at /data

The staging app SHALL declare one `bunnynet` volume mounted at `/data` so the libSQL EventStore database (`events.db`) and uploaded tenant bundles have a persistence path. Durability is **accept-loss**: Bunny volumes have no backups or replication and reattachment across reschedule is not guaranteed. This change SHALL NOT add backup, replication, sentinel, or forced-reschedule instrumentation; the risk SHALL be documented, not mitigated.

#### Scenario: Volume mounted at the persistence path

- **WHEN** the rendered `bunnynet_compute_container_app` is inspected
- **THEN** it SHALL declare exactly one volume mounted at `/data`
- **AND** the container env SHALL set `PERSISTENCE_PATH=/data`

#### Scenario: No durability instrumentation is added

- **WHEN** the change's infrastructure and CI files are inspected
- **THEN** no backup job, replication config, or volume-sentinel/forced-reschedule test SHALL be present
- **AND** the accept-loss posture SHALL be documented in `docs/` or the change design

### Requirement: CDN endpoint provides managed HTTPS for staging

The staging app SHALL expose a CDN-type endpoint (NOT Anycast) routing HTTP(S) to the container's 8080 port, providing automatic TLS. The hostname `staging.workflow-engine.webredirect.org` SHALL be attachable to this endpoint as a custom hostname so `BASE_URL` and the GitHub OAuth callback remain unchanged from the VPS deployment.

#### Scenario: CDN endpoint serves the staging hostname over HTTPS

- **GIVEN** the staging Dynu record points at the Bunny CDN endpoint and Bunny has issued the cert
- **WHEN** an external client runs `curl -I https://staging.workflow-engine.webredirect.org/readyz`
- **THEN** the response SHALL be served over a valid TLS chain
- **AND** the endpoint type SHALL be CDN, not Anycast

### Requirement: CDN SHALL NOT cache dynamic routes (gating observation)

The deployment SHALL rely on Bunny's CDN defaults with no pre-built edge rules. Before this deployment shape is ever proposed for prod, it SHALL be verified by observation that the CDN does not cache dynamic (authenticated/owner-scoped) responses — only `/static/*` (which the app marks `Cache-Control: public, max-age=…, immutable`) may be cached. A cache hit on a dynamic route is a cross-owner data leak (`SECURITY.md §4`). If observation shows dynamic routes being cached, the deployment SHALL be remediated with an edge rule forcing cache-time 0 except `/static/*`, or by switching the endpoint to Anycast.

#### Scenario: Dynamic routes observed uncached

- **WHEN** a dynamic route is requested twice as two different sessions via `curl -D-`
- **THEN** the responses SHALL show no CDN cache hit (`cdn-cache: MISS` or no caching)
- **AND** each session SHALL receive only its own response (no cross-session bleed)

#### Scenario: Static assets may be cached

- **WHEN** a `/static/*` asset is requested
- **THEN** it MAY be served from CDN cache (the app marks it immutable)

#### Scenario: Caching of a dynamic route forces remediation

- **GIVEN** the curl observation shows a dynamic route served from CDN cache
- **WHEN** the deployment is assessed
- **THEN** it SHALL NOT be advanced toward prod until an edge rule (cache-time 0 except `/static/*`) or an Anycast endpoint removes the dynamic-route caching

### Requirement: Staging secrets as plaintext env on the platform

The staging app's `bunnynet` `env` block SHALL carry the staging configuration and secrets (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `AUTH_ALLOW`, `BASE_URL`, `PORT`, `PERSISTENCE_PATH`, and the workflow-secrets sealing key) sourced from `TF_VAR_*` values. Because Magic Containers has no secret store, env values are plaintext at the platform. Secret values SHALL NOT appear in committed `*.tfvars`; they SHALL be encrypted at rest only in tofu state (the existing `encryption {}` block).

Because the `bunnynet` provider does NOT mark `env.value` as sensitive (it renders unredacted in plan output, which `plan-infra.yml` pipes into `$GITHUB_STEP_SUMMARY`), every secret-bearing `TF_VAR_*` input SHALL be declared `sensitive = true` so Terraform redacts it in plan output.

#### Scenario: Secrets reach the app without entering committed source

- **WHEN** the repository is inspected
- **THEN** no staging secret value SHALL appear in any committed `*.tfvars` file
- **AND** the secret values SHALL be supplied via `TF_VAR_*` and rendered into the `bunnynet` `env` block

#### Scenario: Secrets do not leak into the plan-infra step summary

- **GIVEN** secret-bearing `TF_VAR_*` inputs are declared `sensitive = true`
- **WHEN** `plan-infra` renders the plan into `$GITHUB_STEP_SUMMARY`
- **THEN** the staging OAuth client secret and sealing key SHALL appear as `(sensitive value)`, not in cleartext

### Requirement: Staging readiness probe on /livez (not /readyz)

The staging app SHALL declare a `readiness_probe` of type `http` with path **`/livez`** against the container port — NOT `/readyz`. `/readyz` runs deep health checks that self-reach the app's own public `BASE_URL` (the `domain` and `webhooks` checks fetch `https://staging…/healthz` and `/webhooks/`). During a deploy, Bunny serves a "We're deploying" 503 on that hostname UNTIL the readiness probe passes, so gating readiness on `/readyz` deadlocks: the pod boots and listens but can never satisfy its own self-check, and Bunny retries the pod indefinitely. `/livez` returns 200 unconditionally once the process is listening, so the pod goes ready, Bunny routes traffic, and `/readyz`'s self-checks then pass. (The deploy pipeline still polls `/readyz` for the full-health + gitSha gate; only Bunny's traffic-gating probe uses `/livez`.)

#### Scenario: Probe targets /livez

- **WHEN** the rendered `bunnynet_compute_container_app` is inspected
- **THEN** it SHALL declare a `readiness_probe` with `http` path `/livez` on the container's listen port

#### Scenario: A redeploy recovers without a readiness deadlock

- **GIVEN** the app is being redeployed (new image digest)
- **WHEN** the new pod boots and begins listening
- **THEN** `/livez` SHALL return 200 and Bunny SHALL mark the pod ready and route traffic
- **AND** `/readyz` SHALL subsequently report `status: pass` once Bunny routes the app's own self-reach checks

### Requirement: Staging deploy rolls Bunny forward without Terraform image drift

The `deploy-staging.yml` workflow SHALL, after building and pushing `ghcr.io/stefanhoelzl/workflow-engine:main` and capturing the pushed image digest, roll the staging app forward by updating the container's image to that digest (`image_tag: main` + `image_digest: <digest>`), and then poll the Bunny-served `/readyz` until `version.gitSha` equals the pushed `github.sha`. This step SHALL NOT invoke `tofu`. The image update MAY use the official `BunnyWay/actions/container-update-image` action or an equivalent inline `curl` PATCH of `/mc/apps/{id}/containers/{cid}`; if a third-party action is used it SHALL be pinned to a commit SHA (not a moving ref) because it receives `BUNNYNET_API_KEY`. The app id SHALL be resolved by name so the workflow survives an app recreation.

Updating the container image is the only documented Magic Containers rolling-update trigger (a `/deploy` or `/restart` call does not re-pull), so a **changing digest** per deploy is required. Because CI and Bunny's own deploy/rolling-update mutate container-image fields out-of-band and the `bunnynet` provider manages them as resource attributes, the app resource SHALL declare `lifecycle { ignore_changes = [container[0].image_tag, container[0].image_digest, container[0].image_pull_policy] }` so Terraform does not revert them. (`image_pull_policy` is included because Bunny resets it to its default `IfNotPresent` on deploy; this is harmless under digest-pinning, where each new digest is pulled regardless of policy.) `container.image_tag` SHALL remain `"main"` in config. The `plan-infra` empty-plan gate MUST remain green after a deploy.

#### Scenario: Push to main rolls the Bunny app and confirms the SHA

- **WHEN** a commit is pushed to `main` and the image is pushed to `:main`
- **THEN** the workflow SHALL trigger a Bunny rollout for the staging app
- **AND** SHALL poll `/readyz` until `version.gitSha === <github.sha>`
- **AND** no step SHALL invoke `tofu`

#### Scenario: A CI deploy does not break the empty-plan gate

- **GIVEN** the staging app has been rolled forward by a CI deploy
- **WHEN** `plan-infra` runs on a subsequent PR
- **THEN** the plan SHALL be empty for the staging app's image fields (no drift to revert)

#### Scenario: Bunny API key is the only new deploy secret

- **WHEN** `.github/workflows/deploy-staging.yml` is inspected
- **THEN** the only secret added for the Bunny rollout SHALL be `BUNNYNET_API_KEY`
- **AND** no `TF_VAR_*` or SSH key SHALL be referenced by the rollout step

