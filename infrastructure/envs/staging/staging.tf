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
      version = "~> 3.6"
    }
  }

  backend "s3" {
    bucket                      = "tofu-state"
    key                         = "staging"
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
    remote_state_data_sources {
      default {
        method = method.aes_gcm.state
      }
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
  description = "UpCloud API token (K8s read + Object Storage scopes)"
}

variable "github_oauth_client_id" {
  type        = string
  description = "GitHub OAuth App client ID (staging). Callback URL: https://<domain>/auth/github/callback"
}

variable "github_oauth_client_secret" {
  type        = string
  sensitive   = true
  description = "GitHub OAuth App client secret (staging)"
}

variable "domain" {
  type        = string
  description = "Staging domain (e.g. staging.workflow-engine.webredirect.org)"
}

variable "auth_allow" {
  type        = string
  description = "AUTH_ALLOW env value; provider-prefixed grammar, e.g. \"github:user:stefanhoelzl\""
}

variable "service_uuid" {
  type        = string
  description = "UUID of the existing UpCloud Object Storage instance"
}

variable "service_endpoint" {
  type        = string
  description = "Public endpoint URL of the Object Storage instance"
}

variable "bucket_name" {
  type        = string
  description = "Name of the staging app bucket"
}

variable "image_digest" {
  type        = string
  description = "Container image digest (sha256:...) — supplied at apply time by CI from docker/build-push-action output"
}

provider "upcloud" {
  token = var.upcloud_token
}

data "terraform_remote_state" "cluster" {
  backend = "s3"
  config = {
    bucket                      = "tofu-state"
    key                         = "cluster"
    endpoints                   = { s3 = "https://7aqmi.upcloudobjects.com" }
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_s3_checksum            = true
    skip_requesting_account_id  = true
    region                      = "us-east-1"
  }
}

ephemeral "upcloud_kubernetes_cluster" "this" {
  id = data.terraform_remote_state.cluster.outputs.cluster_id
}

provider "kubernetes" {
  host                   = ephemeral.upcloud_kubernetes_cluster.this.host
  cluster_ca_certificate = ephemeral.upcloud_kubernetes_cluster.this.cluster_ca_certificate
  client_certificate     = ephemeral.upcloud_kubernetes_cluster.this.client_certificate
  client_key             = ephemeral.upcloud_kubernetes_cluster.this.client_key
}

module "bucket" {
  source = "../../modules/object-storage/upcloud"

  service_uuid = var.service_uuid
  endpoint     = var.service_endpoint
  bucket_name  = var.bucket_name
}

module "baseline" {
  source = "../../modules/baseline"

  namespaces = ["staging"]
  node_cidr  = data.terraform_remote_state.cluster.outputs.node_cidr
}

module "app" {
  source = "../../modules/app-instance"

  instance_name = "staging"
  namespace     = "staging"
  image         = "ghcr.io/stefanhoelzl/workflow-engine@${var.image_digest}"
  image_hash    = var.image_digest

  s3 = {
    endpoint   = module.bucket.endpoint
    bucket     = module.bucket.bucket
    access_key = module.bucket.access_key
    secret_key = module.bucket.secret_key
    region     = module.bucket.region
  }

  auth_allow = var.auth_allow

  github_oauth = {
    client_id     = var.github_oauth_client_id
    client_secret = var.github_oauth_client_secret
  }

  secrets_private_keys = local.secrets_private_keys_csv

  network = {
    domain     = var.domain
    https_port = 443
  }

  caddy_namespace = data.terraform_remote_state.cluster.outputs.caddy_namespace

  baseline = {
    rfc1918_except             = data.terraform_remote_state.cluster.outputs.baseline.rfc1918_except
    node_cidr                  = data.terraform_remote_state.cluster.outputs.node_cidr
    coredns_selector           = data.terraform_remote_state.cluster.outputs.baseline.coredns_selector
    pod_security_context       = data.terraform_remote_state.cluster.outputs.baseline.pod_security_context
    container_security_context = data.terraform_remote_state.cluster.outputs.baseline.container_security_context
  }
  namespace_ready = module.baseline.namespaces
}

output "url" {
  value       = "https://${var.domain}"
  description = "URL where the staging environment is accessible"
}
