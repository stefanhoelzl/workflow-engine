resource "terraform_data" "traefik_ready" {
  input = var.traefik_ready
}

resource "terraform_data" "cert_manager_ready" {
  input = var.cert_manager_ready
}

resource "helm_release" "routes" {
  name      = "${var.instance_name}-routes"
  chart     = "${path.module}/routes-chart"
  namespace = var.namespace
  wait      = false

  values = [yamlencode({
    domain         = var.network.domain
    appServiceName = kubernetes_service_v1.app.metadata[0].name
    appServicePort = 8080
    tlsSecretName  = var.tls != null ? var.tls.secretName : ""
    certIssuerName = var.active_issuer_name != null ? var.active_issuer_name : ""
    certName       = "${var.instance_name}-workflow-engine"
  })]

  depends_on = [terraform_data.traefik_ready, terraform_data.cert_manager_ready]
}
