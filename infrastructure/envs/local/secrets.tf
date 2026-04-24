# Local environment's own X25519 secret-key list. kind clusters are
# ephemeral; keys are regenerated on every `tofu apply` if state is fresh.
# Keeping the shape identical to prod/staging makes the in-repo infra
# reviewable as a single pattern.

variable "secret_key_ids" {
  type        = list(string)
  default     = ["k1"]
  description = "Ordered list of X25519 secret-key identifiers. Primary (active sealing) key is first."
}

resource "random_bytes" "secret_key" {
  for_each = toset(var.secret_key_ids)
  length   = 32
}

locals {
  secrets_private_keys_csv = join(
    ",",
    [
      for id in var.secret_key_ids :
      format("%s:%s", id, random_bytes.secret_key[id].base64)
    ],
  )
}
