terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

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

variable "oauth2" {
  type = object({
    client_id     = string
    client_secret = string
    github_users  = string
  })
  sensitive   = true
  description = "GitHub OAuth2 configuration"
}

variable "network" {
  type = object({
    domain     = string
    https_port = number
  })
  description = "Network configuration"
}

variable "oauth2_templates" {
  type        = map(string)
  description = "Custom oauth2-proxy HTML template contents keyed by filename"
}

variable "tls" {
  type = object({
    secretName = string
  })
  default     = null
  description = "TLS configuration for IngressRoute. Null = no TLS (Traefik default cert). When set, the IngressRoute reads tls.crt/tls.key from the named Secret. The Secret is expected to be populated by the cert-manager module (via its certificate_requests input, wired from this module's cert_request output)."
}

module "app" {
  source = "./modules/app"

  image             = var.image
  image_pull_policy = var.image_pull_policy
  image_hash        = var.image_hash
  s3                = var.s3
  github_users      = var.oauth2.github_users
}

module "oauth2_proxy" {
  source = "./modules/oauth2-proxy"

  oauth2    = var.oauth2
  network   = var.network
  templates = var.oauth2_templates
}

# ── Traefik inline-response plugin: fetch and vendor at apply time ──
# The Traefik Helm chart's built-in experimental.plugins loader pulls zip
# archives from github.com on every pod startup. Fetching once at apply time
# and mounting as a ConfigMap removes that runtime egress dependency.
#
# We fetch the repo archive at the tagged commit (not the release assets,
# which for this repo contain a `makesystem` scaffold bundle without the
# plugin source). The archive contains `.traefik.yml`, `go.mod`, and the
# plugin Go source — which is what Traefik's Yaegi loader expects to find
# at /plugins-local/src/<moduleName>/.
#
# We use a `terraform_data` + `local-exec` curl instead of `data.http` to
# avoid the hashicorp/http provider's unconditional "Response body is not
# recognized as UTF-8" warning on binary bodies. The small cost is a
# filesystem-cached tarball under `.plugin-cache/` (gitignored).
#
# The `file_presence` trigger replaces the resource if the cache file is
# missing (e.g. after a fresh clone), forcing a re-fetch without manual
# taint.
#
# Integrity model: the tagged-commit URL `archive/refs/tags/<tag>.tar.gz`
# is stable for a given tag — if upstream force-pushed the tag, the
# archive would change. The pinned `plugin_version` is the integrity
# boundary.
locals {
  plugin_version   = "v0.1.2"
  plugin_url       = "https://github.com/tuxgal/traefik_inline_response/archive/refs/tags/${local.plugin_version}.tar.gz"
  plugin_cache_dir = "${path.module}/.plugin-cache"
  plugin_path      = "${local.plugin_cache_dir}/traefik_inline_response-${local.plugin_version}.tar.gz"
}

resource "terraform_data" "traefik_plugin_fetch" {
  # Only version drives replacement. We deliberately don't add a
  # `fileexists()` trigger: it evaluates differently at plan time (before
  # the provisioner runs) vs refresh (after), causing perpetual drift. If
  # the cache file is missing (fresh clone, manually cleared),
  # `data.local_file` will fail at apply time — recover with:
  #   tofu taint module.workflow_engine.terraform_data.traefik_plugin_fetch
  #   tofu apply
  triggers_replace = {
    version = local.plugin_version
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -eu
      mkdir -p ${local.plugin_cache_dir}
      curl -fsSL ${local.plugin_url} -o ${local.plugin_path}
    EOT
  }
}

data "local_file" "traefik_plugin_tarball" {
  filename   = local.plugin_path
  depends_on = [terraform_data.traefik_plugin_fetch]
}

resource "kubernetes_config_map_v1" "traefik_plugin" {
  metadata {
    name      = "traefik-plugin-inline-response"
    namespace = "default"
  }

  binary_data = {
    "plugin.tar.gz" = data.local_file.traefik_plugin_tarball.content_base64
  }
}

