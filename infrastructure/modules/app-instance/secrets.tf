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

# GitHub OAuth App client secret, consumed by the app's in-process OAuth
# handshake (see packages/runtime/src/auth/routes.ts). Client id is injected
# as a plain env var since it is not secret.
resource "kubernetes_secret_v1" "github_oauth" {
  depends_on = [terraform_data.namespace_ready]

  metadata {
    name      = "app-github-oauth"
    namespace = var.namespace
  }

  data = {
    GITHUB_OAUTH_CLIENT_SECRET = var.github_oauth.client_secret
  }
}
