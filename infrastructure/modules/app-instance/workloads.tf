terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.8"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.1"
    }
  }
}

# ── Overview ──────────────────────────────────────────────────
#
#  workflow-engine   8080   /healthz   image=var.image   env: GITHUB_USER, s3 secret
#  oauth2-proxy      4180   /ping      v7.15.1           env: oauth2_env, secret keys
#

locals {
  pod_sc = var.baseline.pod_security_context
  ctr_sc = var.baseline.container_security_context

  app_labels    = { "app.kubernetes.io/name" = "workflow-engine", "app.kubernetes.io/instance" = var.instance_name }
  oauth2_labels = { "app.kubernetes.io/name" = "oauth2-proxy", "app.kubernetes.io/instance" = var.instance_name }
}

# ── workflow-engine ───────────────────────────────────────────

resource "kubernetes_deployment_v1" "app" {
  depends_on       = [module.app_netpol]
  wait_for_rollout = false

  metadata {
    name      = "workflow-engine"
    namespace = var.namespace
    labels    = local.app_labels
  }

  spec {
    replicas = 1
    selector { match_labels = local.app_labels }

    template {
      metadata {
        labels      = local.app_labels
        annotations = { for k, v in { "app-s3-credentials" = kubernetes_secret_v1.s3.data, image = var.image_hash } : "sha256/${k}" => sha256(jsonencode(v)) }
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

          env {
            name  = "GITHUB_USER"
            value = var.oauth2.github_users
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

# ── oauth2-proxy ──────────────────────────────────────────────

resource "kubernetes_deployment_v1" "oauth2_proxy" {
  depends_on       = [module.oauth2_netpol]
  wait_for_rollout = false

  metadata {
    name      = "oauth2-proxy"
    namespace = var.namespace
    labels    = local.oauth2_labels
  }

  spec {
    replicas = 1
    selector { match_labels = local.oauth2_labels }

    template {
      metadata {
        labels      = local.oauth2_labels
        annotations = { for k, v in { "oauth2-proxy-credentials" = kubernetes_secret_v1.oauth2_proxy.data, "oauth2-proxy-templates" = kubernetes_config_map_v1.oauth2_templates.data } : "sha256/${k}" => sha256(jsonencode(v)) }
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
          name  = "oauth2-proxy"
          image = "quay.io/oauth2-proxy/oauth2-proxy:v7.15.1"

          security_context {
            run_as_non_root            = local.ctr_sc.run_as_non_root
            allow_privilege_escalation = local.ctr_sc.allow_privilege_escalation
            read_only_root_filesystem  = local.ctr_sc.read_only_root_filesystem
            capabilities { drop = local.ctr_sc.capabilities_drop }
          }

          port { container_port = 4180 }

          dynamic "env" {
            for_each = local.oauth2_env
            content {
              name  = env.key
              value = env.value
            }
          }

          dynamic "env" {
            for_each = local.oauth2_secret_env
            content {
              name = env.key
              value_from {
                secret_key_ref {
                  name = kubernetes_secret_v1.oauth2_proxy.metadata[0].name
                  key  = env.value
                }
              }
            }
          }

          volume_mount {
            name       = "templates"
            mount_path = "/templates"
            read_only  = true
          }

          liveness_probe {
            http_get {
              path = "/ping"
              port = 4180
            }
            period_seconds = 5
          }

          readiness_probe {
            http_get {
              path = "/ping"
              port = 4180
            }
            period_seconds = 5
          }
        }

        volume {
          name = "templates"
          config_map { name = kubernetes_config_map_v1.oauth2_templates.metadata[0].name }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "oauth2_proxy" {
  depends_on = [terraform_data.namespace_ready]

  metadata {
    name      = "oauth2-proxy"
    namespace = var.namespace
  }

  spec {
    selector = local.oauth2_labels
    port {
      port        = 4180
      target_port = 4180
    }
  }
}
