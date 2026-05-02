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
  description = "Scaleway commercial type. STARDUST1-S = 1 shared vCPU / 1 GB RAM / 10 GB local SSD — cheapest tier. Memory headroom is tight; per-Quadlet MemoryMax limits + a swapfile are load-bearing. Bump to PLAY2-MICRO (2 GB) if OOMs become recurrent."
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

variable "deploy_ssh_public_key" {
  type        = string
  description = "Public key authorized for the `deploy` user. Matches deploy_ssh_private_key."
}

variable "deploy_ssh_private_key" {
  type        = string
  sensitive   = true
  description = "Private key used by tofu provisioners to SSH into the VPS as `deploy`."
}

variable "dynu_api_key" {
  type        = string
  sensitive   = true
  description = "Dynu API key for managing CNAME/A records under webredirect.org."
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
  description = "App image repository. Tag is :release for prod, :main for staging — chosen per-env in apps.tf."
}

# Per-env GitHub OAuth App credentials. Two distinct OAuth Apps in the
# GitHub UI — one with callback URL https://workflow-engine.webredirect.org/...,
# one with https://staging.workflow-engine.webredirect.org/... .
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
