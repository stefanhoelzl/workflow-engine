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
    restapi = {
      source = "Mastercard/restapi"
    }
  }

  backend "s3" {
    bucket                      = "tofu-state"
    key                         = "prod"
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
  description = "UpCloud API token (K8s read scope — used by the ephemeral block to re-fetch kubeconfig)"
}

variable "dynu_api_key" {
  type        = string
  sensitive   = true
  description = "Dynu DNS API key"
}

variable "github_oauth_client_id" {
  type        = string
  description = "GitHub OAuth App client ID (prod). Callback URL: https://<domain>/auth/github/callback"
}

variable "github_oauth_client_secret" {
  type        = string
  sensitive   = true
  description = "GitHub OAuth App client secret (prod)"
}

variable "domain" {
  type        = string
  description = "Production domain (e.g. workflow-engine.webredirect.org)"
}

variable "auth_allow" {
  type        = string
  description = "AUTH_ALLOW env value; provider-prefixed grammar, e.g. \"github:user:stefanhoelzl,github:org:acme\""
}

variable "image_digest" {
  type        = string
  description = "Container image digest (sha256:...) supplied at apply time by CI from docker/build-push-action output"
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

data "terraform_remote_state" "persistence" {
  backend = "s3"
  config = {
    bucket                      = "tofu-state"
    key                         = "persistence"
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

provider "helm" {
  kubernetes = {
    host                   = ephemeral.upcloud_kubernetes_cluster.this.host
    cluster_ca_certificate = ephemeral.upcloud_kubernetes_cluster.this.cluster_ca_certificate
    client_certificate     = ephemeral.upcloud_kubernetes_cluster.this.client_certificate
    client_key             = ephemeral.upcloud_kubernetes_cluster.this.client_key
  }
}

module "baseline" {
  source = "../../modules/baseline"

  namespaces = ["prod"]
  node_cidr  = data.terraform_remote_state.cluster.outputs.node_cidr
}

module "app" {
  source = "../../modules/app-instance"

  instance_name = "prod"
  namespace     = "prod"
  image         = "ghcr.io/stefanhoelzl/workflow-engine@${var.image_digest}"
  image_hash    = var.image_digest

  s3 = {
    endpoint   = data.terraform_remote_state.persistence.outputs.endpoint
    bucket     = data.terraform_remote_state.persistence.outputs.bucket
    access_key = data.terraform_remote_state.persistence.outputs.access_key
    secret_key = data.terraform_remote_state.persistence.outputs.secret_key
    region     = data.terraform_remote_state.persistence.outputs.region
  }

  auth_allow = var.auth_allow

  github_oauth = {
    client_id     = var.github_oauth_client_id
    client_secret = var.github_oauth_client_secret
  }

  network = {
    domain     = var.domain
    https_port = 443
  }

  tls = {
    secretName = "prod-workflow-engine-tls"
  }

  active_issuer_name = data.terraform_remote_state.cluster.outputs.active_issuer_name

  baseline = {
    rfc1918_except             = data.terraform_remote_state.cluster.outputs.baseline.rfc1918_except
    node_cidr                  = data.terraform_remote_state.cluster.outputs.node_cidr
    coredns_selector           = data.terraform_remote_state.cluster.outputs.baseline.coredns_selector
    pod_security_context       = data.terraform_remote_state.cluster.outputs.baseline.pod_security_context
    container_security_context = data.terraform_remote_state.cluster.outputs.baseline.container_security_context
  }
  traefik_ready   = "cluster-applied"
  namespace_ready = module.baseline.namespaces
}

module "dns" {
  source = "../../modules/dns/dynu"

  zone            = var.domain
  target_hostname = data.terraform_remote_state.cluster.outputs.lb_hostname
  api_key         = var.dynu_api_key
}

output "url" {
  value       = "https://${var.domain}"
  description = "URL where the production environment is accessible"
}

output "cluster_id" {
  value       = data.terraform_remote_state.cluster.outputs.cluster_id
  description = "UpCloud K8s cluster ID. Used by CI to fetch kubeconfig via upctl for the post-apply cert-readiness wait."
}
