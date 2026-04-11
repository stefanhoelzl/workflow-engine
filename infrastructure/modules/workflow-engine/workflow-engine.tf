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

output "traefik_extra_objects" {
  value = [
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "Middleware"
      metadata = {
        name      = "oauth2-forward-auth"
        namespace = "default"
      }
      spec = {
        forwardAuth = {
          address             = "http://${module.oauth2_proxy.service_name}:${module.oauth2_proxy.service_port}/oauth2/auth"
          trustForwardHeader  = true
          authResponseHeaders = ["X-Auth-Request-User", "X-Auth-Request-Email", "X-Auth-Request-Redirect"]
        }
      }
    },
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "Middleware"
      metadata = {
        name      = "oauth2-errors"
        namespace = "default"
      }
      spec = {
        errors = {
          status = ["401-403"]
          service = {
            name = module.oauth2_proxy.service_name
            port = module.oauth2_proxy.service_port
          }
          query = "/oauth2/sign_in?rd={url}"
        }
      }
    },
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "Middleware"
      metadata = {
        name      = "redirect-root"
        namespace = "default"
      }
      spec = {
        redirectRegex = {
          regex       = "^https?://[^/]+/$"
          replacement = "/trigger"
          permanent   = false
        }
      }
    },
    {
      apiVersion = "traefik.io/v1alpha1"
      kind       = "IngressRoute"
      metadata = {
        name      = "workflow-engine"
        namespace = "default"
      }
      spec = {
        entryPoints = ["websecure"]
        routes = [
          {
            match       = "Host(`${var.network.domain}`) && Path(`/`)"
            kind        = "Rule"
            middlewares = [{ name = "redirect-root" }]
            services    = [{ name = module.app.service_name, port = module.app.service_port }]
          },
          {
            match    = "Host(`${var.network.domain}`) && PathPrefix(`/oauth2`)"
            kind     = "Rule"
            services = [{ name = module.oauth2_proxy.service_name, port = module.oauth2_proxy.service_port }]
          },
          {
            match    = "Host(`${var.network.domain}`) && PathPrefix(`/webhooks`)"
            kind     = "Rule"
            services = [{ name = module.app.service_name, port = module.app.service_port }]
          },
          {
            match       = "Host(`${var.network.domain}`) && PathPrefix(`/dashboard`)"
            kind        = "Rule"
            middlewares = [{ name = "oauth2-errors" }, { name = "oauth2-forward-auth" }]
            services    = [{ name = module.app.service_name, port = module.app.service_port }]
          },
          {
            match       = "Host(`${var.network.domain}`) && PathPrefix(`/trigger`)"
            kind        = "Rule"
            middlewares = [{ name = "oauth2-errors" }, { name = "oauth2-forward-auth" }]
            services    = [{ name = module.app.service_name, port = module.app.service_port }]
          },
        ]
      }
    },
  ]
  description = "Traefik CRD objects (Middlewares + IngressRoute) for the routing module"
}
