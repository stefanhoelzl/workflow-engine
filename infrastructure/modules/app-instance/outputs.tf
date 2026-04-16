output "cert_request" {
  value = var.tls != null ? {
    name       = "${var.instance_name}-workflow-engine"
    namespace  = var.namespace
    secretName = var.tls.secretName
    dnsNames   = [var.network.domain]
  } : null
  description = "Cert-manager Certificate request. Null when tls is not set."
}
