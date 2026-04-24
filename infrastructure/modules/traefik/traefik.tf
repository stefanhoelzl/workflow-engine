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

variable "namespace" {
  type        = string
  default     = "traefik"
  description = "Namespace for the Traefik Helm release"
}

variable "service_type" {
  type        = string
  description = "Kubernetes Service type (NodePort or LoadBalancer)"
}

variable "exposed_https_port" {
  type        = number
  default     = 443
  description = "HTTPS port exposed on the service"
}

variable "node_port_https" {
  type        = number
  default     = null
  description = "NodePort for HTTPS (only used when service_type = NodePort)"
}

variable "service_annotations" {
  type        = map(string)
  default     = {}
  description = "Annotations for the Traefik Service (e.g. UpCloud CCM LB config)"
}

variable "wait" {
  type        = bool
  default     = false
  description = "Wait for Helm release to be ready"
}

variable "baseline" {
  type = object({
    rfc1918_except = list(string)
    node_cidr      = string
    coredns_selector = object({
      namespace  = string
      k8s_app_in = list(string)
    })
  })
  description = "Baseline security constants from the baseline module"
}

variable "extra_helm_values" {
  type        = any
  default     = {}
  description = "Additional Helm values merged into the release (e.g. service.annotations)"
}

locals {
  traefik_labels = { "app.kubernetes.io/name" = "traefik" }

  helm_sets = concat(
    [
      { name = "service.type", value = var.service_type },
      { name = "ports.websecure.expose.default", value = "true" },
      { name = "ports.websecure.exposedPort", value = tostring(var.exposed_https_port) },
    ],
    var.node_port_https != null ? [{ name = "ports.websecure.nodePort", value = tostring(var.node_port_https) }] : [],
  )
}

module "netpol" {
  source = "../netpol"

  name         = "traefik"
  namespace    = var.namespace
  pod_selector = local.traefik_labels

  egress_internet  = true
  egress_dns       = true
  rfc1918_except   = var.baseline.rfc1918_except
  coredns_selector = var.baseline.coredns_selector

  egress_to = [
    { pod_selector = { "app.kubernetes.io/name" = "workflow-engine" }, namespace_selector = {}, port = 8080 },
    { pod_selector = { "acme.cert-manager.io/http01-solver" = "true" }, namespace_selector = {}, port = 8089 },
  ]

  ingress_from_cidrs = [
    { cidr = var.baseline.node_cidr, ports = [8000, 8443, 8080] },
  ]
}

resource "helm_release" "traefik" {
  name             = "traefik"
  repository       = "https://traefik.github.io/charts"
  chart            = "traefik"
  version          = "39.0.7"
  namespace        = var.namespace
  create_namespace = false
  wait             = var.wait

  set = local.helm_sets

  values = [yamlencode(merge(
    {
      # Traefik's controller watches `Ingress` / `IngressRoute` / `Middleware`
      # CRDs via the K8s API and requires a mounted ServiceAccount token. The
      # chart defaults `serviceAccount.automountServiceAccountToken = true`
      # (chart v39.0.7 schema rejects the key under `serviceAccount`, so we
      # cannot set it explicitly — we rely on the chart default). The RBAC
      # granted to the chart-managed ServiceAccount is scoped by the upstream
      # Traefik chart to ingress/route/middleware resources; see chart
      # `values.yaml` under `rbac.*`. App and s2 pods set
      # `automountServiceAccountToken: false` at the pod spec level (see
      # modules/app-instance/workloads.tf and object-storage/s2). Tracked as
      # accepted residual risk SECURITY.md §5 R-I11 with a follow-up to audit
      # the chart's ClusterRole for least privilege.
      podSecurityContext = {
        runAsGroup          = 65532
        runAsNonRoot        = true
        runAsUser           = 65532
        fsGroup             = 65532
        fsGroupChangePolicy = "OnRootMismatch"
        seccompProfile      = { type = "RuntimeDefault" }
      }

      securityContext = {
        allowPrivilegeEscalation = false
        readOnlyRootFilesystem   = true
        capabilities             = { drop = ["ALL"] }
      }

      service = length(var.service_annotations) > 0 ? { annotations = var.service_annotations } : {}
    },
    var.extra_helm_values,
  ))]

  depends_on = [module.netpol]
}

output "helm_release_id" {
  value       = helm_release.traefik.id
  description = "Identifier of the deployed Traefik helm release"
}
