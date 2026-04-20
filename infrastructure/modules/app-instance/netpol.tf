module "app_netpol" {
  source = "../netpol"

  name         = "workflow-engine"
  namespace    = var.namespace
  pod_selector = local.app_labels

  # The app pod reaches public internet for GitHub OAuth token exchange
  # (github.com) and GitHub REST API calls (api.github.com) driven by the
  # in-app auth capability. Bucket backend access also relies on
  # egress_internet in the S3 (prod) case; the local dev S2 egress is
  # below.
  egress_internet  = true
  egress_dns       = true
  rfc1918_except   = var.baseline.rfc1918_except
  coredns_selector = var.baseline.coredns_selector

  egress_to = [
    { pod_selector = { "app.kubernetes.io/name" = "s2" }, namespace_selector = { "kubernetes.io/metadata.name" = "default" }, port = 9000, enabled = var.local_deployment },
  ]

  ingress_from_pods = [
    { pod_selector = { "app.kubernetes.io/name" = "traefik" }, namespace_selector = { "kubernetes.io/metadata.name" = "traefik" }, port = 8080 },
  ]

  ingress_from_cidrs = [
    { cidr = var.baseline.node_cidr, ports = [8080] },
  ]
}
