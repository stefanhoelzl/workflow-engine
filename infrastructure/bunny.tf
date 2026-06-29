# ─────────────────────────────────────────────────────────────────────────────
# bunny.net Magic Containers deployment — env-keyed over { staging, prod }
#
# Both environments run on bunny.net Magic Containers. There is NO Scaleway VPS
# and no Caddy. Each env has its OWN app (image tag :main / :release), CDN
# endpoint (managed TLS), managed Bunny Database (libSQL) + minted token, Bunny
# Edge Storage bundle zone, and workflow-secrets sealing key — staging and prod
# share NOTHING (Bunny's token revoke is database-wide). See the
# `bunny-deployment` capability and docs/infrastructure.md.
#
# Live: each env's hostname resolves via a Bunny DNS CNAME (dns.tf) to that
# env's CDN pull-zone host; deploy-{staging,prod}.yml roll the app forward by
# PATCHing the container image digest.
# ─────────────────────────────────────────────────────────────────────────────

provider "bunnynet" {
  api_key = var.bunnynet_api_key
}

# Talks to the Bunny Database management API (https://api.bunny.net/database) to
# mint each env's libSQL access token. Same account credential the bunnynet
# provider uses (AccessKey header = var.bunnynet_api_key) — no new secret.
provider "restful" {
  base_url = "https://api.bunny.net/database"
  header = {
    AccessKey = var.bunnynet_api_key
  }
}

# Public GitHub Container Registry (ghcr.io). `username = ""` selects bunny's
# built-in PUBLIC registry connection — no token needed for a public image.
data "bunnynet_compute_container_imageregistry" "github_public" {
  registry = "GitHub"
  username = ""
}

locals {
  # Single source of truth for the per-env Bunny deployment. Adding an env is a
  # new key here. dns.tf and outputs.tf also iterate this map.
  bunny_envs = {
    staging = {
      domain                 = "staging.workflow-engine.${var.base_domain}"
      dns_node               = "staging.workflow-engine"
      image_tag              = "main"
      auth_allow             = "github:user:stefanhoelzl"
      retention_days         = 1
      gh_oauth_client_id     = var.gh_oauth_client_id_staging
      gh_oauth_client_secret = var.gh_oauth_client_secret_staging
      # The app's CDN pull-zone *.b-cdn.net host. The Bunny DNS CNAME (dns.tf)
      # targets this. NOTE: changes if the app / pull zone is ever recreated —
      # re-read with:
      #   tofu state show 'bunnynet_compute_container_app.app["<env>"]' | grep pullzone_id
      #   curl -s https://api.bunny.net/pullzone/<id> -H "AccessKey: $KEY" | grep -o '[a-z0-9-]*\.b-cdn\.net'
      cdn_host = "mc-p5hgd353u8.b-cdn.net"
    }
    prod = {
      domain                 = "workflow-engine.${var.base_domain}"
      dns_node               = "workflow-engine"
      image_tag              = "release"
      auth_allow             = "github:user:stefanhoelzl,github:user:mrh1997,github:org:baltech-ag,github:org:sharepad-de"
      retention_days         = 90
      gh_oauth_client_id     = var.gh_oauth_client_id_prod
      gh_oauth_client_secret = var.gh_oauth_client_secret_prod
      # The prod app's CDN pull-zone host, read after cutover apply #1 created
      # the app (pull zone 6081580). The staging value above documents how to
      # re-read it if the app/pull zone is ever recreated.
      cdn_host = "mc-lxsj1b8hjj.b-cdn.net"
    }
  }
}

# Per-env X25519 sealing key for the workflow-secrets feature. 32 random bytes,
# base64-encoded; runtime format `keyId:base64`. Generated once per env,
# preserved across applies (state-tracked). Rotate with
# `tofu taint 'random_bytes.secrets_key["<env>"]'` + apply.
#
# PROD KEY PRESERVATION: this resource was previously declared in apps.tf with
# `for_each = local.envs` (which held only "prod"), so the address
# `random_bytes.secrets_key["prod"]` is UNCHANGED by moving the declaration
# here — tofu tracks by address, so the prod key VALUE is preserved with no
# move and no regeneration (every already-sealed prod tenant secret keeps
# decrypting). The "staging" instance is carried in from the old standalone
# `random_bytes.staging_secrets_key` via a moved block (moves.tf). The plan
# MUST show NO random_bytes destroy/create.
resource "random_bytes" "secrets_key" {
  for_each = local.bunny_envs
  length   = 32
}

