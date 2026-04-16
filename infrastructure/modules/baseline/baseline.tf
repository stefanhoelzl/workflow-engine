terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
  }
}

variable "namespaces" {
  type        = list(string)
  description = "Namespaces to create and secure with default-deny NetworkPolicy"
}

variable "node_cidr" {
  type        = string
  description = "Node CIDR for kubelet probe ingress rules (e.g. 172.24.1.0/24)"
}

resource "kubernetes_namespace_v1" "ns" {
  for_each = toset(var.namespaces)

  metadata {
    name = each.value
    labels = {
      "pod-security.kubernetes.io/enforce" = "restricted"
    }
  }
}

resource "kubernetes_network_policy_v1" "default_deny" {
  for_each = toset(var.namespaces)

  metadata {
    name      = "default-deny"
    namespace = each.value
  }

  spec {
    pod_selector {}
    policy_types = ["Ingress", "Egress"]
  }

  depends_on = [kubernetes_namespace_v1.ns]
}

output "rfc1918_except" {
  value       = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]
  description = "RFC1918 + link-local CIDRs to exclude from public-internet egress rules"
}

output "node_cidr" {
  value       = var.node_cidr
  description = "Node CIDR passed through for downstream NetworkPolicy ingress rules"
}

output "coredns_selector" {
  value = {
    namespace_labels = {
      "kubernetes.io/metadata.name" = "kube-system"
    }
    match_expressions = {
      key      = "k8s-app"
      operator = "In"
      values   = ["coredns", "kube-dns"]
    }
  }
  description = "Namespace + pod selector for CoreDNS egress rules"
}

output "pod_security_context" {
  value = {
    run_as_non_root        = true
    run_as_user            = 65532
    run_as_group           = 65532
    fs_group               = 65532
    fs_group_change_policy = "OnRootMismatch"
    seccomp_profile_type   = "RuntimeDefault"
  }
  description = "Pod-level security context for restricted workloads (nonroot/65532)"
}

output "container_security_context" {
  value = {
    run_as_non_root            = true
    allow_privilege_escalation = false
    read_only_root_filesystem  = true
    capabilities_drop          = ["ALL"]
  }
  description = "Container-level security context for restricted workloads"
}

output "namespaces" {
  value       = [for ns in kubernetes_namespace_v1.ns : ns.metadata[0].name]
  description = "Created namespace names; reference to create implicit dependencies on namespace existence"
}
