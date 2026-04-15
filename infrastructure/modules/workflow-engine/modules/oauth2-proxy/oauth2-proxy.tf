terraform {
  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "~> 3.8"
    }
  }
}

variable "oauth2" {
  type = object({
    client_id     = string
    client_secret = string
    github_users  = string
  })
  sensitive   = true
  description = "GitHub OAuth2 configuration"
}

variable "network" {
  type = object({
    domain     = string
    https_port = number
  })
  description = "Network configuration"
}

variable "templates" {
  type        = map(string)
  description = "Custom HTML template contents keyed by filename"
}

locals {
  base_url         = var.network.https_port == 443 ? "https://${var.network.domain}" : "https://${var.network.domain}:${var.network.https_port}"
  redirect_url     = "${local.base_url}/oauth2/callback"
  whitelist_domain = var.network.https_port == 443 ? var.network.domain : "${var.network.domain}:${var.network.https_port}"
}

resource "random_password" "cookie_secret" {
  length = 32
}

resource "kubernetes_secret_v1" "oauth2_proxy" {
  metadata {
    name = "oauth2-proxy-credentials"
  }

  data = {
    client-id     = var.oauth2.client_id
    client-secret = var.oauth2.client_secret
    cookie-secret = random_password.cookie_secret.result
  }
}

resource "kubernetes_config_map_v1" "oauth2_templates" {
  metadata {
    name = "oauth2-proxy-templates"
  }

  data = var.templates
}

resource "kubernetes_deployment_v1" "oauth2_proxy" {
  metadata {
    name = "oauth2-proxy"
    labels = {
      app = "oauth2-proxy"
    }
  }

  spec {
    replicas = 1

    selector {
      match_labels = {
        app = "oauth2-proxy"
      }
    }

    template {
      metadata {
        labels = {
          app = "oauth2-proxy"
        }
        annotations = {
          "sha256/oauth2-proxy-credentials" = sha256(jsonencode(kubernetes_secret_v1.oauth2_proxy.data))
          "sha256/oauth2-proxy-templates"   = sha256(jsonencode(kubernetes_config_map_v1.oauth2_templates.data))
        }
      }

      spec {
        automount_service_account_token = false

        container {
          name  = "oauth2-proxy"
          image = "quay.io/oauth2-proxy/oauth2-proxy:v7.15.1"

          port {
            container_port = 4180
          }

          env {
            name = "OAUTH2_PROXY_CLIENT_ID"
            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.oauth2_proxy.metadata[0].name
                key  = "client-id"
              }
            }
          }

          env {
            name = "OAUTH2_PROXY_CLIENT_SECRET"
            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.oauth2_proxy.metadata[0].name
                key  = "client-secret"
              }
            }
          }

          env {
            name = "OAUTH2_PROXY_COOKIE_SECRET"
            value_from {
              secret_key_ref {
                name = kubernetes_secret_v1.oauth2_proxy.metadata[0].name
                key  = "cookie-secret"
              }
            }
          }

          env {
            name  = "OAUTH2_PROXY_PROVIDER"
            value = "github"
          }

          env {
            name  = "OAUTH2_PROXY_GITHUB_USERS"
            value = var.oauth2.github_users
          }

          env {
            name  = "OAUTH2_PROXY_REDIRECT_URL"
            value = local.redirect_url
          }

          env {
            name  = "OAUTH2_PROXY_WHITELIST_DOMAINS"
            value = local.whitelist_domain
          }

          env {
            name  = "OAUTH2_PROXY_HTTP_ADDRESS"
            value = "0.0.0.0:4180"
          }

          env {
            name  = "OAUTH2_PROXY_REVERSE_PROXY"
            value = "true"
          }

          env {
            name  = "OAUTH2_PROXY_EMAIL_DOMAINS"
            value = "*"
          }

          env {
            name  = "OAUTH2_PROXY_COOKIE_SECURE"
            value = "true"
          }

          env {
            name  = "OAUTH2_PROXY_SET_XAUTHREQUEST"
            value = "true"
          }

          env {
            name  = "OAUTH2_PROXY_UPSTREAMS"
            value = "static://202"
          }

          env {
            name  = "OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR"
            value = "/templates"
          }

          volume_mount {
            name       = "templates"
            mount_path = "/templates"
            read_only  = true
          }

          liveness_probe {
            http_get {
              path = "/ping"
              port = 4180
            }
            period_seconds = 5
          }
        }

        volume {
          name = "templates"
          config_map {
            name = kubernetes_config_map_v1.oauth2_templates.metadata[0].name
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "oauth2_proxy" {
  metadata {
    name = "oauth2-proxy"
  }

  spec {
    selector = {
      app = "oauth2-proxy"
    }

    port {
      port        = 4180
      target_port = 4180
    }
  }
}

output "service_name" {
  value       = kubernetes_service_v1.oauth2_proxy.metadata[0].name
  description = "K8s service name for oauth2-proxy"
}

output "service_port" {
  value       = 4180
  description = "K8s service port for oauth2-proxy"
}

# ── NetworkPolicy: oauth2-proxy ingress/egress allow-rules ──
# See SECURITY.md §5 R-I1.
resource "kubernetes_network_policy_v1" "oauth2_proxy" {
  metadata {
    name      = "oauth2-proxy"
    namespace = "default"
  }

  spec {
    pod_selector {
      match_labels = { app = "oauth2-proxy" }
    }

    policy_types = ["Ingress", "Egress"]

    # Egress: github.com (OAuth token exchange) + api.github.com (user
    # lookup). NetworkPolicy cannot match hostnames; per-hostname scoping
    # would require CiliumNetworkPolicy FQDN rules.
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

    # Ingress: Traefik forward-auth calls on :4180.
    ingress {
      from {
        pod_selector {
          match_labels = { "app.kubernetes.io/name" = "traefik" }
        }
      }

      ports {
        protocol = "TCP"
        port     = "4180"
      }
    }

    # Ingress: kubelet health probes from UpCloud node CIDR.
    ingress {
      from {
        ip_block {
          cidr = "172.24.1.0/24"
        }
      }

      ports {
        protocol = "TCP"
        port     = "4180"
      }
    }
  }
}
