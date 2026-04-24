# Staging's own X25519 secret-key list. Independent from prod's keypair list
# (which lives in the persistence project) — staging bundles are rebuilt on
# every deploy, so losing a staging key is recoverable via CI redeploy.
#
# Rotation story matches prod: prepend a new id to `var.secret_key_ids`,
# `tofu apply`, then redeploy to pick up the CSV.

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
