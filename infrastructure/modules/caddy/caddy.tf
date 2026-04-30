terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
  }
}

locals {
  caddy_labels = {
    "app.kubernetes.io/name"     = "caddy"
    "app.kubernetes.io/instance" = var.namespace
  }

  pod_sc = var.baseline.pod_security_context
  ctr_sc = var.baseline.container_security_context

  caddyfile = templatefile("${path.module}/caddyfile.tpl", {
    sites      = var.sites
    acme_email = var.acme_email
  })

  upstream_namespaces = distinct([for s in var.sites : s.upstream.namespace])
}

resource "terraform_data" "namespace_ready" {
  input = var.namespace_ready
}

resource "kubernetes_service_account_v1" "caddy" {
  metadata {
    name      = "caddy"
    namespace = var.namespace
    labels    = local.caddy_labels
  }

  automount_service_account_token = false

  depends_on = [terraform_data.namespace_ready]
}

resource "kubernetes_config_map_v1" "caddyfile" {
  metadata {
    name      = "caddyfile"
    namespace = var.namespace
    labels    = local.caddy_labels
  }

  data = {
    Caddyfile = local.caddyfile
  }

  depends_on = [terraform_data.namespace_ready]
}

resource "kubernetes_persistent_volume_claim_v1" "data" {
  metadata {
    name      = "caddy-data"
    namespace = var.namespace
    labels    = local.caddy_labels
  }

  spec {
    access_modes = ["ReadWriteOnce"]
    resources {
      requests = { storage = var.pvc_size }
    }
    storage_class_name = var.pvc_storage_class
  }

  wait_until_bound = false

  depends_on = [terraform_data.namespace_ready]
}

resource "kubernetes_deployment_v1" "caddy" {
  depends_on       = [kubernetes_network_policy_v1.caddy]
  wait_for_rollout = false

  metadata {
    name      = "caddy"
    namespace = var.namespace
    labels    = local.caddy_labels
  }

  spec {
    # Single replica: Caddy stores its ACME account + cert on a RWO PVC, which
    # cannot be shared across replicas. Acceptable per the single-tenant
    # constraint (see openspec/changes/simplify-cluster-stack/design.md).
    replicas = 1
    selector { match_labels = local.caddy_labels }

    template {
      metadata {
        labels = local.caddy_labels
        annotations = {
          # Roll the pod when the Caddyfile changes so the new config is loaded.
          "sha256/caddyfile" = sha256(local.caddyfile)
        }
      }

      spec {
        service_account_name            = kubernetes_service_account_v1.caddy.metadata[0].name
        automount_service_account_token = false

        security_context {
          run_as_non_root        = local.pod_sc.run_as_non_root
          run_as_user            = local.pod_sc.run_as_user
          run_as_group           = local.pod_sc.run_as_group
          fs_group               = local.pod_sc.fs_group
          fs_group_change_policy = local.pod_sc.fs_group_change_policy
          seccomp_profile { type = local.pod_sc.seccomp_profile.type }
        }

        container {
          name  = "caddy"
          image = "docker.io/library/caddy:${var.image_tag}"

          security_context {
            run_as_non_root            = local.ctr_sc.run_as_non_root
            allow_privilege_escalation = local.ctr_sc.allow_privilege_escalation
            read_only_root_filesystem  = local.ctr_sc.read_only_root_filesystem
            # NET_BIND_SERVICE: Caddy's binary ships with file caps
            # (`cap_net_bind_service+ep`) so it can bind :80/:443 as a
            # non-root UID. With drop=[ALL] alone the kernel refuses to
            # exec the binary (EPERM) because it can't transfer the file
            # caps through an empty bounding set. Re-adding NET_BIND_SERVICE
            # is the only `capabilities.add` value PSA-restricted permits.
            capabilities {
              drop = local.ctr_sc.capabilities_drop
              add  = ["NET_BIND_SERVICE"]
            }
          }

          port {
            name           = "web"
            container_port = 80
          }
          port {
            name           = "websecure"
            container_port = 443
          }

          # XDG_CONFIG_HOME / XDG_DATA_HOME pin Caddy's writable paths into our
          # mounted volumes. Default is /home/<user>/.config and /home/<user>/.local,
          # which don't exist on the read-only root filesystem.
          env {
            name  = "XDG_CONFIG_HOME"
            value = "/config"
          }
          env {
            name  = "XDG_DATA_HOME"
            value = "/data"
          }

          volume_mount {
            name       = "caddyfile"
            mount_path = "/etc/caddy"
            read_only  = true
          }
          volume_mount {
            name       = "data"
            mount_path = "/data"
          }
          volume_mount {
            name       = "config"
            mount_path = "/config"
          }

          liveness_probe {
            tcp_socket { port = "websecure" }
            initial_delay_seconds = 10
            period_seconds        = 30
          }
          readiness_probe {
            tcp_socket { port = "websecure" }
            initial_delay_seconds = 5
            period_seconds        = 10
          }
        }

        volume {
          name = "caddyfile"
          config_map {
            name = kubernetes_config_map_v1.caddyfile.metadata[0].name
            items {
              key  = "Caddyfile"
              path = "Caddyfile"
            }
          }
        }

        volume {
          name = "data"
          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim_v1.data.metadata[0].name
          }
        }

        # Caddy writes a transient autosave config to $XDG_CONFIG_HOME on each
        # reload; mounting it as emptyDir keeps the root filesystem read-only.
        volume {
          name = "config"
          empty_dir {}
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "caddy" {
  metadata {
    name        = "caddy"
    namespace   = var.namespace
    labels      = local.caddy_labels
    annotations = var.service_annotations
  }

  # When type=LoadBalancer the UpCloud CCM provisions an external LB and
  # populates status.load_balancer.ingress.hostname. wait_for_load_balancer
  # blocks until that hostname is set so module.caddy.lb_hostname is reliable.
  wait_for_load_balancer = var.service_type == "LoadBalancer"

  spec {
    type     = var.service_type
    selector = local.caddy_labels

    port {
      name        = "web"
      port        = 80
      target_port = "web"
      protocol    = "TCP"
    }

    port {
      name        = "websecure"
      port        = 443
      target_port = "websecure"
      protocol    = "TCP"
      node_port   = var.service_type == "NodePort" ? var.node_port_https : null
    }
  }

  depends_on = [terraform_data.namespace_ready]
}
