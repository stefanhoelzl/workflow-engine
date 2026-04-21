terraform {
  required_providers {
    restapi = {
      source = "Mastercard/restapi"
    }
  }
}

variable "zone" {
  type        = string
  description = "Dynu-registered zone (e.g. workflow-engine.webredirect.org). A separate record is created inside this zone."
}

variable "node_name" {
  type        = string
  default     = ""
  description = "Subdomain prefix inside the zone. Empty string = zone apex (root CNAME); e.g. 'staging' for staging.<zone>."
}

variable "target_hostname" {
  type        = string
  description = "The CNAME target (e.g. a load balancer DNS name)"
}

variable "api_key" {
  type        = string
  sensitive   = true
  description = "Dynu DNS API key"
}

provider "restapi" {
  uri = "https://api.dynu.com/v2"
  headers = {
    API-Key = var.api_key
  }
  create_returns_object = true
}

data "restapi_object" "zone" {
  path         = "/dns"
  search_key   = "name"
  search_value = var.zone
  results_key  = "domains"
  id_attribute = "id"
}

resource "restapi_object" "dns_cname_record" {
  path          = "/dns/${data.restapi_object.zone.id}/record"
  update_method = "POST"
  data = jsonencode({
    domainId   = tonumber(data.restapi_object.zone.id)
    nodeName   = var.node_name
    recordType = "CNAME"
    ttl        = 300
    state      = true
    host       = var.target_hostname
  })
  id_attribute            = "id"
  ignore_server_additions = true
}

output "record_id" {
  value = restapi_object.dns_cname_record.id
}
