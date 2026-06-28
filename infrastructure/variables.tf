variable "state_passphrase" {
  type        = string
  sensitive   = true
  description = "Passphrase for client-side state encryption (pbkdf2 + AES-GCM)."
}

variable "scaleway_region" {
  type        = string
  default     = "fr-par"
  description = "Scaleway region for the instance and Object Storage."
}

variable "scaleway_zone" {
  type        = string
  default     = "fr-par-1"
  description = "Scaleway availability zone."
}

# Project and Organization IDs are identifiers, not credentials — Scaleway
# treats them as non-secret. Committing them lets CI run without two extra
# GHA secrets and makes the deployment fully self-describing. The API key
# (SCW_ACCESS_KEY + SCW_SECRET_KEY) remains the security boundary.
variable "scaleway_project_id" {
  type        = string
  description = "Scaleway Project ID that owns the VPS, IP, and security group."
}

variable "scaleway_organization_id" {
  type        = string
  description = "Scaleway Organization ID."
}

variable "instance_type" {
  type        = string
  default     = "STARDUST1-S"
  description = "Scaleway commercial type. STARDUST1-S = 1 shared vCPU / 1 GB RAM / 10 GB local SSD — cheapest tier. Memory headroom is tight; per-Quadlet memory limits + a swapfile are load-bearing. Bump to PLAY2-MICRO (2 GB) if OOMs become recurrent."
}

variable "instance_image" {
  type        = string
  default     = "debian_trixie"
  description = "Scaleway image label. Debian 13 (Trixie) ships Podman 5.x with Quadlet support. Debian 12 (Bookworm) ships Podman 4.3.1 which is one minor version too old (Quadlet requires 4.4)."
}

variable "ssh_port" {
  type        = number
  default     = 2222
  description = "Non-default SSH port. Eliminates drive-by botnet noise on port 22."
}

variable "base_domain" {
  type        = string
  default     = "stho.net"
  description = "Apex domain (a Bunny DNS zone, owned out-of-band) under which the env hostnames are composed: workflow-engine.<base_domain> and staging.workflow-engine.<base_domain>. Swapping domains is a single-variable change."
}

variable "acme_email" {
  type        = string
  description = "Email address for Let's Encrypt account registration via Caddy ACME."
}

variable "caddy_image" {
  type        = string
  default     = "docker.io/library/caddy:2.8-alpine"
  description = "Caddy image reference (tag pinned; bump explicitly when upgrading)."
}

variable "app_image" {
  type        = string
  default     = "ghcr.io/stefanhoelzl/workflow-engine"
  description = "App image repository. Tag is :release for prod (apps.tf) and :main for staging (bunny-staging.tf)."
}

# Persistence Block Storage sizing (sbs_5k). Used by the prod VPS data volume
# (attached via additional_volume_ids, mounted at /srv/wfe/prod) and by the
# Bunny staging /data volume. 5 GB is the SBS minimum; volumes resize UP live
# (no replacement). The root local SSD is untouched — attaching is a stop/start.
variable "app_data_volume_size_gb" {
  type        = number
  default     = 5
  description = "Size (GB) of each per-env Block Storage data volume. SBS minimum is 5; resizable up only (down requires recreate)."
}

variable "app_data_volume_iops" {
  type        = number
  default     = 5000
  description = "IOPS tier for the per-env data volumes. 5000 = sbs_5k (the right tier on STARDUST1-S, whose block bandwidth caps low); 15000 = sbs_15k."
}

# Per-env GitHub OAuth App credentials. Two distinct OAuth Apps in the
# GitHub UI — one with callback URL https://workflow-engine.stho.net/...,
# one with https://staging.workflow-engine.stho.net/... .
variable "gh_oauth_client_id_prod" {
  type        = string
  sensitive   = true
  description = "GitHub OAuth App client ID for prod."
}

variable "gh_oauth_client_secret_prod" {
  type        = string
  sensitive   = true
  description = "GitHub OAuth App client secret for prod."
}

variable "gh_oauth_client_id_staging" {
  type        = string
  sensitive   = true
  description = "GitHub OAuth App client ID for staging."
}

variable "gh_oauth_client_secret_staging" {
  type        = string
  sensitive   = true
  description = "GitHub OAuth App client secret for staging."
}

# bunny.net API key for the Magic Containers staging spike (bunny-staging.tf).
# "Team member API keys are not supported" (provider docs) — use an account
# key. Sealed in encrypted tofu state at rest; supplied via TF_VAR_* / the
# BUNNYNET_API_KEY GHA secret.
variable "bunnynet_api_key" {
  type        = string
  sensitive   = true
  description = "bunny.net account API key for the Magic Containers staging deployment."
}
