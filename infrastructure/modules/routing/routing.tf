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
}

output "helm_release_id" {
  value       = helm_release.traefik.id
  description = "Identifier of the deployed Traefik helm release; reference to create implicit dependencies on Traefik being ready"
}
