terraform {
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.1"
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

resource "helm_release" "traefik" {
  name             = "traefik"
  repository       = "https://traefik.github.io/charts"
  chart            = "traefik"
  version          = "39.0.7"
  namespace        = "default"
  create_namespace = false
  wait             = false

  set = var.traefik_helm_sets

  values = [yamlencode({
    extraObjects = var.traefik_extra_objects
  })]
}
