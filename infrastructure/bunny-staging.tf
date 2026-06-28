# ─────────────────────────────────────────────────────────────────────────────
# Staging on bunny.net Magic Containers
#
# Bunny is the SOLE staging backend. Prod stays entirely on the VPS, untouched;
# there is no VPS staging stack and no warm fallback. See docs/infrastructure.md
# "Staging on bunny.net Magic Containers".
#
# Live: the staging hostname (staging.workflow-engine.<base_domain>) resolves via
# the Bunny DNS CNAME (dns.tf) to this app's CDN pull-zone host, and deploy-
# staging.yml rolls it forward by PATCHing the container image digest.
# ─────────────────────────────────────────────────────────────────────────────

provider "bunnynet" {
  api_key = var.bunnynet_api_key
}

# Talks to the Bunny Database management API (https://api.bunny.net/database) to
# mint the staging libSQL access token. Same account credential the bunnynet
# provider uses (AccessKey header = var.bunnynet_api_key) — no new secret.
provider "restful" {
  base_url = "https://api.bunny.net/database"
  header = {
    AccessKey = var.bunnynet_api_key
  }
}

# Public GitHub Container Registry (ghcr.io). `username = ""` selects bunny's
# built-in PUBLIC registry connection — no token needed for a public image.
# `container.image_registry` is a numeric ID, which is why this data source
# exists (a registry *resource* is only needed for PRIVATE images).
data "bunnynet_compute_container_imageregistry" "github_public" {
  registry = "GitHub"
  username = ""
}

locals {
  # Staging config. Bunny is staging's only home, so this lives here (its sole
  # consumer) rather than in local.envs (which enumerates VPS-hosted envs).
  # dns.tf's staging CNAME and outputs.tf's staging URL also read from here.
  bunny_staging = {
    domain         = "staging.workflow-engine.${var.base_domain}"
    dns_node       = "staging.workflow-engine"
    auth_allow     = "github:user:stefanhoelzl"
    retention_days = 1
  }

  # The app's CDN pull-zone *.b-cdn.net host (pull zone 6058886). The Bunny DNS
  # staging CNAME (dns.tf) targets this. NOTE: this changes if the app / pull
  # zone is ever recreated — re-read it with:
  #   tofu state show bunnynet_compute_container_app.staging | grep pullzone_id
  #   curl -s https://api.bunny.net/pullzone/<id> -H "AccessKey: $KEY" | grep -o '[a-z0-9-]*\.b-cdn\.net'
  bunny_staging_cdn_host = "mc-p5hgd353u8.b-cdn.net"
}

# Per-Bunny-app X25519 sealing key for the workflow-secrets feature. Standalone
# (not the apps.tf random_bytes.secrets_key map, which is keyed over local.envs =
# VPS envs only). 32 random bytes, base64-encoded; runtime format `keyId:base64`.
# Generated once, preserved across applies. Rotate with
# `tofu taint random_bytes.staging_secrets_key` + apply.
resource "random_bytes" "staging_secrets_key" {
  length = 32
}

# Durable bundle storage for staging. The Magic Containers volume is accept-loss,
# so workflow bundles (workflows/<owner>/<repo>.tar.gz) live here instead. The
# event-store/queue database lives on the managed Bunny Database below — so the
# staging container holds NO local state and needs no volume. Prod (VPS) stays on
# the `fs` backend. Frankfurt (DE) main region matches the staging app region and
# the Scaleway fr-par footprint.
#
# The read-write access key is the resource's own `password` attribute (provider-
# marked sensitive), wired straight into the app env below — no TF_VAR / GHA
# secret is introduced for it, and it stays out of the plan-infra step summary.
resource "bunnynet_storage_zone" "staging_bundles" {
  name      = "wfe-staging-bundles"
  region    = "DE"
  zone_tier = "Standard"
}

# Managed Bunny Database (libSQL) backing staging's event-store + per-workflow
# queues. Single primary in Frankfurt (DE) to match the always-on container
# region; no read replicas (single writer, lowest latency).
#
# Accept-loss, like the bundle zone: Bunny Database is in public preview (1 GB/DB,
# NO automatic backups or replication). Staging data is low-stakes and CI re-
# uploads demo bundles every boot. The provider outputs only `id` + `url`; the
# access token is minted separately below.
resource "bunnynet_database" "staging" {
  name            = "wfe-staging"
  regions_primary = ["DE"]
}

