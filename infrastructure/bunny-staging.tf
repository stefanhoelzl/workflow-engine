# ─────────────────────────────────────────────────────────────────────────────
# Staging on bunny.net Magic Containers (spike)
#
# Staging-ONLY deployment running in parallel with the VPS. Prod stays entirely
# on the VPS, untouched. See openspec/changes/staging-bunny-magic-containers and
# docs/infrastructure.md "Staging on bunny.net Magic Containers".
#
# NOT wired here yet — intentionally deferred until the thin-apply confirms the
# discovery questions (tasks.md §1.5 / §4):
#   - the staging Dynu record cutover (A → CNAME to the Bunny CDN host), and
#   - the deploy-staging.yml rollout step.
# Both depend on: does a same-tag rollout re-pull the new :main digest, and does
# `data "bunnynet_pullzone"` resolve an app-owned pull zone. The VPS staging
# stack stays a live warm fallback throughout.
# ─────────────────────────────────────────────────────────────────────────────

provider "bunnynet" {
  api_key = var.bunnynet_api_key
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
  # Reuse the existing staging config so auth/retention stay in sync with the
  # VPS env, and reuse staging's sealing key so bundles uploaded against either
  # backend (VPS or Bunny) unseal — keeping the VPS a usable warm fallback.
  bunny_staging = local.envs["staging"]

  # The app's CDN pull-zone *.b-cdn.net host (pull zone 6058886). The Dynu
  # staging CNAME (dns.tf) targets this. NOTE: this changes if the app / pull
  # zone is ever recreated — re-read it with:
  #   tofu state show bunnynet_compute_container_app.staging | grep pullzone_id
  #   curl -s https://api.bunny.net/pullzone/<id> -H "AccessKey: $KEY" | grep -o '[a-z0-9-]*\.b-cdn\.net'
  bunny_staging_cdn_host = "mc-p5hgd353u8.b-cdn.net"
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

  # One persistent volume for the libSQL EventStore (events.db) + uploaded bundles.
  # Accept-loss: bunny volumes have no backups/replication and reattachment
  # across reschedule is not guaranteed (public preview). Documented, not
  # mitigated — staging data is low-stakes and CI re-uploads demo bundles.
  volume {
    name = "data"
    size = var.app_data_volume_size_gb
  }

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

    volumemount {
      name = "data"
      path = "/data"
    }

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
    # Embedded libSQL on the /data volume. Staging stays on-disk; the remote
    # (Bunny Database) cutover is a later change that sets DATABASE_URL to a
    # libsql:// URL + a DATABASE_AUTH_TOKEN secret. DATABASE_WAL keeps WAL on so
    # out-of-process readers work.
    env {
      name  = "DATABASE_URL"
      value = "file:/data/events.db"
    }
    env {
      name  = "DATABASE_WAL"
      value = "true"
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
      value = "v1:${random_bytes.secrets_key["staging"].base64}"
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
# TWO-PHASE CUTOVER (load-bearing — Bunny's documented flow). Bunny issues the
# free Let's Encrypt cert at the moment tls_enabled flips true, and that
# validation REQUIRES the CNAME to already point at Bunny — otherwise it fails
# with "domain is not pointing to our servers". So:
#   Phase 1 (this state): tls_enabled = false, force_ssl = false. The hostname
#     registers on the pull zone (no cert attempt) and dns.tf flips the CNAME to
#     Bunny in the same apply. Staging is served over HTTP during this phase.
#   Phase 2 (after DNS propagates, ~5 min): set both to true and re-apply. The
#     cert now validates. Do NOT thrash phase-2 applies (LE lockout ~1 week);
#     wait for `dig` to show the CNAME live first.
resource "bunnynet_pullzone_hostname" "staging" {
  pullzone = bunnynet_compute_container_app.staging.container[0].endpoint[0].cdn[0].pullzone_id
  name     = local.bunny_staging.domain
  # Phase 2: DNS now points at Bunny, so the managed Let's Encrypt cert can
  # validate. force_ssl redirects HTTP→HTTPS at the edge.
  tls_enabled = true
  force_ssl   = true
}