# Durable bundle storage per env (Bunny Edge Storage). Workflow bundles
# (workflows/<owner>/<repo>.tar.gz) live here; the event-store/queue database is
# on the managed Bunny Database below — so each container holds NO local state
# and needs no volume. Frankfurt (DE) main region.
#
# The read-write access key is the resource's own `password` attribute (provider-
# marked sensitive), wired straight into the app env below — no TF_VAR / GHA
# secret, and it stays out of the plan-infra step summary.
resource "bunnynet_storage_zone" "bundles" {
  for_each  = local.bunny_envs
  name      = "wfe-${each.key}-bundles"
  region    = "DE"
  zone_tier = "Standard"
}

# Managed Bunny Database (libSQL) per env, backing that env's event-store +
# per-workflow queues. Single primary in Frankfurt (DE); no read replicas
# (single writer, lowest latency). Public preview: 1 GB/DB, NO automatic backups
# or replication (accept-loss; see docs/infrastructure.md). The provider outputs
# only `id` + `url`; the access token is minted separately below.
resource "bunnynet_database" "db" {
  for_each        = local.bunny_envs
  name            = "wfe-${each.key}"
  regions_primary = ["DE"]
}

# Mint each env's libSQL access token in-tofu. A Bunny Database token is
# shown-once + non-idempotent + has no read-back, so it is NOT a
# bunnynet_database attribute — this one-shot PUT performs the action and
# captures the JWT. `use_sensitive_output` keeps it in `sensitive_output` so it
# never reaches the plan-infra step summary (the bunnynet provider does NOT mark
# env.value sensitive, so the source attribute must be).
#
# restful_operation is create-only (no Read, no drift re-issue). `path`
# interpolates the env's database id, so a database REPLACEMENT re-mints for the
# new id. On destroy it POSTs the revoke endpoint — which invalidates ALL tokens
# for THAT database (safe: each DB is its env's sole consumer; never shared
# across envs).
resource "restful_operation" "db_token" {
  for_each = local.bunny_envs
  path     = "/v2/databases/${bunnynet_database.db[each.key].id}/auth/generate"
  method   = "PUT"

  body = {
    authorization = "full-access"
    expires_at    = null
  }

  use_sensitive_output = true

  delete_method = "POST"
  delete_path   = "/v2/databases/${bunnynet_database.db[each.key].id}/auth/revoke"
}

