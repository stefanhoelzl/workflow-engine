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
    github_user   = string
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

module "app" {
  source = "./modules/app"

  image             = var.image
  image_pull_policy = var.image_pull_policy
  image_hash        = var.image_hash
  s3                = var.s3
}

module "oauth2_proxy" {
  source = "./modules/oauth2-proxy"

  oauth2  = var.oauth2
  network = var.network
}

module "routing" {
  source = "./modules/routing"

  network        = var.network
  app_service    = module.app.service_name
  app_port       = module.app.service_port
  oauth2_service = module.oauth2_proxy.service_name
  oauth2_port    = module.oauth2_proxy.service_port
}

output "url" {
  value       = module.routing.url
  description = "URL where the application is accessible"
}
