terraform {
  # Pin exact patch — operator local + CI must match, otherwise
  # `tofu init` adds version-specific h1: hashes to .terraform.lock.hcl
  # and the lockfile gate (`git diff --exit-code` in ci.yml) flaps on
  # every drift. CI pins the same value via setup-opentofu's tofu_version
  # in .github/workflows/{ci,plan-infra}.yml. Bump deliberately, with a
  # matching CI bump in the same PR.
  required_version = "1.11.6"

  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    # Both envs on Magic Containers (bunny.tf) + Bunny DNS (dns.tf). Pin to a
    # single minor — the provider is 0.x with frequent breaking minors, so bump
    # deliberately and read the CHANGELOG. 0.15.x requires OpenTofu >= 1.11
    # (we pin 1.11.6 above, so aligned).
    bunnynet = {
      source  = "BunnyWay/bunnynet"
      version = "~> 0.15"
    }
    # One-shot authenticated HTTP calls to the Bunny Database management API —
    # mint (PUT …/auth/generate) and, on destroy, revoke (POST …/auth/revoke)
    # each env's libSQL access token (bunny.tf). A Bunny Database token is
    # shown-once, non-idempotent to create, and has no read-back, so it cannot
    # be a `bunnynet_database` attribute; `restful_operation` performs the
    # action and captures the token. Source is `magodo/restful` — the OpenTofu-
    # registry namespace for the provider published on the Terraform registry as
    # Mastercard/restful. Pin the patch line — 0.x provider with breaking minors.
    restful = {
      source  = "magodo/restful"
      version = "~> 0.25.2"
    }
  }

  # Scaleway Object Storage is S3-compatible. Bucket is pre-created out-of-band.
  # The VPS compute is retired, but the encrypted tofu state stays here (the
  # state backend is not the VPS). The `key` is kept as "vps" to preserve state
  # continuity across the migration — renaming it would orphan existing state.
  backend "s3" {
    bucket                      = "tofu-states"
    key                         = "vps"
    endpoints                   = { s3 = "https://s3.fr-par.scw.cloud" }
    region                      = "fr-par"
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_s3_checksum            = true
    skip_requesting_account_id  = true
  }

  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}