resource "bunnynet_compute_container_app" "app" {
  for_each = local.bunny_envs

  # Resource schema version (provider made a backwards-incompatible change in
  # v0.11.0 that turned container/endpoint/env into ordered lists). Required.
  version = 2

  name = "wfe-${each.key}"

  # One always-on replica pinned to Frankfurt (DE). No autoscaling spread.
  # regions_max_allowed MUST be set explicitly: leaving it null makes the API
  # default it to 5, which then fails tofu's post-apply consistency check.
  regions_required    = ["DE"]
  regions_allowed     = ["DE"]
  regions_max_allowed = 1
  autoscaling_min     = 1
  autoscaling_max     = 1

  # No volume: fully stateless. The event-store/queue database is on the managed
  # Bunny Database and bundles are on Bunny Edge Storage (both remote) — nothing
  # is written to local disk. PERSISTENCE_PATH stays set (the runtime config
  # requires it) but is never touched when STORAGE_BACKEND=bunny + a remote
  # DATABASE_URL are in effect.
  container {
    name = "wfe"

    # ghcr.io/stefanhoelzl/workflow-engine:<tag> (staging→main, prod→release).
    # The TAG is stable; only the digest moves per deploy. image_pull_policy =
    # Always so a rollout re-pulls the latest tag WITHOUT changing any
    # TF-managed image field (avoids the CI-image-PATCH-vs-Terraform drift
    # footgun). Do NOT pin image_digest here.
    image_registry    = data.bunnynet_compute_container_imageregistry.github_public.id
    image_namespace   = "stefanhoelzl"
    image_name        = "workflow-engine"
    image_tag         = each.value.image_tag
    image_pull_policy = "Always"

    # CDN endpoint = managed HTTPS (the replacement for Caddy's TLS termination).
    # origin_ssl = false → edge-to-container is plaintext HTTP; Bunny owns the
    # HTTP→HTTPS redirect. Keep this endpoint NAME stable — renaming a CDN
    # endpoint can recreate the pull zone and orphan the cert.
    endpoint {
      name = "cdn"
      type = "CDN"

      port {
        container = 8080
      }

      cdn {
        origin_ssl = false
      }
    }

    # Readiness gate uses /livez (pure process-liveness), NOT /readyz. /readyz
    # self-reaches the app's own public BASE_URL; during a deploy Bunny serves a
    # 503 on that hostname UNTIL readiness passes, so gating readiness on
    # /readyz deadlocks. /livez returns 200 once the process is listening →
    # Bunny routes traffic → and THEN /readyz's self-checks pass.
    readiness_probe {
      type = "http"
      port = 8080

      http {
        path = "/livez"
      }
    }

    # NOTE: env blocks MUST stay alphabetized by `name` (list-typed in provider
    # ≥ 0.11.0; unsorted order produces a perpetual plan diff). Secrets flow
    # from `sensitive = true` TF_VAR_* inputs or sensitive resource attributes;
    # the provider does NOT mark env.value sensitive, so those flags are what
    # keep values out of the plan-infra step summary.
    env {
      name  = "AUTH_ALLOW"
      value = each.value.auth_allow
    }
    env {
      name  = "AUTH_PROVIDER"
      value = "github"
    }
    env {
      name  = "BASE_URL"
      value = "https://${each.value.domain}"
    }
    env {
      name  = "DATABASE_AUTH_TOKEN"
      value = restful_operation.db_token[each.key].sensitive_output.token
    }
    env {
      name  = "DATABASE_URL"
      value = bunnynet_database.db[each.key].url
    }
    env {
      name  = "EVENT_STORE_RETENTION_DAYS"
      value = tostring(each.value.retention_days)
    }
    env {
      name  = "GITHUB_OAUTH_CLIENT_ID"
      value = each.value.gh_oauth_client_id
    }
    env {
      name  = "GITHUB_OAUTH_CLIENT_SECRET"
      value = each.value.gh_oauth_client_secret
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
      value = "v1:${random_bytes.secrets_key[each.key].base64}"
    }
    env {
      name  = "STORAGE_BACKEND"
      value = "bunny"
    }
    env {
      name  = "STORAGE_BUNNY_ACCESS_KEY"
      value = bunnynet_storage_zone.bundles[each.key].password
    }
    env {
      name  = "STORAGE_BUNNY_ENDPOINT"
      value = "storage.bunnycdn.com"
    }
    env {
      name  = "STORAGE_BUNNY_STORAGE_ZONE"
      value = bunnynet_storage_zone.bundles[each.key].name
    }
  }

  lifecycle {
    # CI rolls each env forward by PATCHing the container's image DIGEST — the
    # only documented Magic Containers rolling-update trigger. TF must not revert
    # that, or the next `tofu apply` would roll the app back AND break the
    # plan-infra empty-plan gate. CI owns the image tag/digest; image_pull_policy
    # is also reset to "IfNotPresent" by Bunny out-of-band (harmless under
    # digest-pinning). So TF stops managing all three.
    ignore_changes = [
      container[0].image_tag,
      container[0].image_digest,
      container[0].image_pull_policy,
    ]
  }
}

# Custom hostname per env on the app's auto-created CDN pull zone.
#
# LOAD-BEARING CUTOVER ORDERING (Bunny's documented flow). Bunny issues the free
# Let's Encrypt cert at the moment tls_enabled is true, and validation REQUIRES
# this hostname's CNAME to already resolve to Bunny. `tls_enabled` stays true in
# committed config; the ordering is enforced by a TWO-STEP TARGETED APPLY:
#   Step 1: tofu apply -target='bunnynet_dns_record.cname["<env>"]'  (DNS only)
#   Step 2 (after `dig` shows the CNAME live, ~5 min): full `tofu apply`. Do NOT
#     run step 2 before `dig` confirms propagation — a premature validation can
#     trigger an LE lockout (~1 week). See docs/infrastructure.md.
resource "bunnynet_pullzone_hostname" "host" {
  for_each    = local.bunny_envs
  pullzone    = bunnynet_compute_container_app.app[each.key].container[0].endpoint[0].cdn[0].pullzone_id
  name        = each.value.domain
  tls_enabled = true
  force_ssl   = true
}