# ── Namespace default-deny NetworkPolicy ──
# Selects all pods in `default`; no allow rules. Any traffic not permitted
# by a more-specific NetworkPolicy is dropped. Cilium (production UpCloud
# UKS) enforces; kindnet (local) creates the object but does not enforce.
resource "kubernetes_network_policy_v1" "default_deny" {
  metadata {
    name      = "default-deny"
    namespace = "default"
  }

  spec {
    pod_selector {}
    policy_types = ["Ingress", "Egress"]
  }
}

locals {
  host = "Host(`${var.network.domain}`)"

  error_page_5xx = <<-HTML
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Error - Workflow Engine</title>
      <style>
        :root {
          --bg: #ffffff;
          --bg-elevated: #ffffff;
          --border: #e1e4e8;
          --text: #1a1a2e;
          --text-muted: #8b8fa3;
          --shadow-lg: 0 4px 12px rgba(0,0,0,0.1);
          --radius: 8px;
          --accent: #6366f1;
          --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, sans-serif;
        }
        @media (prefers-color-scheme: dark) {
          :root {
            --bg: #0f1117;
            --bg-elevated: #1e2030;
            --border: #2e3148;
            --text: #e2e4f0;
            --text-muted: #6b6f8a;
            --shadow-lg: 0 4px 12px rgba(0,0,0,0.4);
          }
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: var(--font);
          background: var(--bg);
          color: var(--text);
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
        }
        .card {
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          box-shadow: var(--shadow-lg);
          padding: 40px;
          width: 100%;
          max-width: 380px;
          text-align: center;
        }
        .brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 8px; }
        .icon { width: 28px; height: 28px; background: var(--accent); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: white; font-size: 14px; font-weight: 700; }
        .brand-name { font-size: 18px; font-weight: 700; }
        .subtitle { color: var(--text-muted); font-size: 13px; margin-bottom: 32px; }
        .message { color: var(--text-muted); font-size: 13px; margin-bottom: 24px; }
        .btn { display: inline-flex; align-items: center; justify-content: center; width: 100%; padding: 10px 20px; font-size: 14px; font-weight: 600; font-family: var(--font); color: white; background: var(--accent); border: none; border-radius: var(--radius); cursor: pointer; transition: opacity 0.15s ease; }
        .btn:hover { opacity: 0.9; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="brand">
          <span class="icon">W</span>
          <span class="brand-name">Workflow Engine</span>
        </div>
        <p class="subtitle">Something went wrong</p>
        <p class="message">The server encountered an error. Try again in a few moments.</p>
        <button class="btn" onclick="location.reload()">Try again</button>
      </div>
    </body>
    </html>
  HTML
}

