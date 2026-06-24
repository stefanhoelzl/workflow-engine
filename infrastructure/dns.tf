# Dynu zone lookup. The VPS public IP is stable across instance stop/start
# (it's a separate `scaleway_instance_ip` resource).
data "restapi_object" "zone" {
  path         = "/dns"
  search_key   = "name"
  search_value = "workflow-engine.webredirect.org"
  results_key  = "domains"
  id_attribute = "id"
}

# prod → A record at the VPS IP. staging is intentionally EXCLUDED here and
# served by a separate CNAME resource below: Dynu rejects an in-place A→CNAME
# type change (501 "Record type change is not allowed"), so the staging A
# record must be destroyed and a CNAME created in its place.
resource "restapi_object" "dns_a_record" {
  for_each = { for k, v in local.envs : k => v if k != "staging" }

  path          = "/dns/${data.restapi_object.zone.id}/record"
  update_method = "POST"
  data = jsonencode({
    domainId    = tonumber(data.restapi_object.zone.id)
    nodeName    = each.value.dns_node
    recordType  = "A"
    ttl         = 300
    state       = true
    ipv4Address = scaleway_instance_ip.vps.address
  })
  id_attribute = "id"
  # Mastercard restapi provider merges the API response (including
  # response-only fields like `content`, `statusCode`, `updatedOn`) into
  # `data` on apply. Without this flag, every subsequent refresh shows
  # perpetual drift wanting to remove those fields.
  ignore_server_additions = true
}

# staging → CNAME to the Bunny Magic Containers CDN host (cutover). A distinct
# resource because Dynu forbids changing a record's type in place. A CNAME and
# the old A record cannot coexist for the same name, so the A record must be
# destroyed FIRST — apply this in two steps (see docs/infrastructure.md):
#   1. tofu apply -target=restapi_object.dns_a_record   (destroys the staging A)
#   2. tofu apply                                        (creates this CNAME)
resource "restapi_object" "dns_staging_cname" {
  path          = "/dns/${data.restapi_object.zone.id}/record"
  update_method = "POST"
  data = jsonencode({
    domainId   = tonumber(data.restapi_object.zone.id)
    nodeName   = local.envs["staging"].dns_node
    recordType = "CNAME"
    ttl        = 300
    state      = true
    # Dynu CNAME records carry the target hostname in `host`.
    host = local.bunny_staging_cdn_host
  })
  id_attribute            = "id"
  ignore_server_additions = true

  # The custom hostname must exist on the Bunny pull zone before traffic lands.
  depends_on = [bunnynet_pullzone_hostname.staging]
}
