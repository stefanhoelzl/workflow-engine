terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
  }
}

resource "kubernetes_network_policy_v1" "this" {
  metadata {
    name      = var.name
    namespace = var.namespace
  }

  spec {
    pod_selector {
      match_labels = var.pod_selector
    }

    policy_types = ["Ingress", "Egress"]

    # ── Egress: internet (0.0.0.0/0 except RFC1918) ────────────
    dynamic "egress" {
      for_each = var.egress_internet ? [1] : []
      content {
        to {
          ip_block {
            cidr   = "0.0.0.0/0"
            except = var.rfc1918_except
          }
        }
      }
    }

    # ── Egress: DNS to CoreDNS ─────────────────────────────────
    dynamic "egress" {
      for_each = var.egress_dns ? [1] : []
      content {
        to {
          namespace_selector {
            match_labels = var.coredns_selector.namespace_labels
          }
          pod_selector {
            match_expressions {
              key      = var.coredns_selector.match_expressions.key
              operator = var.coredns_selector.match_expressions.operator
              values   = var.coredns_selector.match_expressions.values
            }
          }
        }
        ports {
          protocol = "UDP"
          port     = "53"
        }
        ports {
          protocol = "TCP"
          port     = "53"
        }
      }
    }

    # ── Egress: per-pod rules ──────────────────────────────────
    dynamic "egress" {
      for_each = [for e in var.egress_to : e if e.enabled]
      content {
        to {
          pod_selector {
            match_labels = egress.value.pod_selector
          }
          dynamic "namespace_selector" {
            for_each = egress.value.namespace_selector != null ? [egress.value.namespace_selector] : []
            content {
              match_labels = namespace_selector.value
            }
          }
        }
        ports {
          protocol = "TCP"
          port     = tostring(egress.value.port)
        }
      }
    }

    # ── Ingress: per-pod rules ─────────────────────────────────
    dynamic "ingress" {
      for_each = var.ingress_from_pods
      content {
        from {
          pod_selector {
            match_labels = ingress.value.pod_selector
          }
          dynamic "namespace_selector" {
            for_each = ingress.value.namespace_selector != null ? [ingress.value.namespace_selector] : []
            content {
              match_labels = namespace_selector.value
            }
          }
        }
        ports {
          protocol = "TCP"
          port     = tostring(ingress.value.port)
        }
      }
    }

    # ── Ingress: per-CIDR rules ────────────────────────────────
    dynamic "ingress" {
      for_each = var.ingress_from_cidrs
      content {
        from {
          ip_block {
            cidr = ingress.value.cidr
          }
        }
        dynamic "ports" {
          for_each = ingress.value.ports
          content {
            protocol = "TCP"
            port     = tostring(ports.value)
          }
        }
      }
    }
  }
}
