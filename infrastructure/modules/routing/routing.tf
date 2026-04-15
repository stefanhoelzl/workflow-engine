terraform {
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.1"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
  }
}

variable "traefik_extra_objects" {
  type        = any
  description = "List of CRD objects to deploy via Traefik extraObjects"
}

variable "traefik_helm_sets" {
  type = list(object({
    name  = string
    value = string
  }))
  description = "Helm set values for Traefik"
}

variable "traefik_helm_values" {
  type        = any
  default     = {}
  description = "Additional Helm values merged with extraObjects (e.g. experimental.plugins, service.annotations)"
}

variable "wait" {
  type        = bool
  default     = false
  description = "Wait for Helm release to be ready"
}

# ── NetworkPolicy: Traefik ingress/egress allow-rules ────
# Declared as a first-class TF resource (not via Helm extraObjects) so it
# is created BEFORE the Helm release. Otherwise Traefik's pod races with
# its own NetworkPolicy: Cilium's eBPF update is async, and if the pod
# boots faster than the NP is enforced, the namespace-wide default-deny
# blocks egress → ACME resolver init fails (DNS to letsencrypt.org blocked)
# → resolver marked unavailable → "nonexistent certificate resolver" errors
# forever → manual pod restart required.
resource "kubernetes_network_policy_v1" "traefik" {
  metadata {
    name      = "traefik"
    namespace = "default"
  }

  spec {
    pod_selector {
      match_labels = { "app.kubernetes.io/name" = "traefik" }
    }

    policy_types = ["Ingress", "Egress"]

    # Ingress: node CIDR covers BOTH public LB-forwarded traffic AND
    # kubelet probes. With externalTrafficPolicy=Cluster (chart default),
    # kube-proxy SNATs external client IP to the receiving node IP before
    # DNAT to the pod — so at the pod's NP enforcement point, the source
    # IP is always in the node CIDR, not the original client IP.
    #
    # Ports are the pod's internal containerPorts (chart convention):
    #   8000 = web (service :80 → pod :8000)
    #   8443 = websecure (service :443 → pod :8443)
    #   8080 = traefik admin / /ping (for kubelet probes)
    #
    # Cilium quirk: `ipBlock: 0.0.0.0/0` with port restrictions does NOT
    # match LB/host-sourced traffic because Cilium treats `0.0.0.0/0`
    # as the "world" identity, which excludes "host" / "remote-node".
    # The explicit node CIDR is the correct matcher here.
    ingress {
      from {
        ip_block {
          cidr = "172.24.1.0/24"
        }
      }

      ports {
        protocol = "TCP"
        port     = "8000"
      }
      ports {
        protocol = "TCP"
        port     = "8443"
      }
      ports {
        protocol = "TCP"
        port     = "8080"
      }
    }

    # Egress: any Internet destination (ACME endpoint, etc.) except
    # RFC1918 + link-local/IMDS.
    egress {
      to {
        ip_block {
          cidr = "0.0.0.0/0"
          except = [
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "169.254.0.0/16",
          ]
        }
      }
    }

    # Egress: DNS via CoreDNS.
    egress {
      to {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = "kube-system" }
        }
        pod_selector {
          match_expressions {
            key      = "k8s-app"
            operator = "In"
            values   = ["coredns", "kube-dns"]
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

    # Egress: backend to app workload on :8080.
    egress {
      to {
        pod_selector {
          match_labels = { app = "workflow-engine" }
        }
      }

      ports {
        protocol = "TCP"
        port     = "8080"
      }
    }

    # Egress: forward-auth to oauth2-proxy on :4180.
    egress {
      to {
        pod_selector {
          match_labels = { app = "oauth2-proxy" }
        }
      }

      ports {
        protocol = "TCP"
        port     = "4180"
      }
    }

    # Egress: ACME HTTP-01 solver pods on :8089.
    # Solver pods are dynamically created by cert-manager during cert
    # issuance/renewal and carry the `acme.cert-manager.io/http01-solver`
    # label. They exist only for the ~30-60s of a challenge cycle; the
    # selector matches nothing the rest of the time. Traefik routes the
    # challenge path to them via a cert-manager-created Ingress.
    egress {
      to {
        pod_selector {
          match_labels = { "acme.cert-manager.io/http01-solver" = "true" }
        }
      }

      ports {
        protocol = "TCP"
        port     = "8089"
      }
    }
  }
}

resource "helm_release" "traefik" {
  name             = "traefik"
  repository       = "https://traefik.github.io/charts"
  chart            = "traefik"
  version          = "39.0.7"
  namespace        = "default"
  create_namespace = false
  wait             = var.wait

  set = var.traefik_helm_sets

  values = [yamlencode(merge(
    { extraObjects = var.traefik_extra_objects },
    var.traefik_helm_values,
  ))]

  # Ensure the Traefik NetworkPolicy is in place BEFORE the pod starts,
  # so Cilium has time to enforce allow rules and ACME resolver init can
  # reach letsencrypt.org at startup.
  depends_on = [kubernetes_network_policy_v1.traefik]
}

output "helm_release_id" {
  value       = helm_release.traefik.id
  description = "Identifier of the deployed Traefik helm release; reference to create implicit dependencies on Traefik being ready"
}
