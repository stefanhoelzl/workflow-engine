module "app_netpol" {
  source = "../netpol"

  name         = "workflow-engine"
  namespace    = var.namespace
  pod_selector = local.app_labels

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

module "oauth2_netpol" {
  source = "../netpol"

  name         = "oauth2-proxy"
  namespace    = var.namespace
  pod_selector = local.oauth2_labels

  egress_internet  = true
  egress_dns       = true
  rfc1918_except   = var.baseline.rfc1918_except
  coredns_selector = var.baseline.coredns_selector

  ingress_from_pods = [
    { pod_selector = { "app.kubernetes.io/name" = "traefik" }, namespace_selector = { "kubernetes.io/metadata.name" = "traefik" }, port = 4180 },
  ]

  ingress_from_cidrs = [
    { cidr = var.baseline.node_cidr, ports = [4180] },
  ]
}
