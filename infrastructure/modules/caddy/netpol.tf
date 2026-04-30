# Caddy NetworkPolicy: defence-in-depth allowlist on top of the per-namespace
# default-deny from the baseline module. Allows LB ingress on :80/:443 (matched
# by node CIDR — kube-proxy SNATs LB traffic to the node IP under the default
# externalTrafficPolicy=Cluster) and egress to the upstream app Service,
# CoreDNS, and the public internet for ACME issuance.

resource "kubernetes_network_policy_v1" "caddy" {
  metadata {
    name      = "caddy"
    namespace = var.namespace
  }

  spec {
    pod_selector {
      match_labels = local.caddy_labels
    }

    policy_types = ["Ingress", "Egress"]

    # Ingress: LB / kubelet probes via node CIDR on :80 and :443.
    ingress {
      from {
        ip_block {
          cidr = var.baseline.node_cidr
        }
      }
      ports {
        protocol = "TCP"
        port     = "80"
      }
      ports {
        protocol = "TCP"
        port     = "443"
      }
    }

    # Egress: upstream app Services. One rule per distinct upstream namespace
    # so cross-namespace ingress is permitted into prod, staging, etc.
    dynamic "egress" {
      for_each = local.upstream_namespaces
      content {
        to {
          pod_selector {
            match_labels = { "app.kubernetes.io/name" = "workflow-engine" }
          }
          namespace_selector {
            match_labels = { "kubernetes.io/metadata.name" = egress.value }
          }
        }
        ports {
          protocol = "TCP"
          port     = "8080"
        }
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

    # Egress: public internet for ACME (LE API on :443; some ACME flows hit
    # :80 too). Excludes RFC1918 + link-local — internal services should be
    # named explicitly above.
    egress {
      to {
        ip_block {
          cidr   = "0.0.0.0/0"
          except = var.baseline.rfc1918_except
        }
      }
      ports {
        protocol = "TCP"
        port     = "80"
      }
      ports {
        protocol = "TCP"
        port     = "443"
      }
    }
  }
}
