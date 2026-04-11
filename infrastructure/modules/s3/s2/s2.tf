variable "access_key" {
  type        = string
  sensitive   = true
  description = "S2 access key (S2_SERVER_USER)"
}

variable "secret_key" {
  type        = string
  sensitive   = true
  description = "S2 secret key (S2_SERVER_PASSWORD)"
}

variable "buckets" {
  type        = string
  description = "Comma-separated list of buckets to auto-create (S2_SERVER_BUCKETS)"
}

resource "kubernetes_secret_v1" "s2" {
  metadata {
    name = "s2-credentials"
  }

  data = {
    S2_SERVER_USER     = var.access_key
    S2_SERVER_PASSWORD = var.secret_key
  }
}

resource "kubernetes_deployment_v1" "s2" {
  metadata {
    name = "s2"
    labels = {
      app = "s2"
    }
  }

  spec {
    replicas = 1

    selector {
      match_labels = {
        app = "s2"
      }
    }

    template {
      metadata {
        labels = {
          app = "s2"
        }
        annotations = {
          "sha256/s2-credentials" = sha256(jsonencode(kubernetes_secret_v1.s2.data))
        }
      }

      spec {
        container {
          name  = "s2"
          image = "mojatter/s2-server:0.4.1"

          port {
            container_port = 9000
          }

          env_from {
            secret_ref {
              name = kubernetes_secret_v1.s2.metadata[0].name
            }
          }

          env {
            name  = "S2_SERVER_BUCKETS"
            value = var.buckets
          }

          env {
            name  = "S2_SERVER_TYPE"
            value = "osfs"
          }

          env {
            name  = "S2_SERVER_LISTEN"
            value = ":9000"
          }

          liveness_probe {
            http_get {
              path = "/healthz"
              port = 9000
            }
            period_seconds = 5
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "s2" {
  metadata {
    name = "s2"
  }

  spec {
    selector = {
      app = "s2"
    }

    port {
      port        = 9000
      target_port = 9000
    }
  }
}

output "endpoint" {
  value       = "http://${kubernetes_service_v1.s2.metadata[0].name}:9000"
  description = "S3-compatible endpoint URL"
}

output "bucket" {
  value       = split(",", var.buckets)[0]
  description = "Primary bucket name"
}

output "access_key" {
  value       = var.access_key
  sensitive   = true
  description = "S3 access key ID"
}

output "secret_key" {
  value       = var.secret_key
  sensitive   = true
  description = "S3 secret access key"
}

output "region" {
  value       = "local"
  description = "S3 region (placeholder for S2)"
}
