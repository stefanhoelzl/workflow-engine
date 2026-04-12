variable "image" {
  type        = string
  description = "Container image for the workflow-engine app"
}

variable "image_pull_policy" {
  type        = string
  description = "Kubernetes image pull policy"
  default     = "IfNotPresent"
}

variable "image_hash" {
  type        = string
  description = "Content hash of the container image, used to trigger pod rollouts"
}

variable "s3" {
  type = object({
    endpoint   = string
    bucket     = string
    access_key = string
    secret_key = string
    region     = string
  })
  sensitive   = true
  description = "S3 storage configuration"
}

variable "github_users" {
  type        = string
  description = "Comma-separated list of GitHub logins allowed to call /api. Passed as GITHUB_USER env var."
}

resource "kubernetes_secret_v1" "s3" {
  metadata {
    name = "app-s3-credentials"
  }

  data = {
    PERSISTENCE_S3_BUCKET            = var.s3.bucket
    PERSISTENCE_S3_ACCESS_KEY_ID     = var.s3.access_key
    PERSISTENCE_S3_SECRET_ACCESS_KEY = var.s3.secret_key
    PERSISTENCE_S3_ENDPOINT          = var.s3.endpoint
    PERSISTENCE_S3_REGION            = var.s3.region
  }
}

resource "kubernetes_deployment_v1" "app" {
  metadata {
    name = "workflow-engine"
    labels = {
      app = "workflow-engine"
    }
  }

  spec {
    replicas = 1

    selector {
      match_labels = {
        app = "workflow-engine"
      }
    }

    template {
      metadata {
        labels = {
          app = "workflow-engine"
        }
        annotations = {
          "sha256/app-s3-credentials" = sha256(jsonencode(kubernetes_secret_v1.s3.data))
          "sha256/image"              = var.image_hash
        }
      }

      spec {
        container {
          name              = "workflow-engine"
          image             = var.image
          image_pull_policy = var.image_pull_policy

          port {
            container_port = 8080
          }

          env_from {
            secret_ref {
              name = kubernetes_secret_v1.s3.metadata[0].name
            }
          }

          env {
            name  = "GITHUB_USER"
            value = var.github_users
          }

          liveness_probe {
            http_get {
              path = "/healthz"
              port = 8080
            }
            period_seconds        = 5
            initial_delay_seconds = 5
          }

          readiness_probe {
            http_get {
              path = "/healthz"
              port = 8080
            }
            period_seconds = 5
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "app" {
  metadata {
    name = "workflow-engine"
  }

  spec {
    selector = {
      app = "workflow-engine"
    }

    port {
      port        = 8080
      target_port = 8080
    }
  }
}

output "service_name" {
  value       = kubernetes_service_v1.app.metadata[0].name
  description = "K8s service name for the app"
}

output "service_port" {
  value       = 8080
  description = "K8s service port for the app"
}
