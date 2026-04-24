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

# -----------------------------------------------------------------------------
# PodSecurity Admission (PSA) two-phase rollout
# -----------------------------------------------------------------------------
# Per pod-security-baseline/spec.md "Warn-then-enforce rollout":
#
#   Phase 1 (psa_mode = "warn"):
#     Applies label `pod-security.kubernetes.io/warn=restricted`. Non-compliant
#     pod creations emit a PodSecurity warning but still succeed. Operators run
#     `tofu apply` in this mode first, inspect the warning stream for any
#     non-compliant workload, and only proceed to phase 2 once the warning
#     stream is clean.
#
#   Phase 2 (psa_mode = "enforce", default):
#     Applies label `pod-security.kubernetes.io/enforce=restricted`. The API
#     server rejects non-compliant pods at admission time.
#
# Phase 2 MUST NOT be applied until every workload Deployment in every listed
# namespace carries compliant securityContext fields (see the app-instance and
# s2 modules, and the Traefik Helm values in modules/traefik).
# -----------------------------------------------------------------------------
variable "psa_mode" {
  type        = string
  default     = "enforce"
  description = "PodSecurity Admission rollout phase: 'warn' for phase 1 (advisory), 'enforce' for phase 2 (rejecting)."

  validation {
    condition     = contains(["warn", "enforce"], var.psa_mode)
    error_message = "psa_mode must be either 'warn' (phase 1) or 'enforce' (phase 2)."
  }
}

resource "kubernetes_namespace_v1" "ns" {
  for_each = toset(var.namespaces)

  metadata {
    name = each.value
    labels = {
      "pod-security.kubernetes.io/${var.psa_mode}" = "restricted"
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

# Shorthand selector shape per pod-security-baseline/spec.md:67 — consumed
# directly by modules/netpol (see variables.tf:coredns_selector). The netpol
# module expands this into the verbose K8s namespace_selector +
# match_expressions structure required by the NetworkPolicy resource.
output "coredns_selector" {
  value = {
    namespace  = "kube-system"
    k8s_app_in = ["coredns", "kube-dns"]
  }
  description = "Namespace + pod selector shorthand for CoreDNS egress rules"
}

output "pod_security_context" {
  value = {
    run_as_non_root        = true
    run_as_user            = 65532
    run_as_group           = 65532
    fs_group               = 65532
    fs_group_change_policy = "OnRootMismatch"
    seccomp_profile        = { type = "RuntimeDefault" }
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
