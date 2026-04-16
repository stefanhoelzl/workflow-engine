locals {
  plugin_version = "v0.1.2"
}

resource "kubernetes_config_map_v1" "traefik_plugin" {
  metadata {
    name      = "traefik-plugin-inline-response"
    namespace = var.namespace
  }

  binary_data = {
    "plugin.tar.gz" = filebase64("${path.module}/plugin/plugin-${local.plugin_version}.tar.gz")
  }
}
