terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.1"
    }
  }
}

# ── Overview ──────────────────────────────────────────────────
#
#  workflow-engine   8080   /healthz   image=var.image
#    env: AUTH_ALLOW, BASE_URL, GITHUB_OAUTH_CLIENT_ID (plain)
#         GITHUB_OAUTH_CLIENT_SECRET (envFrom Secret)
#         + S3 secret envFrom
#
#  Authentication runs in-process (see packages/runtime/src/auth/*).
#  The oauth2-proxy sidecar has been removed.

locals {
  pod_sc = var.baseline.pod_security_context
  ctr_sc = var.baseline.container_security_context

  app_labels = { "app.kubernetes.io/name" = "workflow-engine", "app.kubernetes.io/instance" = var.instance_name }

  base_url = var.network.https_port == 443 ? "https://${var.network.domain}" : "https://${var.network.domain}:${var.network.https_port}"
}

# ── workflow-engine ───────────────────────────────────────────

resource "terraform_data" "image_ready" {
  input = var.image_ready
}

resource "kubernetes_deployment_v1" "app" {
  depends_on       = [module.app_netpol, terraform_data.image_ready]
  wait_for_rollout = false

  metadata {
    name      = "workflow-engine"
    namespace = var.namespace
    labels    = local.app_labels
  }

  spec {
    # Load-bearing: the in-memory JWE sealing password is not shared across
    # replicas. See SECURITY.md §5 and packages/runtime/src/auth/key.ts.
    # Raising this requires migrating the password to a shared mechanism
    # in the same change.
    replicas = 1
    selector { match_labels = local.app_labels }

    template {
      metadata {
        labels = local.app_labels
        annotations = {
          for k, v in {
            "app-s3-credentials" = kubernetes_secret_v1.s3.data,
            "app-github-oauth"   = kubernetes_secret_v1.github_oauth.data,
            image                = var.image_hash,
            build                = var.image_build_id,
          } : "sha256/${k}" => sha256(jsonencode(v))
        }
      }

      spec {
        automount_service_account_token = false

        security_context {
          run_as_non_root        = local.pod_sc.run_as_non_root
          run_as_user            = local.pod_sc.run_as_user
          run_as_group           = local.pod_sc.run_as_group
          fs_group               = local.pod_sc.fs_group
          fs_group_change_policy = local.pod_sc.fs_group_change_policy
          seccomp_profile { type = local.pod_sc.seccomp_profile_type }
        }

        container {
          name              = "workflow-engine"
          image             = var.image
          image_pull_policy = var.image_pull_policy

          security_context {
            run_as_non_root            = local.ctr_sc.run_as_non_root
            allow_privilege_escalation = local.ctr_sc.allow_privilege_escalation
            read_only_root_filesystem  = local.ctr_sc.read_only_root_filesystem
            capabilities { drop = local.ctr_sc.capabilities_drop }
          }

          port { container_port = 8080 }

          env_from {
            secret_ref { name = kubernetes_secret_v1.s3.metadata[0].name }
          }

          env_from {
            secret_ref { name = kubernetes_secret_v1.github_oauth.metadata[0].name }
          }

          env {
            name  = "AUTH_ALLOW"
            value = var.auth_allow
          }

          env {
            name  = "GITHUB_OAUTH_CLIENT_ID"
            value = var.github_oauth.client_id
          }

          env {
            name  = "BASE_URL"
            value = local.base_url
          }

          dynamic "env" {
            for_each = var.local_deployment ? [1] : []
            content {
              name  = "LOCAL_DEPLOYMENT"
              value = "1"
            }
          }

          volume_mount {
            name       = "tmp"
            mount_path = "/tmp"
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

        volume {
          name = "tmp"
          empty_dir {}
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "app" {
  depends_on = [terraform_data.namespace_ready]

  metadata {
    name      = "workflow-engine"
    namespace = var.namespace
  }

  spec {
    selector = local.app_labels
    port {
      port        = 8080
      target_port = 8080
    }
  }
}
