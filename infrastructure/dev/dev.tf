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
  description = "Domain for the dev environment"
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

variable "s2_access_key" {
  type        = string
  sensitive   = true
  description = "S2 access key"
}

variable "s2_secret_key" {
  type        = string
  sensitive   = true
  description = "S2 secret key"
}

variable "s2_bucket" {
  type        = string
  description = "S2 bucket name"
}

module "image" {
  source = "../modules/image/local"

  image_name      = "localhost/workflow-engine:dev"
  dockerfile_path = "${path.module}/../Dockerfile"
  context_dir     = "${path.module}/../.."
}

module "cluster" {
  source = "../modules/kubernetes/kind"

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

module "s2" {
  source = "../modules/s3/s2"

  access_key = var.s2_access_key
  secret_key = var.s2_secret_key
  buckets    = var.s2_bucket
}

module "workflow_engine" {
  source = "../modules/workflow-engine"

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
    github_users  = var.oauth2_github_users
  }

  network = {
    domain     = var.domain
    https_port = var.https_port
  }

  oauth2_templates = {
    "sign_in.html" = file("${path.module}/../templates/sign_in.html")
    "error.html"   = file("${path.module}/../templates/error.html")
  }
}

output "url" {
  value       = module.workflow_engine.url
  description = "URL where the dev environment is accessible"
}