# Mint the libSQL access token in-tofu, mirroring how the staging sealing key
# (random_bytes.staging_secrets_key) is generated into state. A Bunny Database
# token is shown-once + non-idempotent + has no read-back, so it is NOT a
# bunnynet_database attribute — this one-shot PUT performs the action and captures
# the JWT. `use_sensitive_output` keeps the token in `sensitive_output` so it
# never reaches the plan-infra step summary (the bunnynet provider does NOT mark
# env.value sensitive, so the source attribute must be).
#
# restful_operation is create-only (no Read, no drift re-issue): with a static
# path/method/body it never re-mints on plan. `path` interpolates the database id,
# so a database REPLACEMENT correctly re-mints for the new id. On destroy it POSTs
# the revoke endpoint — which invalidates ALL tokens for THIS database (safe now:
# this DB is staging's sole consumer; a future-prod hazard if ever shared).
resource "restful_operation" "staging_db_token" {
  path   = "/v2/databases/${bunnynet_database.staging.id}/auth/generate"
  method = "PUT"

  body = {
    authorization = "full-access"
    expires_at    = null
  }

  use_sensitive_output = true

  delete_method = "POST"
  delete_path   = "/v2/databases/${bunnynet_database.staging.id}/auth/revoke"
}

resource "bunnynet_compute_container_app" "staging" {
  # Resource schema version (provider made a backwards-incompatible change in
  # v0.11.0 that turned container/endpoint/env into ordered lists). Required.
  version = 2

  name = "wfe-staging"

  # One always-on replica pinned to Frankfurt (DE). No autoscaling spread.
  # regions_max_allowed MUST be set explicitly: leaving it null makes the API
  # default it to 5, which then fails tofu's post-apply consistency check
  # ("was null, but now 5"). With a single allowed region, 1 is the intent.
  regions_required    = ["DE"]
  regions_allowed     = ["DE"]
  regions_max_allowed = 1
  autoscaling_min     = 1
  autoscaling_max     = 1

  # No volume: staging is fully stateless. The event-store/queue database is on
  # the managed Bunny Database and workflow bundles are on Bunny Edge Storage
  # (both remote, declared above) — nothing is written to local disk. PERSISTENCE_PATH
  # stays set (the runtime config requires it) but is never touched when
  # STORAGE_BACKEND=bunny + a remote DATABASE_URL are in effect.
  container {
    name = "wfe"

    # ghcr.io/stefanhoelzl/workflow-engine:main. The TAG is stable; only the
    # digest moves per deploy. image_pull_policy = Always so a rollout re-pulls
    # the latest :main WITHOUT changing any TF-managed image field — this is
    # what avoids the CI-image-PATCH-vs-Terraform drift footgun (design D5).
    # Do NOT pin image_digest here (that would reintroduce per-deploy drift).
    image_registry    = data.bunnynet_compute_container_imageregistry.github_public.id
    image_namespace   = "stefanhoelzl"
    image_name        = "workflow-engine"
    image_tag         = "main"
    image_pull_policy = "Always"

    # CDN endpoint = managed HTTPS, the staging replacement for Caddy's TLS
    # termination. origin_ssl = false → edge-to-container is plaintext HTTP,
    # exactly like Caddy→app on the VPS today; let Bunny own the HTTP→HTTPS
    # redirect (no redirect loop). Keep this endpoint NAME stable post-cutover
    # — renaming a CDN endpoint can recreate the pull zone and orphan the cert.
    endpoint {
      name = "cdn"
      type = "CDN"

      # No `protocols` for a CDN endpoint — the provider rejects it (CDN is
      # HTTP(S) only; protocols apply to Anycast/InternalIP).
      port {
        container = 8080
      }

      cdn {
        origin_ssl = false
      }
    }

    # Readiness gate uses /livez (pure process-liveness), NOT /readyz.
    # /readyz self-reaches the app's own public BASE_URL (domain + webhooks
    # checks fetch https://staging…/healthz and /webhooks/). During a deploy
    # Bunny serves a "We're deploying" 503 on that hostname UNTIL readiness
    # passes — so gating readiness on /readyz deadlocks (pod boots fine but
    # can never satisfy its own self-check, Bunny retries it forever). /livez
    # returns 200 unconditionally once the process is listening → Bunny routes
    # traffic → and THEN /readyz's self-checks pass (and the deploy poll on
    # /readyz converges).
    readiness_probe {
      type = "http"
      port = 8080

      http {
        path = "/livez"
      }
    }

    # NOTE: env blocks MUST stay alphabetized by `name`. They are list-typed
    # (provider ≥ 0.11.0), so an unsorted order produces a perpetual plan diff.
    # Secrets flow from `sensitive = true` TF_VAR_* inputs; the provider does
    # NOT mark env.value sensitive, so that `sensitive` flag is what keeps the
    # values out of the plan-infra step summary.
    env {
      name  = "AUTH_ALLOW"
      value = local.bunny_staging.auth_allow
    }
    env {
      name  = "AUTH_PROVIDER"
      value = "github"
    }
    env {
      name  = "BASE_URL"
      value = "https://${local.bunny_staging.domain}"
    }
    # Remote managed Bunny Database (libSQL). DATABASE_AUTH_TOKEN selects the
    # runtime's remote client variant; its presence forbids DATABASE_WAL=true
    # (the config superRefine fails closed at boot), so DATABASE_WAL is omitted
    # entirely (defaults false). The token comes from the in-tofu mint's
    # sensitive_output so it stays redacted in plan output. DATABASE_URL is the
    # provisioned database's connection URL.
    env {
      name  = "DATABASE_AUTH_TOKEN"
      value = restful_operation.staging_db_token.sensitive_output.token
    }
    env {
      name  = "DATABASE_URL"
      value = bunnynet_database.staging.url
    }
    env {
      name  = "EVENT_STORE_RETENTION_DAYS"
      value = tostring(local.bunny_staging.retention_days)
    }
    env {
      name  = "GITHUB_OAUTH_CLIENT_ID"
      value = var.gh_oauth_client_id_staging
    }
    env {
      name  = "GITHUB_OAUTH_CLIENT_SECRET"
      value = var.gh_oauth_client_secret_staging
    }
    env {
      name  = "PERSISTENCE_PATH"
      value = "/data"
    }
    env {
      name  = "PORT"
      value = "8080"
    }
    env {
      name  = "SECRETS_PRIVATE_KEYS"
      value = "v1:${random_bytes.staging_secrets_key.base64}"
    }
    # Bundle storage on the durable Bunny Edge Storage zone above. STORAGE_BACKEND
    # selects it; the runtime factory reads the zone name + origin host + access
    # key. ACCESS_KEY references the zone's sensitive `password` attribute, so it
    # is redacted in plan output. ENDPOINT is the DE main-region storage origin
    # (never a CDN host — reads must be fresh).
    env {
      name  = "STORAGE_BACKEND"
      value = "bunny"
    }
    env {
      name  = "STORAGE_BUNNY_ACCESS_KEY"
      value = bunnynet_storage_zone.staging_bundles.password
    }
    env {
      name  = "STORAGE_BUNNY_ENDPOINT"
      value = "storage.bunnycdn.com"
    }
    env {
      name  = "STORAGE_BUNNY_STORAGE_ZONE"
      value = bunnynet_storage_zone.staging_bundles.name
    }
  }

  lifecycle {
    # CI rolls staging forward by PATCHing the container's image DIGEST — the
    # only documented Magic Containers rolling-update trigger (a /deploy or
    # /restart call does NOT re-pull; updating the container image does). TF
    # must not revert that, or the next `tofu apply` would roll staging back
    # AND break the plan-infra empty-plan gate. So CI owns the image
    # tag/digest; TF stops managing them here. image_tag stays "main" in config
    # as the floor; CI pins the exact digest per deploy.
    #
    # image_pull_policy is also ignored: Bunny's deploy/rolling-update resets it
    # to its default "IfNotPresent" out-of-band (observed live), which would
    # otherwise show as perpetual plan drift. It's harmless under digest-pinning
    # — each deploy pins a NEW digest, which isn't present and so is pulled
    # regardless of the policy. So Bunny owns this field too.
    ignore_changes = [
      container[0].image_tag,
      container[0].image_digest,
      container[0].image_pull_policy,
    ]
  }
}

