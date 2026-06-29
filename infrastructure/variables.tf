variable "state_passphrase" {
  type        = string
  sensitive   = true
  description = "Passphrase for client-side state encryption (pbkdf2 + AES-GCM)."
}

variable "base_domain" {
  type        = string
  default     = "stho.net"
  description = "Apex domain (a Bunny DNS zone, owned out-of-band) under which the env hostnames are composed: workflow-engine.<base_domain> and staging.workflow-engine.<base_domain>. Swapping domains is a single-variable change."
}

# Per-env GitHub OAuth App credentials. Two distinct OAuth Apps in the GitHub
# UI — one with callback URL https://workflow-engine.stho.net/..., one with
# https://staging.workflow-engine.stho.net/... .
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

# bunny.net account API key. Used by the bunnynet + restful providers (bunny.tf)
# and by the deploy workflows' rolling-update step. "Team member API keys are
# not supported" (provider docs) — use an account key. Sealed in encrypted tofu
# state at rest; supplied via TF_VAR_* / the BUNNYNET_API_KEY GHA secret.
variable "bunnynet_api_key" {
  type        = string
  sensitive   = true
  description = "bunny.net account API key for the Magic Containers deployment (both envs)."
}
