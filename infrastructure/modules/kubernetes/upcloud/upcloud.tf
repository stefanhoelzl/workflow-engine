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

variable "zone" {
  type        = string
  description = "UpCloud zone for the cluster"
}

variable "kubernetes_version" {
  type        = string
  description = "Kubernetes version for the cluster"
}

variable "node_plan" {
  type        = string
  description = "UpCloud plan for worker nodes"
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

resource "upcloud_network" "this" {
  name = "${var.cluster_name}-network"
  zone = var.zone

  ip_network {
    address = "172.24.1.0/24"
    dhcp    = true
    family  = "IPv4"
  }
}

resource "upcloud_kubernetes_cluster" "this" {
  name                    = var.cluster_name
  zone                    = var.zone
  network                 = upcloud_network.this.id
  version                 = var.kubernetes_version
  control_plane_ip_filter = var.control_plane_ip_filter
}

resource "upcloud_kubernetes_node_group" "this" {
  cluster    = upcloud_kubernetes_cluster.this.id
  name       = "default"
  plan       = var.node_plan
  node_count = var.node_count
}

ephemeral "upcloud_kubernetes_cluster" "this" {
  id = upcloud_kubernetes_cluster.this.id
}

output "host" {
  value       = ephemeral.upcloud_kubernetes_cluster.this.host
  ephemeral   = true
  description = "Kubernetes API server endpoint"
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
