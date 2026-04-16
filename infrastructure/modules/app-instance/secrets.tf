resource "terraform_data" "namespace_ready" {
  input = var.namespace_ready
}

resource "kubernetes_secret_v1" "s3" {
  depends_on = [terraform_data.namespace_ready]

  metadata {
    name      = "app-s3-credentials"
    namespace = var.namespace
  }

  data = {
    PERSISTENCE_S3_BUCKET            = var.s3.bucket
    PERSISTENCE_S3_ACCESS_KEY_ID     = var.s3.access_key
    PERSISTENCE_S3_SECRET_ACCESS_KEY = var.s3.secret_key
    PERSISTENCE_S3_ENDPOINT          = var.s3.endpoint
    PERSISTENCE_S3_REGION            = var.s3.region
  }
}

resource "random_password" "cookie_secret" {
  length = 32
}

resource "kubernetes_secret_v1" "oauth2_proxy" {
  depends_on = [terraform_data.namespace_ready]

  metadata {
    name      = "oauth2-proxy-credentials"
    namespace = var.namespace
  }

  data = {
    client-id     = var.oauth2.client_id
    client-secret = var.oauth2.client_secret
    cookie-secret = random_password.cookie_secret.result
  }
}

resource "kubernetes_config_map_v1" "oauth2_templates" {
  depends_on = [terraform_data.namespace_ready]

  metadata {
    name      = "oauth2-proxy-templates"
    namespace = var.namespace
  }

  data = var.oauth2_templates
}
