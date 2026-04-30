output "service_name" {
  value       = kubernetes_service_v1.caddy.metadata[0].name
  description = "Caddy Service name (for downstream NetworkPolicy ingress rules naming the Caddy upstream)."
}

output "service_namespace" {
  value       = kubernetes_service_v1.caddy.metadata[0].namespace
  description = "Caddy Service namespace (cross-namespace ingress sources reference this)."
}

output "deployment_uid" {
  value       = kubernetes_deployment_v1.caddy.metadata[0].uid
  description = "Caddy Deployment UID. Used as a depends_on token by app projects to gate apps on Caddy readiness."
}

output "lb_hostname" {
  value = (
    var.service_type == "LoadBalancer"
    ? try(kubernetes_service_v1.caddy.status[0].load_balancer[0].ingress[0].hostname, "")
    : ""
  )
  description = "External hostname assigned to the LoadBalancer Service by the UpCloud CCM (populated after kubernetes_service_v1 wait_for_load_balancer completes). Empty when service_type is NodePort."
}