output "traefik_extra_objects" {
  value = [
    # ── Middleware: oauth2-forward-auth ────────────────────────
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "Middleware"
      metadata   = { name = "oauth2-forward-auth", namespace = "default" }
      spec = {
        forwardAuth = {
          address             = "http://${module.oauth2_proxy.service_name}:${module.oauth2_proxy.service_port}/oauth2/auth"
          trustForwardHeader  = true
          authResponseHeaders = ["X-Auth-Request-User", "X-Auth-Request-Email", "X-Auth-Request-Redirect"]
        }
      }
    },
    # ── Middleware: oauth2-errors (401-403 → sign-in) ─────────
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "Middleware"
      metadata   = { name = "oauth2-errors", namespace = "default" }
      spec = {
        errors = {
          status  = ["401-403"]
          service = { name = module.oauth2_proxy.service_name, port = module.oauth2_proxy.service_port }
          query   = "/oauth2/sign_in?rd={url}"
        }
      }
    },
    # ── Middleware: redirect-root (/ → /trigger) ──────────────
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "Middleware"
      metadata   = { name = "redirect-root", namespace = "default" }
      spec = {
        redirectRegex = {
          regex       = "^https?://[^/]+/$"
          replacement = "/trigger"
          permanent   = false
        }
      }
    },
    # ── Middleware: redirect-to-https (port 80 catch-all) ─────
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "Middleware"
      metadata   = { name = "redirect-to-https", namespace = "default" }
      spec = {
        redirectScheme = {
          scheme    = "https"
          permanent = true
        }
      }
    },
    # ── Middleware: not-found (404 → /static/404.html) ────────
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "Middleware"
      metadata   = { name = "not-found", namespace = "default" }
      spec = {
        errors = {
          status  = ["404"]
          service = { name = module.app.service_name, port = module.app.service_port }
          query   = "/static/404.html"
        }
      }
    },
    # ── Middleware: server-error (5xx → loopback to web entrypoint) ──
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "Middleware"
      metadata   = { name = "server-error", namespace = "default" }
      spec = {
        errors = {
          status  = ["500-599"]
          service = { name = "traefik", port = 80 }
          query   = "/error"
        }
      }
    },
    # ── Middleware: inline-error (traefik_inline_response plugin) ──
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "Middleware"
      metadata   = { name = "inline-error", namespace = "default" }
      spec = {
        plugin = {
          inline-response = {
            matchers = [{
              path       = { abs = "/error" }
              statusCode = 500
              response   = { raw = local.error_page_5xx }
            }]
          }
        }
      }
    },
    # ── IngressRoute: websecure (main routing) ───────────────
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "IngressRoute"
      metadata   = { name = "workflow-engine", namespace = "default" }
      spec = merge({
        entryPoints = ["websecure"]
        routes = [
          # ── Auth whitelist ──────────────────────────────────
          {
            match       = "${local.host} && PathPrefix(`/dashboard`)"
            kind        = "Rule"
            middlewares = [{ name = "oauth2-errors" }, { name = "oauth2-forward-auth" }, { name = "not-found" }, { name = "server-error" }]
            services    = [{ name = module.app.service_name, port = module.app.service_port }]
          },
          {
            match       = "${local.host} && PathPrefix(`/trigger`)"
            kind        = "Rule"
            middlewares = [{ name = "oauth2-errors" }, { name = "oauth2-forward-auth" }, { name = "not-found" }, { name = "server-error" }]
            services    = [{ name = module.app.service_name, port = module.app.service_port }]
          },
          # ── No-auth whitelist ───────────────────────────────
          {
            match       = "${local.host} && Path(`/`)"
            kind        = "Rule"
            middlewares = [{ name = "redirect-root" }]
            services    = [{ name = module.app.service_name, port = module.app.service_port }]
          },
          {
            match    = "${local.host} && PathPrefix(`/oauth2`)"
            kind     = "Rule"
            services = [{ name = module.oauth2_proxy.service_name, port = module.oauth2_proxy.service_port }]
          },
          {
            match    = "${local.host} && PathPrefix(`/static`)"
            kind     = "Rule"
            services = [{ name = module.app.service_name, port = module.app.service_port }]
          },
          {
            match       = "${local.host} && PathPrefix(`/webhooks`)"
            kind        = "Rule"
            middlewares = [{ name = "server-error" }]
            services    = [{ name = module.app.service_name, port = module.app.service_port }]
          },
          {
            match    = "${local.host} && Path(`/livez`)"
            kind     = "Rule"
            services = [{ name = module.app.service_name, port = module.app.service_port }]
          },
          # ── App-auth (app validates tokens) ─────────────────
          {
            match       = "${local.host} && PathPrefix(`/api`)"
            kind        = "Rule"
            middlewares = [{ name = "server-error" }]
            services    = [{ name = module.app.service_name, port = module.app.service_port }]
          },
          # ── Catch-all (404) ─────────────────────────────────
          {
            match       = "${local.host} && PathPrefix(`/`)"
            kind        = "Rule"
            priority    = 1
            middlewares = [{ name = "not-found" }]
            services    = [{ name = module.app.service_name, port = module.app.service_port }]
          },
        ]
      }, var.tls != null ? { tls = { secretName = var.tls.secretName } } : {})
    },
    # ── IngressRoute: web (internal loopback for 5xx page) ───
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "IngressRoute"
      metadata   = { name = "error-pages", namespace = "default" }
      spec = {
        entryPoints = ["web"]
        routes = [{
          match       = "Path(`/error`)"
          kind        = "Rule"
          middlewares = [{ name = "inline-error" }]
          services    = [{ name = "noop@internal", kind = "TraefikService" }]
        }]
      }
    },
    # ── IngressRoute: web catch-all (plaintext → HTTPS redirect) ──
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "IngressRoute"
      metadata   = { name = "redirect-to-https", namespace = "default" }
      spec = {
        entryPoints = ["web"]
        routes = [{
          match       = "PathPrefix(`/`)"
          kind        = "Rule"
          priority    = 1
          middlewares = [{ name = "redirect-to-https" }]
          services    = [{ name = "noop@internal", kind = "TraefikService" }]
        }]
      }
    },
  ]
  description = "Traefik CRD objects (Middlewares + IngressRoutes) for the routing module"
}

