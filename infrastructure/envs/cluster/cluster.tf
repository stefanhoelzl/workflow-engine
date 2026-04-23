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
  description = "Email for Let's Encrypt certificate notifications"
}

provider "upcloud" {
  token = var.upcloud_token
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

provider "helm" {
  kubernetes = {
    host                   = module.cluster.host
    cluster_ca_certificate = module.cluster.cluster_ca_certificate
    client_certificate     = module.cluster.client_certificate
    client_key             = module.cluster.client_key
  }
}

module "baseline" {
  source = "../../modules/baseline"

  namespaces = ["traefik"]
  node_cidr  = module.cluster.node_cidr
}

module "traefik" {
  source = "../../modules/traefik"

  service_type = "LoadBalancer"
  service_annotations = {
    "service.beta.kubernetes.io/upcloud-load-balancer-config" = jsonencode({
      frontends = [
        { name = "web", mode = "tcp" },
        { name = "websecure", mode = "tcp" },
      ]
    })
  }
  wait     = true
  baseline = module.baseline
}

module "cert_manager" {
  source = "../../modules/cert-manager"

  enable_acme          = true
  enable_selfsigned_ca = false
  acme_email           = var.acme_email
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
