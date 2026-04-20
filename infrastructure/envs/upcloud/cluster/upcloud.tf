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

  instances = {
    prod = {
      domain     = var.domain
      auth_allow = var.auth_allow
    }
    # staging = { domain = "staging.${var.domain}", auth_allow = var.auth_allow }
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

variable "github_oauth_client_id" {
  type        = string
  description = "GitHub OAuth App client ID (OAuth App callback URL: https://<domain>/auth/github/callback)"
}

variable "github_oauth_client_secret" {
  type        = string
  sensitive   = true
  description = "GitHub OAuth App client secret"
}

variable "auth_allow" {
  type        = string
  description = "AUTH_ALLOW env value; provider-prefixed grammar, e.g. \"github:user:stefanhoelzl;github:org:acme\""
}

variable "dynu_api_key" {
  type        = string
  sensitive   = true
  description = "Dynu DNS API key"
}

provider "upcloud" {
  token = var.upcloud_token
}

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

module "cluster" {
  source = "../../../modules/kubernetes/upcloud"

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

module "baseline" {
  source = "../../../modules/baseline"

  namespaces = concat(keys(local.instances), ["traefik"])
  node_cidr  = "172.24.1.0/24"
}

module "traefik" {
  source = "../../../modules/traefik"

  service_type = "LoadBalancer"
  service_annotations = {
    "service.beta.kubernetes.io/upcloud-load-balancer-config" = jsonencode({
      frontends = [
        { name = "web", mode = "tcp" },
        { name = "websecure", mode = "tcp" },
      ]
    })
  }
  wait                = true
  error_page_5xx_html = file("${path.module}/../../../templates/error-5xx.html")
  baseline            = module.baseline
}

module "cert_manager" {
  source = "../../../modules/cert-manager"

  enable_acme          = true
  enable_selfsigned_ca = false
  acme_email           = var.acme_email
  certificate_requests = [for inst in module.app_instance : inst.cert_request if inst.cert_request != null]
}

module "app_instance" {
  source   = "../../../modules/app-instance"
  for_each = local.instances

  instance_name = each.key
  namespace     = each.key
  image         = "ghcr.io/stefanhoelzl/workflow-engine:${var.image_tag}"
  image_hash    = var.image_tag

  s3 = {
    endpoint   = data.terraform_remote_state.persistence.outputs.endpoint
    bucket     = data.terraform_remote_state.persistence.outputs.bucket
    access_key = data.terraform_remote_state.persistence.outputs.access_key
    secret_key = data.terraform_remote_state.persistence.outputs.secret_key
    region     = data.terraform_remote_state.persistence.outputs.region
  }

  auth_allow = each.value.auth_allow

  github_oauth = {
    client_id     = var.github_oauth_client_id
    client_secret = var.github_oauth_client_secret
  }

  network = {
    domain     = each.value.domain
    https_port = 443
  }

  error_page_5xx_html = file("${path.module}/../../../templates/error-5xx.html")

  tls = {
    secretName = "${each.key}-workflow-engine-tls"
  }

  baseline        = module.baseline
  traefik_ready   = module.traefik.helm_release_id
  namespace_ready = module.baseline.namespaces
}

# --- Load balancer lookup ---

data "http" "traefik_lb" {
  url = "https://api.upcloud.com/1.3/load-balancer"
  request_headers = {
    Authorization = "Bearer ${var.upcloud_token}"
    Accept        = "application/json"
    X-Tf-Dep      = sha256(module.traefik.helm_release_id)
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

module "dns" {
  source = "../../../modules/dns/dynu"

  domain          = var.domain
  target_hostname = local.traefik_lb_hostname
  api_key         = var.dynu_api_key
}


output "url" {
  value       = "https://${var.domain}"
  description = "URL where the production environment is accessible"
}
