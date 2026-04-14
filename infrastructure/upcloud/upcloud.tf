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
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.1"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.8"
    }
    restapi = {
      source = "Mastercard/restapi"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.5"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }

  backend "s3" {
    bucket                      = local.state_bucket
    key                         = "upcloud"
    endpoints                   = { s3 = local.state_endpoint }
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
    remote_state_data_sources {
      default {
        method = method.aes_gcm.state
      }
    }
  }
}

locals {
  state_bucket   = "tofu-state"
  state_endpoint = "https://7aqmi.upcloudobjects.com"
}

variable "state_passphrase" {
  type        = string
  sensitive   = true
  description = "Passphrase for client-side state encryption"
}

variable "upcloud_token" {
  type        = string
  sensitive   = true
  description = "UpCloud API token"
}

variable "domain" {
  type        = string
  description = "Production domain"
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Container image tag from ghcr.io"
}

variable "acme_email" {
  type        = string
  description = "Email for Let's Encrypt certificate notifications"
}

variable "oauth2_client_id" {
  type        = string
  description = "GitHub OAuth App client ID"
}

variable "oauth2_client_secret" {
  type        = string
  sensitive   = true
  description = "GitHub OAuth App client secret"
}

variable "oauth2_github_users" {
  type        = string
  description = "Allowed GitHub usernames"
}

variable "dynu_api_key" {
  type        = string
  sensitive   = true
  description = "Dynu DNS API key"
}

provider "upcloud" {
  token = var.upcloud_token
}

# --- Remote state ---

data "terraform_remote_state" "persistence" {
  backend = "s3"
  config = {
    bucket                      = local.state_bucket
    key                         = "persistence"
    endpoints                   = { s3 = local.state_endpoint }
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_s3_checksum            = true
    skip_requesting_account_id  = true
    region                      = "us-east-1"
  }
}

# --- Kubernetes cluster ---

module "cluster" {
  source = "../modules/kubernetes/upcloud"

  cluster_name = "workflow-engine"
}

provider "kubernetes" {
  host                   = module.cluster.host
  cluster_ca_certificate = module.cluster.cluster_ca_certificate
  client_certificate     = module.cluster.client_certificate
  client_key             = module.cluster.client_key
}

provider "helm" {
  kubernetes = {
    host                   = module.cluster.host
    cluster_ca_certificate = module.cluster.cluster_ca_certificate
    client_certificate     = module.cluster.client_certificate
    client_key             = module.cluster.client_key
  }
}

# --- Application ---

module "workflow_engine" {
  source = "../modules/workflow-engine"

  image      = "ghcr.io/stefanhoelzl/workflow-engine:${var.image_tag}"
  image_hash = var.image_tag

  s3 = {
    endpoint   = data.terraform_remote_state.persistence.outputs.endpoint
    bucket     = data.terraform_remote_state.persistence.outputs.bucket
    access_key = data.terraform_remote_state.persistence.outputs.access_key
    secret_key = data.terraform_remote_state.persistence.outputs.secret_key
    region     = data.terraform_remote_state.persistence.outputs.region
  }

  oauth2 = {
    client_id     = var.oauth2_client_id
    client_secret = var.oauth2_client_secret
    github_users  = var.oauth2_github_users
  }

  network = {
    domain     = var.domain
    https_port = 443
  }

  oauth2_templates = {
    "sign_in.html" = file("${path.module}/../templates/sign_in.html")
    "error.html"   = file("${path.module}/../templates/error.html")
  }

  tls = {
    secretName = "workflow-engine-tls"
  }
}

# --- Cert manager ---

module "cert_manager" {
  source = "../modules/cert-manager"

  enable_acme          = true
  enable_selfsigned_ca = false
  acme_email           = var.acme_email
  certificate_requests = module.workflow_engine.cert_request != null ? [module.workflow_engine.cert_request] : []
}

# --- Routing ---

module "routing" {
  source = "../modules/routing"

  traefik_extra_objects = module.workflow_engine.traefik_extra_objects
  traefik_helm_values = merge(
    module.workflow_engine.traefik_helm_values,
    {
      service = {
        annotations = {
          "service.beta.kubernetes.io/upcloud-load-balancer-config" = jsonencode({
            frontends = [
              { name = "web", mode = "tcp" },
              { name = "websecure", mode = "tcp" },
            ]
          })
        }
      }
    }
  )
  wait = true
  traefik_helm_sets = [
    {
      name  = "service.type"
      value = "LoadBalancer"
    },
    {
      name  = "ports.websecure.expose.default"
      value = "true"
    },
    {
      name  = "ports.websecure.exposedPort"
      value = "443"
    },
  ]
}

# --- Load balancer lookup ---
#
# Fetch the CCM-created LB via UpCloud API, filtered by the CCM-applied
# cluster-id label. The X-Tf-Dep header carries a sha256 of the Traefik helm
# release id to create an implicit dependency on module.routing: unknown
# during the first apply (defers the data source until after Traefik is
# deployed and CCM has created the LB), stable on subsequent applies so the
# data source reads during plan refresh and the DNS record shows no churn.
# The header is not interpreted by the UpCloud API.

data "http" "traefik_lb" {
  url = "https://api.upcloud.com/1.3/load-balancer"
  request_headers = {
    Authorization = "Bearer ${var.upcloud_token}"
    Accept        = "application/json"
    X-Tf-Dep      = sha256(module.routing.helm_release_id)
  }
}

locals {
  traefik_lb_hostname = one([
    for lb in jsondecode(data.http.traefik_lb.response_body) : lb.dns_name
    if anytrue([
      for lbl in lb.labels : lbl.key == "ccm_cluster_id" && lbl.value == module.cluster.cluster_id
    ])
  ])
}

# --- DNS ---

provider "restapi" {
  uri = "https://api.dynu.com/v2"
  headers = {
    API-Key = var.dynu_api_key
  }
  create_returns_object = true
}

data "restapi_object" "domain" {
  path         = "/dns"
  search_key   = "name"
  search_value = var.domain
  results_key  = "domains"
  id_attribute = "id"
}

resource "restapi_object" "dns_cname_record" {
  path          = "/dns/${data.restapi_object.domain.id}/record"
  update_method = "POST"
  data = jsonencode({
    domainId   = tonumber(data.restapi_object.domain.id)
    nodeName   = ""
    recordType = "CNAME"
    ttl        = 300
    state      = true
    host       = local.traefik_lb_hostname
  })
  id_attribute            = "id"
  ignore_server_additions = true
}

# --- Outputs ---

output "url" {
  value       = "https://${var.domain}"
  description = "URL where the production environment is accessible"
}
