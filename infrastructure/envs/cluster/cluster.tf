terraform {
  required_version = ">= 1.11"

  required_providers {
    upcloud = {
      source  = "UpCloudLtd/upcloud"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.8"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    restapi = {
      source = "Mastercard/restapi"
    }
  }

  backend "s3" {
    bucket                      = "tofu-state"
    key                         = "cluster"
    endpoints                   = { s3 = "https://7aqmi.upcloudobjects.com" }
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_s3_checksum            = true
    skip_requesting_account_id  = true
    region                      = "us-east-1"
  }

  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

variable "state_passphrase" {
  type        = string
  sensitive   = true
  description = "Passphrase for client-side state encryption"
}

variable "upcloud_token" {
  type        = string
  sensitive   = true
  description = "UpCloud API token (K8s + networking permissions)"
}

variable "acme_email" {
  type        = string
  description = "Email for Let's Encrypt certificate notifications (passed through to Caddy's ACME client)"
}

variable "sites" {
  type = list(object({
    domain    = string
    namespace = string
  }))
  description = "Per-env routing entries Caddy serves. One per app env (prod, staging, ...). The cluster project gains explicit knowledge of routed envs in exchange for a single shared LB; adding a new env requires editing this tfvar and re-applying the cluster project."
}

variable "dns_zone" {
  type        = string
  description = "Dynu zone that hosts every site's CNAME (e.g. workflow-engine.webredirect.org). Each site.domain MUST equal this zone (apex CNAME) or be a one-level subdomain of it."
}

variable "dynu_api_key" {
  type        = string
  sensitive   = true
  description = "Dynu DNS API key. The cluster project owns CNAMEs for every site so DNS exists before Caddy boots and ACME succeeds on first try (avoiding the 9-min retry-backoff on each cluster reapply)."
}

provider "upcloud" {
  token = var.upcloud_token
}

provider "restapi" {
  uri = "https://api.dynu.com/v2"
  headers = {
    API-Key = var.dynu_api_key
  }
  create_returns_object = true
}

module "cluster" {
  source = "../../modules/kubernetes/upcloud"

  cluster_name = "workflow-engine"
}

provider "kubernetes" {
  host                   = module.cluster.host
  cluster_ca_certificate = module.cluster.cluster_ca_certificate
  client_certificate     = module.cluster.client_certificate
  client_key             = module.cluster.client_key
}

module "baseline" {
  source = "../../modules/baseline"

  namespaces = ["caddy"]
  node_cidr  = module.cluster.node_cidr
}

module "caddy" {
  source = "../../modules/caddy"

  namespace = "caddy"
  sites = [
    for s in var.sites : {
      domain = s.domain
      upstream = {
        namespace = s.namespace
        name      = "workflow-engine"
        port      = 8080
      }
    }
  ]

  service_type = "LoadBalancer"
  service_annotations = {
    "service.beta.kubernetes.io/upcloud-load-balancer-config" = jsonencode({
      frontends = [
        { name = "web", mode = "tcp" },
        { name = "websecure", mode = "tcp" },
      ]
    })
  }

  acme_email = var.acme_email

  baseline        = module.baseline
  namespace_ready = module.baseline.namespaces
}

# DNS records for every site. Owned by the cluster project so the CNAMEs exist
# before Caddy starts attempting ACME — without this, Caddy boots, fails ACME
# on NXDOMAIN, then waits ~9 minutes before retrying. After this change, the
# apply order in cluster.tf guarantees the records exist by the time Caddy
# reaches its first issuance attempt (Caddy module's namespace_ready dep is
# orthogonal to DNS — but DNS is created in parallel and reliably present
# within the same apply seconds).
locals {
  # Derive the Dynu node_name from each site's domain. Apex CNAME = "";
  # one-level subdomain prefix otherwise.
  dns_records = {
    for site in var.sites : site.domain => {
      node_name = (
        site.domain == var.dns_zone
        ? ""
        : trimsuffix(site.domain, ".${var.dns_zone}")
      )
    }
  }
}

module "dns" {
  source   = "../../modules/dns/dynu"
  for_each = local.dns_records

  zone            = var.dns_zone
  node_name       = each.value.node_name
  target_hostname = module.caddy.lb_hostname
}
