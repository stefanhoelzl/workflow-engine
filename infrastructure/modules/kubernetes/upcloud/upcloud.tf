terraform {
  required_providers {
    upcloud = {
      source  = "UpCloudLtd/upcloud"
      version = "~> 5.0"
    }
  }
}

variable "cluster_name" {
  type        = string
  description = "Name of the Kubernetes cluster"
}

variable "node_count" {
  type        = number
  default     = 1
  description = "Number of worker nodes"
}

variable "control_plane_ip_filter" {
  type        = list(string)
  default     = ["0.0.0.0/0"]
  description = "CIDR ranges allowed to access the Kubernetes API server"
}

locals {
  zone               = "de-fra1"
  kubernetes_version = "1.34"
  node_plan          = "DEV-1xCPU-2GB"
}

resource "upcloud_router" "this" {
  name = "${var.cluster_name}-router"
}

resource "upcloud_network" "this" {
  name   = "${var.cluster_name}-network"
  zone   = local.zone
  router = upcloud_router.this.id

  ip_network {
    address            = "172.24.1.0/24"
    dhcp               = true
    dhcp_default_route = false
    family             = "IPv4"
  }
}

resource "upcloud_kubernetes_cluster" "this" {
  name                    = var.cluster_name
  zone                    = local.zone
  network                 = upcloud_network.this.id
  version                 = local.kubernetes_version
  control_plane_ip_filter = var.control_plane_ip_filter
  storage_encryption      = "data-at-rest"
}

resource "upcloud_kubernetes_node_group" "this" {
  cluster            = upcloud_kubernetes_cluster.this.id
  name               = "default"
  plan               = local.node_plan
  node_count         = var.node_count
  anti_affinity      = true
  storage_encryption = "data-at-rest"
}

ephemeral "upcloud_kubernetes_cluster" "this" {
  id = upcloud_kubernetes_cluster.this.id
}

# UKS marks the cluster/node_group as complete before the external API LB is
# reliably serving requests. Poll /readyz until 200 so downstream kubernetes/
# helm providers don't race the API warmup (see: transient EOF on first apply).
resource "terraform_data" "api_ready" {
  triggers_replace = {
    cluster_id = upcloud_kubernetes_cluster.this.id
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    environment = {
      API_HOST = ephemeral.upcloud_kubernetes_cluster.this.host
    }
    command = <<-EOT
      set -eu
      host="$${API_HOST#https://}"
      for i in {1..60}; do
        code=$(curl -ksS -o /dev/null -w '%%{http_code}' --max-time 5 "https://$${host}/readyz" 2>/dev/null || echo 000)
        if [ "$${code}" = "200" ]; then
          echo "K8s API ready after $${i} polls"
          exit 0
        fi
        echo "Waiting for K8s API ($${i}/60, last code=$${code})"
        sleep 5
      done
      echo "K8s API not ready after 5 minutes" >&2
      exit 1
    EOT
  }

  depends_on = [upcloud_kubernetes_node_group.this]
}

output "host" {
  value       = ephemeral.upcloud_kubernetes_cluster.this.host
  ephemeral   = true
  depends_on  = [terraform_data.api_ready]
  description = "Kubernetes API server endpoint (gated on API readiness)"
}

output "cluster_ca_certificate" {
  value       = ephemeral.upcloud_kubernetes_cluster.this.cluster_ca_certificate
  ephemeral   = true
  description = "CA certificate for the cluster"
}

output "client_certificate" {
  value       = ephemeral.upcloud_kubernetes_cluster.this.client_certificate
  ephemeral   = true
  description = "Client certificate for authentication"
}

output "client_key" {
  value       = ephemeral.upcloud_kubernetes_cluster.this.client_key
  ephemeral   = true
  description = "Client key for authentication"
}

output "cluster_id" {
  value       = upcloud_kubernetes_cluster.this.id
  description = "Kubernetes cluster UUID"
}
