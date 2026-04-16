terraform {
  required_version = ">= 1.11"

  required_providers {
    kind = {
      source  = "tehcyx/kind"
      version = "~> 0.11"
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
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }

  backend "local" {}
}

variable "domain" {
  type        = string
  description = "Domain for the local environment"
}

variable "https_port" {
  type        = number
  description = "HTTPS port on the host"
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
  description = "Allowed GitHub username"
}

variable "s2_bucket" {
  type        = string
  description = "S2 bucket name"
}

locals {
  instances = {
    workflow-engine = {
      domain       = var.domain
      https_port   = var.https_port
      github_users = var.oauth2_github_users
    }
  }
}

module "image" {
  source = "../../modules/image/build"

  image_name      = "localhost/workflow-engine:dev"
  dockerfile_path = "${path.module}/../../Dockerfile"
  context_dir     = "${path.module}/../../.."
}

module "cluster" {
  source = "../../modules/kubernetes/kind"

  cluster_name = "workflow-engine-dev"
  https_port   = var.https_port
  image_name   = module.image.image_name
  image_hash   = module.image.image_hash
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

  namespaces = concat(keys(local.instances), ["traefik"])
  node_cidr  = "172.18.0.0/16"
}

module "s2" {
  source = "../../modules/object-storage/s2"

  buckets  = var.s2_bucket
  baseline = module.baseline
}

module "traefik" {
  source = "../../modules/traefik"

  service_type        = "NodePort"
  node_port_https     = 30443
  error_page_5xx_html = file("${path.module}/../../templates/error-5xx.html")
  baseline            = module.baseline
}

module "cert_manager" {
  source = "../../modules/cert-manager"

  enable_acme          = false
  enable_selfsigned_ca = true
  certificate_requests = [for inst in module.app_instance : inst.cert_request if inst.cert_request != null]
}

module "app_instance" {
  source   = "../../modules/app-instance"
  for_each = local.instances

  instance_name     = each.key
  namespace         = each.key
  image             = module.image.image_name
  image_pull_policy = "Never"
  image_hash        = module.image.image_hash

  s3 = {
    endpoint   = module.s2.endpoint
    bucket     = module.s2.bucket
    access_key = module.s2.access_key
    secret_key = module.s2.secret_key
    region     = module.s2.region
  }

  oauth2 = {
    client_id     = var.oauth2_client_id
    client_secret = var.oauth2_client_secret
    github_users  = each.value.github_users
  }

  network = {
    domain     = each.value.domain
    https_port = each.value.https_port
  }

  oauth2_templates = {
    "sign_in.html" = file("${path.module}/../../templates/sign_in.html")
    "error.html"   = file("${path.module}/../../templates/error.html")
  }

  error_page_5xx_html = file("${path.module}/../../templates/error-5xx.html")

  tls = {
    secretName = "${each.key}-workflow-engine-tls"
  }

  local_deployment = true
  baseline         = module.baseline
  traefik_ready    = module.traefik.helm_release_id
  namespace_ready  = module.baseline.namespaces
}

output "url" {
  value       = var.https_port == 443 ? "https://${var.domain}" : "https://${var.domain}:${var.https_port}"
  description = "URL where the local environment is accessible"
}
