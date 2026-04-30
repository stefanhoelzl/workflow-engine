variable "buckets" {
  type        = string
  description = "Comma-separated list of buckets to auto-create (S2_SERVER_BUCKETS)"
}

variable "baseline" {
  type = object({
    rfc1918_except = list(string)
    node_cidr      = string
    coredns_selector = object({
      namespace  = string
      k8s_app_in = list(string)
    })
    pod_security_context = object({
      run_as_non_root        = bool
      run_as_user            = number
      run_as_group           = number
      fs_group               = number
      fs_group_change_policy = string
      seccomp_profile        = object({ type = string })
    })
    container_security_context = object({
      run_as_non_root            = bool
      allow_privilege_escalation = bool
      read_only_root_filesystem  = bool
      capabilities_drop          = list(string)
    })
  })
  description = "Baseline security constants from the baseline module"
}

locals {
  access_key = "minioadmin"
  secret_key = "minioadmin"
  s2_labels  = { "app.kubernetes.io/name" = "s2" }
  pod_sc     = var.baseline.pod_security_context
  ctr_sc     = var.baseline.container_security_context
}

resource "kubernetes_secret_v1" "s2" {
  metadata {
    name = "s2-credentials"
  }

  data = {
    S2_SERVER_USER     = local.access_key
    S2_SERVER_PASSWORD = local.secret_key
  }
}

resource "kubernetes_deployment_v1" "s2" {
  depends_on       = [kubernetes_network_policy_v1.s2]
  wait_for_rollout = false

  metadata {
    name   = "s2"
    labels = local.s2_labels
  }

  spec {
    replicas = 1

    selector {
      match_labels = local.s2_labels
    }

    template {
      metadata {
        labels = local.s2_labels
        annotations = {
          "sha256/s2-credentials" = sha256(jsonencode(kubernetes_secret_v1.s2.data))
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

          seccomp_profile {
            type = local.pod_sc.seccomp_profile.type
          }
        }

        container {
          name  = "s2"
          image = "mojatter/s2-server:0.4.1"

          security_context {
            run_as_non_root            = local.ctr_sc.run_as_non_root
            allow_privilege_escalation = local.ctr_sc.allow_privilege_escalation
            read_only_root_filesystem  = local.ctr_sc.read_only_root_filesystem

            capabilities {
              drop = local.ctr_sc.capabilities_drop
            }
          }

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

          volume_mount {
            name       = "data"
            mount_path = "/data"
          }

          volume_mount {
            name       = "tmp"
            mount_path = "/tmp"
          }

          liveness_probe {
            http_get {
              path = "/healthz"
              port = 9000
            }

            period_seconds = 5
          }
        }

        volume {
          name = "data"
          empty_dir {}
        }

        volume {
          name = "tmp"
          empty_dir {}
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
    selector = local.s2_labels

    port {
      port        = 9000
      target_port = 9000
    }
  }
}

# S2 NetworkPolicy: allow ingress from any workflow-engine pod (in any
# workload namespace) on :9000. S2 has no external dependencies; default-deny
# from baseline covers everything else.
resource "kubernetes_network_policy_v1" "s2" {
  metadata {
    name      = "s2"
    namespace = "default"
  }

  spec {
    pod_selector {
      match_labels = local.s2_labels
    }

    policy_types = ["Ingress"]

    ingress {
      from {
        pod_selector {
          match_labels = { "app.kubernetes.io/name" = "workflow-engine" }
        }
        # Empty namespace_selector matches all namespaces — without it the
        # rule defaults to S2's own namespace (`default`), which would
        # reject the app pod running in `workflow-engine`.
        namespace_selector {}
      }
      ports {
        protocol = "TCP"
        port     = "9000"
      }
    }
  }
}

output "endpoint" {
  value       = "http://${kubernetes_service_v1.s2.metadata[0].name}.${kubernetes_service_v1.s2.metadata[0].namespace}.svc.cluster.local:9000"
  description = "S3-compatible endpoint URL (FQDN for cross-namespace access)"
}

output "bucket" {
  value       = split(",", var.buckets)[0]
  description = "Primary bucket name"
}

output "access_key" {
  value       = local.access_key
  sensitive   = true
  description = "S3 access key ID"
}

output "secret_key" {
  value       = local.secret_key
  sensitive   = true
  description = "S3 secret access key"
}

output "region" {
  value       = "local"
  description = "S3 region (placeholder for S2)"
}
