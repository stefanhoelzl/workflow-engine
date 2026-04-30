# App pod NetworkPolicy: defence-in-depth allowlist on top of the per-namespace
# default-deny from the baseline module. See SECURITY.md §5 R-I1.
#
# Ingress:
#   - Caddy pods on :8080 (cross-namespace from var.caddy_namespace)
#   - Node CIDR on :8080 for kubelet liveness/readiness probes
#
# Egress:
#   - CoreDNS on UDP+TCP :53
#   - Public internet except RFC1918+link-local — for GitHub OAuth + REST API
#     and UpCloud Object Storage S3 API. The hardenedFetch pipeline enforces
#     IANA-range filtering host-side; this rule provides defence-in-depth for
#     RFC1918+link-local only.
#   - Local-only: S2 (in-cluster S3) on :9000 when var.local_deployment

resource "kubernetes_network_policy_v1" "app" {
  metadata {
    name      = "workflow-engine"
    namespace = var.namespace
  }

  spec {
    pod_selector {
      match_labels = local.app_labels
    }

    policy_types = ["Ingress", "Egress"]

    # Ingress: Caddy pods (cross-namespace).
    ingress {
      from {
        pod_selector {
          match_labels = { "app.kubernetes.io/name" = "caddy" }
        }
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = var.caddy_namespace }
        }
      }
      ports {
        protocol = "TCP"
        port     = "8080"
      }
    }

    # Ingress: kubelet probes via node CIDR.
    ingress {
      from {
        ip_block {
          cidr = var.baseline.node_cidr
        }
      }
      ports {
        protocol = "TCP"
        port     = "8080"
      }
    }

    # Egress: CoreDNS.
    egress {
      to {
        namespace_selector {
          match_labels = {
            "kubernetes.io/metadata.name" = var.baseline.coredns_selector.namespace
          }
        }
        pod_selector {
          match_expressions {
            key      = "k8s-app"
            operator = "In"
            values   = var.baseline.coredns_selector.k8s_app_in
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

    # Egress: public internet (GitHub OAuth/API, UpCloud S3, sandbox fetch()).
    egress {
      to {
        ip_block {
          cidr   = "0.0.0.0/0"
          except = var.baseline.rfc1918_except
        }
      }
    }

    # Egress (local-only): S2 in-cluster S3.
    dynamic "egress" {
      for_each = var.local_deployment ? [1] : []
      content {
        to {
          pod_selector {
            match_labels = { "app.kubernetes.io/name" = "s2" }
          }
          namespace_selector {
            match_labels = { "kubernetes.io/metadata.name" = "default" }
          }
        }
        ports {
          protocol = "TCP"
          port     = "9000"
        }
      }
    }
  }
}
