output "cluster_id" {
  value       = module.cluster.cluster_id
  description = "UpCloud Kubernetes cluster UUID"
}

output "lb_hostname" {
  value       = module.caddy.lb_hostname
  description = "Caddy LoadBalancer DNS name (assigned by the UpCloud CCM)"
}

output "caddy_namespace" {
  value       = "caddy"
  description = "Namespace where Caddy runs. App projects pass this to modules/app-instance/ so the app's NetworkPolicy authorizes ingress from Caddy."
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