output "traefik_helm_values" {
  value = {
    # Plugin loaded from a vendored source tree (populated by the
    # init container from the ConfigMap). Switching from experimental.plugins
    # (runtime github.com fetch) to experimental.localPlugins (read from
    # disk) removes Traefik's runtime dependency on github.com.
    #
    # Chart v39.x `type: localPath` binds the plugin to a volume declared in
    # `deployment.additionalVolumes`. The chart auto-mounts that volume at
    # `mountPath` in the main Traefik container, so no separate
    # `additionalVolumeMounts` entry is needed for the plugin.
    experimental = {
      localPlugins = {
        inline-response = {
          type       = "localPath"
          moduleName = "github.com/tuxgal/traefik_inline_response"
          mountPath  = "/plugins-local"
          volumeName = "plugins-local"
        }
      }
    }
    # Chart default podSecurityContext has runAsUser/Group=65532 but no
    # fsGroup, so PVC mounts come up root:root and Traefik (uid 65532)
    # cannot write /data/acme.json. Setting fsGroup makes kubelet chown
    # the mount on attach; OnRootMismatch avoids recursive chown on every
    # pod start once the mount is correctly grouped.
    podSecurityContext = {
      runAsGroup          = 65532
      runAsNonRoot        = true
      runAsUser           = 65532
      fsGroup             = 65532
      fsGroupChangePolicy = "OnRootMismatch"
      seccompProfile = {
        type = "RuntimeDefault"
      }
    }
    deployment = {
      initContainers = [{
        name    = "load-inline-response-plugin"
        image   = "busybox:1.36"
        command = ["/bin/sh", "-c"]
        args = [<<-EOT
          set -eu
          mkdir -p /plugins-local/src/github.com/tuxgal/traefik_inline_response
          tar -xzf /src/plugin.tar.gz \
            --strip-components=1 \
            -C /plugins-local/src/github.com/tuxgal/traefik_inline_response
        EOT
        ]
        volumeMounts = [
          { name = "plugin-src", mountPath = "/src" },
          { name = "plugins-local", mountPath = "/plugins-local" },
        ]
      }]
      additionalVolumes = [
        {
          name = "plugin-src"
          configMap = {
            name = kubernetes_config_map_v1.traefik_plugin.metadata[0].name
          }
        },
        {
          name     = "plugins-local"
          emptyDir = {}
        },
      ]
    }
  }
  description = "Additional Traefik Helm values (plugin vendoring, init container, volumes)"
}

output "cert_request" {
  value = var.tls != null ? {
    name       = "workflow-engine"
    namespace  = "default"
    secretName = var.tls.secretName
    dnsNames   = [var.network.domain]
  } : null
  description = "Cert-manager Certificate request. Wire into the cert-manager module's certificate_requests input. Null when tls is not set."
}
