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

variable "zone" {
  type        = string
  description = "UpCloud zone"
}

variable "kubernetes_version" {
  type        = string
  description = "Kubernetes version for the cluster"
}

variable "node_plan" {
  type        = string
  description = "UpCloud plan for worker nodes"
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Container image tag from ghcr.io"
}

variable "letsencrypt_staging" {
  type        = bool
  default     = true
  description = "Use Let's Encrypt staging server"
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

  cluster_name       = "workflow-engine"
  zone               = var.zone
  kubernetes_version = var.kubernetes_version
  node_plan          = var.node_plan
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
    certResolver = "letsencrypt"
  }
}

# --- Routing ---

module "routing" {
  source = "../modules/routing"

  traefik_extra_objects = module.workflow_engine.traefik_extra_objects
  traefik_helm_values   = module.workflow_engine.traefik_helm_values
  wait                  = true
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
    {
      name  = "certificatesResolvers.letsencrypt.acme.email"
      value = var.acme_email
    },
    {
      name  = "certificatesResolvers.letsencrypt.acme.storage"
      value = "/data/acme.json"
    },
    {
      name  = "certificatesResolvers.letsencrypt.acme.tlsChallenge"
      value = "true"
    },
    {
      name  = "certificatesResolvers.letsencrypt.acme.caServer"
      value = var.letsencrypt_staging ? "https://acme-staging-v02.api.letsencrypt.org/directory" : "https://acme-v02.api.letsencrypt.org/directory"
    },
    {
      name  = "persistence.enabled"
      value = "true"
    },
    {
      name  = "persistence.size"
      value = "128Mi"
    },
  ]
}

# --- Load balancer IP ---

data "kubernetes_service_v1" "traefik" {
  depends_on = [module.routing]

  metadata {
    name      = "traefik"
    namespace = "default"
  }
}

# --- DNS ---

provider "restapi" {
  uri = "https://api.dynu.com/v2"
  headers = {
    API-Key = var.dynu_api_key
  }
  write_returns_object = true
}

data "restapi_object" "domain" {
  path         = "/dns"
  search_key   = "name"
  search_value = var.domain
  results_key  = "domains"
  id_attribute = "id"
}

resource "restapi_object" "dns_a_record" {
  path = "/dns/${data.restapi_object.domain.id}/record"
  data = jsonencode({
    nodeName    = ""
    recordType  = "A"
    ttl         = 300
    state       = true
    ipv4Address = data.kubernetes_service_v1.traefik.status[0].load_balancer[0].ingress[0].ip
  })
  id_attribute = "id"
}

# --- Outputs ---

output "url" {
  value       = "https://${var.domain}"
  description = "URL where the production environment is accessible"
}
