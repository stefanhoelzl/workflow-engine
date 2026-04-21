output "cluster_id" {
  value       = module.cluster.cluster_id
  description = "UpCloud Kubernetes cluster UUID"
}

output "lb_hostname" {
  value       = local.traefik_lb_hostname
  description = "Traefik LoadBalancer DNS name"
}

output "active_issuer_name" {
  value       = module.cert_manager.active_issuer_name
  description = "Name of the active cert-manager ClusterIssuer (letsencrypt-prod)"
}

output "node_cidr" {
  value       = module.cluster.node_cidr
  description = "CIDR of the cluster's private network"
}

output "baseline" {
  value = {
    rfc1918_except             = module.baseline.rfc1918_except
    coredns_selector           = module.baseline.coredns_selector
    pod_security_context       = module.baseline.pod_security_context
    container_security_context = module.baseline.container_security_context
  }
  description = "Baseline security constants and contexts for downstream app projects"
}