# Custom hostname on the app's auto-created CDN pull zone. Wired directly to
# the endpoint's read-only pullzone_id (no data lookup needed — resolves the
# §4.1 question).
#
# LOAD-BEARING CUTOVER ORDERING (Bunny's documented flow). Bunny issues the
# free Let's Encrypt cert at the moment tls_enabled is true, and that validation
# REQUIRES this hostname's CNAME to already resolve to Bunny — otherwise it
# fails with "domain is not pointing to our servers". `tls_enabled` stays true
# in committed config; the ordering is enforced by a TWO-STEP TARGETED APPLY so
# the empty-plan gate still converges (see docs/infrastructure.md + the
# migrate-domain-stho-net change's design.md):
#   Step 1: tofu apply -target=bunnynet_dns_record.prod_a \
#                       -target=bunnynet_dns_record.staging_cname  (DNS only)
#   Step 2 (after `dig` shows the CNAME live, ~5 min): full `tofu apply`. Bunny
#     now validates the cert first try. Do NOT run step 2 before `dig` confirms
#     propagation — a premature validation can trigger an LE lockout (~1 week).
resource "bunnynet_pullzone_hostname" "staging" {
  pullzone = bunnynet_compute_container_app.staging.container[0].endpoint[0].cdn[0].pullzone_id
  name     = local.bunny_staging.domain
  # DNS resolves to Bunny (step 1 applied + propagated), so the managed Let's
  # Encrypt cert validates. force_ssl redirects HTTP→HTTPS at the edge.
  tls_enabled = true
  force_ssl   = true
}
