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

variable "acme_email" {
  type        = string
  default     = ""
  description = "Email for ACME account registration (required when enable_acme is true)"
}

variable "enable_acme" {
  type        = bool
  default     = false
  description = "Emit letsencrypt-prod ClusterIssuer for ACME HTTP-01 issuance"
}

variable "enable_selfsigned_ca" {
  type        = bool
  default     = false
  description = "Emit selfsigned-bootstrap + selfsigned-ca ClusterIssuers for local dev"
}

variable "certificate_requests" {
  type = list(object({
    name       = string
    namespace  = string
    secretName = string
    dnsNames   = list(string)
  }))
  default     = []
  description = "Leaf certificates to issue. Each entry yields a Certificate resource signed by the active ClusterIssuer (letsencrypt-prod when enable_acme, else selfsigned-ca)."
}

locals {
  chart_version = "v1.16.2"
  namespace     = "cert-manager"

  active_issuer = var.enable_acme ? "letsencrypt-prod" : (var.enable_selfsigned_ca ? "selfsigned-ca" : null)

  # Each extraObjects entry is a YAML-string document (cert-manager chart's
  # format). Encoding to strings up front keeps all conditional branches the
  # same type (list of string), avoiding OpenTofu's strict tuple-type unification.

  acme_issuer_yaml = var.enable_acme ? [
    yamlencode({
      apiVersion = "cert-manager.io/v1"
      kind       = "ClusterIssuer"
      metadata   = { name = "letsencrypt-prod" }
      spec = {
        acme = {
          server              = "https://acme-v02.api.letsencrypt.org/directory"
          email               = var.acme_email
          privateKeySecretRef = { name = "letsencrypt-prod-account-key" }
          solvers = [{
            http01 = {
              ingress = { ingressClassName = "traefik" }
            }
          }]
        }
      }
    })
  ] : []

  selfsigned_yaml = var.enable_selfsigned_ca ? [
    yamlencode({
      apiVersion = "cert-manager.io/v1"
      kind       = "ClusterIssuer"
      metadata   = { name = "selfsigned-bootstrap" }
      spec       = { selfSigned = {} }
    }),
    yamlencode({
      apiVersion = "cert-manager.io/v1"
      kind       = "Certificate"
      metadata   = { name = "selfsigned-ca", namespace = local.namespace }
      spec = {
        isCA       = true
        commonName = "selfsigned-ca"
        secretName = "selfsigned-ca-key-pair"
        privateKey = { algorithm = "ECDSA", size = 256 }
        issuerRef  = { name = "selfsigned-bootstrap", kind = "ClusterIssuer", group = "cert-manager.io" }
      }
    }),
    yamlencode({
      apiVersion = "cert-manager.io/v1"
      kind       = "ClusterIssuer"
      metadata   = { name = "selfsigned-ca" }
      spec       = { ca = { secretName = "selfsigned-ca-key-pair" } }
    }),
  ] : []

  leaf_yaml = [
    for req in var.certificate_requests : yamlencode({
      apiVersion = "cert-manager.io/v1"
      kind       = "Certificate"
      metadata   = { name = req.name, namespace = req.namespace }
      spec = {
        secretName = req.secretName
        dnsNames   = req.dnsNames
        issuerRef  = { name = local.active_issuer, kind = "ClusterIssuer", group = "cert-manager.io" }
      }
    })
  ]

  extra_objects = concat(
    local.acme_issuer_yaml,
    local.selfsigned_yaml,
    local.leaf_yaml,
  )
}

resource "helm_release" "cert_manager" {
  name             = "cert-manager"
  repository       = "https://charts.jetstack.io"
  chart            = "cert-manager"
  version          = local.chart_version
  namespace        = local.namespace
  create_namespace = true
  wait             = true

  set = [{
    name  = "installCRDs"
    value = "true"
  }]
}

# Custom resources go in a second release so the CRDs from the first release
# are registered in API discovery when Helm renders and maps kinds for CRs.
# A single release can't install CRDs and consume them in the same apply —
# Helm resolves kinds up front, before anything is applied.

resource "helm_release" "cert_manager_extras" {
  count = length(local.extra_objects) > 0 ? 1 : 0

  name      = "cert-manager-extras"
  chart     = "${path.module}/extras-chart"
  namespace = local.namespace

  values = [yamlencode({
    extraObjects = local.extra_objects
  })]

  depends_on = [helm_release.cert_manager]
}

# ── NetworkPolicy: allow Traefik → ACME HTTP-01 solver pods ─────
#
# Solver pods are dynamically created by cert-manager during cert
# issuance/renewal. Under a default-deny NetworkPolicy posture they need
# an explicit ingress rule from Traefik (which proxies LE's challenge
# request to them).
#
# This policy lives in the same namespace as the Certificate that spawned
# the solver (cert-manager creates solver pods in the Certificate's
# namespace). One policy per unique namespace in certificate_requests.
# The corresponding Traefik-side egress rule lives in the routing module.
#
# NOTE: the selector matches nothing the rest of the time — solver pods
# only exist for ~30-60s per challenge cycle. This policy is inert
# between issuances.
resource "kubernetes_network_policy_v1" "acme_solver_ingress" {
  for_each = var.enable_acme ? toset([for r in var.certificate_requests : r.namespace]) : toset([])

  metadata {
    name      = "allow-ingress-to-acme-solver"
    namespace = each.value
  }

  spec {
    pod_selector {
      match_labels = { "acme.cert-manager.io/http01-solver" = "true" }
    }

    policy_types = ["Ingress"]

    ingress {
      from {
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

output "active_issuer_name" {
  value       = local.active_issuer
  description = "Name of the active ClusterIssuer used to sign leaf certificates (null if neither enable_acme nor enable_selfsigned_ca is true)"
}

output "helm_release_id" {
  value       = helm_release.cert_manager.id
  description = "Helm release ID of cert-manager; reference to create implicit dependencies on cert-manager readiness"
}
