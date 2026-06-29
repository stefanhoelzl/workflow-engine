# State-preserving moves for the staging→env-keyed generalization (design D4).
# These carry the EXISTING staging Bunny resources to their new env-keyed
# addresses so the plan shows MOVES, not destroy/create — no staging token
# re-mint, no sealing-key regeneration, no database replacement.
#
# The PROD sealing key needs NO move: it was already at
# `random_bytes.secrets_key["prod"]` (declared in the now-deleted apps.tf with
# `for_each = local.envs` = {prod}), and bunny.tf re-declares the same resource
# address, so tofu preserves it by identity. The PROD app / database / token /
# storage zone / hostname are net-new (prod was on the VPS) and so have no
# moves — they are created by cutover apply #1.

moved {
  from = random_bytes.staging_secrets_key
  to   = random_bytes.secrets_key["staging"]
}

moved {
  from = bunnynet_storage_zone.staging_bundles
  to   = bunnynet_storage_zone.bundles["staging"]
}

moved {
  from = bunnynet_database.staging
  to   = bunnynet_database.db["staging"]
}

moved {
  from = restful_operation.staging_db_token
  to   = restful_operation.db_token["staging"]
}

moved {
  from = bunnynet_compute_container_app.staging
  to   = bunnynet_compute_container_app.app["staging"]
}

moved {
  from = bunnynet_pullzone_hostname.staging
  to   = bunnynet_pullzone_hostname.host["staging"]
}

moved {
  from = bunnynet_dns_record.staging_cname
  to   = bunnynet_dns_record.cname["staging"]
}
