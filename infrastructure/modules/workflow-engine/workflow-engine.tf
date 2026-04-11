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
    certResolver = string
  })
  default     = null
  description = "TLS configuration for IngressRoute. Null = no TLS (self-signed)."
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
      }, var.tls != null ? { tls = var.tls } : {})
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
  ]
  description = "Traefik CRD objects (Middlewares + IngressRoutes) for the routing module"
}

output "traefik_helm_values" {
  value = {
    experimental = {
      plugins = {
        inline-response = {
          moduleName = "github.com/tuxgal/traefik_inline_response"
          version    = "v0.1.2"
        }
      }
    }
  }
  description = "Additional Traefik Helm values (e.g. plugins)"
}
