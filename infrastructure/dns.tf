# Dynu A records pointing at the VPS public IP. The IP is stable across
# instance stop/start (it's a separate `scaleway_instance_ip` resource).
data "restapi_object" "zone" {
  path         = "/dns"
  search_key   = "name"
  search_value = "workflow-engine.webredirect.org"
  results_key  = "domains"
  id_attribute = "id"
}

resource "restapi_object" "dns_a_record" {
  for_each = local.envs

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
