terraform {
  required_providers {
    kind = {
      source  = "tehcyx/kind"
      version = "~> 0.11"
    }
  }
}

variable "cluster_name" {
  type        = string
  description = "Name of the kind cluster"
}

variable "https_port" {
  type        = number
  description = "Host port to map to container port 30443"
}

variable "image_name" {
  type        = string
  description = "Container image to load into the kind cluster"
}

variable "image_hash" {
  type        = string
  description = "Content hash of the container image, used to trigger re-loading"
}

resource "kind_cluster" "this" {
  name            = var.cluster_name
  wait_for_ready  = true
  kubeconfig_path = "/tmp/${var.cluster_name}-kubeconfig"

  lifecycle {
    ignore_changes = [kubeconfig_path]
  }

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    node {
      role = "control-plane"

      extra_port_mappings {
        container_port = 30443
        host_port      = var.https_port
        protocol       = "TCP"
      }
    }
  }
}

resource "terraform_data" "load_image" {
  triggers_replace = var.image_hash

  provisioner "local-exec" {
    command     = <<-EOT
      NODE="${kind_cluster.this.name}-control-plane"
      podman save "${var.image_name}" | docker exec -i "$NODE" ctr --namespace=k8s.io images import -
    EOT
    interpreter = ["bash", "-c"]
  }

  depends_on = [kind_cluster.this]
}

output "cluster_name" {
  value       = kind_cluster.this.name
  description = "Name of the kind cluster"
}

output "host" {
  value       = kind_cluster.this.endpoint
  description = "Kubernetes API server endpoint"
}

output "cluster_ca_certificate" {
  value       = kind_cluster.this.cluster_ca_certificate
  sensitive   = true
  description = "CA certificate for the cluster"
}

output "client_certificate" {
  value       = kind_cluster.this.client_certificate
  sensitive   = true
  description = "Client certificate for authentication"
}

output "client_key" {
  value       = kind_cluster.this.client_key
  sensitive   = true
  description = "Client key for authentication"
}
