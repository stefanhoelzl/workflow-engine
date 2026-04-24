# Workflow-engine server-side secrets private keys.
#
# Each entry in var.secret_key_ids corresponds to an X25519 32-byte secret
# key generated once by Tofu and persisted in state. The app pod reads the
# list via `SECRETS_PRIVATE_KEYS` (CSV of `keyId:base64(sk)`) and derives
# public keys on demand for sealing/unsealing workflow manifest secrets.
#
# Primary (active sealing) key is the FIRST entry of `var.secret_key_ids`.
# Retained keys allow decryption of older bundles during rotation windows.
#
# Rotation: prepend a new id to `var.secret_key_ids`, `tofu apply` here,
# then `tofu apply` the prod project so the K8s Secret picks up the new
# CSV. Retire an old id only after every tenant bundle referencing it has
# been re-uploaded.
#
# These live in the persistence project (survives cluster destroy) because
# losing them would invalidate every uploaded tenant bundle's ciphertexts.

variable "secret_key_ids" {
  type        = list(string)
  default     = ["k1"]
  description = "Ordered list of X25519 secret-key identifiers. Primary (active sealing) key is first. Append new ids for rotation; retire old ids only once no uploaded bundle references them."
}

resource "random_bytes" "secret_key" {
  for_each = toset(var.secret_key_ids)
  length   = 32
}

# CSV form: `k1:<b64 sk>,k2:<b64 sk>,...` with primary first.
#
# Order preservation: `for id in var.secret_key_ids` walks the list in
# declaration order; `toset()` on the resource's `for_each` keys does not
# affect the output ordering — we look up each resource by id from the
# ordered list.
output "secrets_private_keys" {
  sensitive   = true
  description = "CSV of `keyId:base64(sk)` entries for `SECRETS_PRIVATE_KEYS` env var (X25519 secret keys). Primary key first."
  value = join(
    ",",
    [
      for id in var.secret_key_ids :
      format("%s:%s", id, random_bytes.secret_key[id].base64)
    ],
  )
}
