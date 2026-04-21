# NetworkPolicy: allow Traefik → ACME HTTP-01 solver pods.
#
# cert-manager spawns solver pods in the Certificate's namespace during
# issuance/renewal. Under the default-deny posture, they need an explicit
# ingress rule from Traefik (which proxies Let's Encrypt's challenge request).
#
# The selector matches nothing outside of issuance/renewal (solver pods
# exist for ~30-60s per challenge cycle). This policy is inert between
# issuances.
resource "kubernetes_network_policy_v1" "acme_solver_ingress" {
  metadata {
    name      = "allow-ingress-to-acme-solver"
    namespace = var.namespace
  }

  spec {
    pod_selector {
      match_labels = { "acme.cert-manager.io/http01-solver" = "true" }
    }

    policy_types = ["Ingress"]

    ingress {
      from {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = "traefik" }
        }
        pod_selector {
          match_labels = { "app.kubernetes.io/name" = "traefik" }
        }
      }

      ports {
        protocol = "TCP"
        port     = "8089"
      }
    }
  }
}
