terraform {
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.1"
    }
  }
}

variable "network" {
  type = object({
    domain     = string
    https_port = number
  })
  description = "Network configuration"
}

variable "app_service" {
  type        = string
  description = "K8s service name for the app"
}

variable "app_port" {
  type        = number
  description = "K8s service port for the app"
}

variable "oauth2_service" {
  type        = string
  description = "K8s service name for oauth2-proxy"
}

variable "oauth2_port" {
  type        = number
  description = "K8s service port for oauth2-proxy"
}

resource "helm_release" "traefik" {
  name             = "traefik"
  repository       = "https://traefik.github.io/charts"
  chart            = "traefik"
  version          = "39.0.7"
  namespace        = "default"
  create_namespace = false
  wait             = false

  set = [
    {
      name  = "ports.websecure.expose.default"
      value = "true"
    },
    {
      name  = "ports.websecure.exposedPort"
      value = "443"
    },
    {
      name  = "service.type"
      value = "NodePort"
    },
    {
      name  = "ports.websecure.nodePort"
      value = "30443"
    },
  ]

  values = [yamlencode({
    extraObjects = [
      {
        apiVersion = "traefik.io/v1alpha1"
        kind       = "Middleware"
        metadata = {
          name      = "oauth2-forward-auth"
          namespace = "default"
        }
        spec = {
          forwardAuth = {
            address             = "http://${var.oauth2_service}:${var.oauth2_port}/oauth2/auth"
            trustForwardHeader  = true
            authResponseHeaders = ["X-Auth-Request-User", "X-Auth-Request-Email", "X-Auth-Request-Redirect"]
          }
        }
      },
      {
        apiVersion = "traefik.io/v1alpha1"
        kind       = "Middleware"
        metadata = {
          name      = "oauth2-errors"
          namespace = "default"
        }
        spec = {
          errors = {
            status = ["401-403"]
            service = {
              name = var.oauth2_service
              port = var.oauth2_port
            }
            query = "/oauth2/sign_in?rd={url}"
          }
        }
      },
      {
        apiVersion = "traefik.io/v1alpha1"
        kind       = "Middleware"
        metadata = {
          name      = "redirect-root"
          namespace = "default"
        }
        spec = {
          redirectRegex = {
            regex       = "^https?://[^/]+/$"
            replacement = "/trigger"
            permanent   = false
          }
        }
      },
      {
        apiVersion = "traefik.io/v1alpha1"
        kind       = "IngressRoute"
        metadata = {
          name      = "workflow-engine"
          namespace = "default"
        }
        spec = {
          entryPoints = ["websecure"]
          routes = [
            {
              match       = "Host(`${var.network.domain}`) && Path(`/`)"
              kind        = "Rule"
              middlewares = [{ name = "redirect-root" }]
              services    = [{ name = var.app_service, port = var.app_port }]
            },
            {
              match    = "Host(`${var.network.domain}`) && PathPrefix(`/oauth2`)"
              kind     = "Rule"
              services = [{ name = var.oauth2_service, port = var.oauth2_port }]
            },
            {
              match    = "Host(`${var.network.domain}`) && PathPrefix(`/static`)"
              kind     = "Rule"
              services = [{ name = var.app_service, port = var.app_port }]
            },
            {
              match    = "Host(`${var.network.domain}`) && PathPrefix(`/webhooks`)"
              kind     = "Rule"
              services = [{ name = var.app_service, port = var.app_port }]
            },
            {
              match       = "Host(`${var.network.domain}`) && PathPrefix(`/dashboard`)"
              kind        = "Rule"
              middlewares = [{ name = "oauth2-errors" }, { name = "oauth2-forward-auth" }]
              services    = [{ name = var.app_service, port = var.app_port }]
            },
            {
              match       = "Host(`${var.network.domain}`) && PathPrefix(`/trigger`)"
              kind        = "Rule"
              middlewares = [{ name = "oauth2-errors" }, { name = "oauth2-forward-auth" }]
              services    = [{ name = var.app_service, port = var.app_port }]
            },
          ]
        }
      },
    ]
  })]
}

output "url" {
  value       = var.network.https_port == 443 ? "https://${var.network.domain}" : "https://${var.network.domain}:${var.network.https_port}"
  description = "URL where the application is accessible"
}
