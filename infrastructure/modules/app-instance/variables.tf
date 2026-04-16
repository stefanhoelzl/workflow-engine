variable "instance_name" {
  type        = string
  description = "Instance identifier (e.g. prod, staging). Used in labels and resource naming."
}

variable "namespace" {
  type        = string
  description = "Kubernetes namespace for this app-instance"
}

variable "image" {
  type        = string
  description = "Container image for the workflow-engine app"
}

variable "image_pull_policy" {
  type        = string
  default     = "IfNotPresent"
  description = "Kubernetes image pull policy"
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
  description = "TLS configuration. When set, the routes-chart IngressRoute includes a tls block."
}

variable "local_deployment" {
  type        = bool
  default     = false
  description = "When true, sets LOCAL_DEPLOYMENT=1 on the pod so the runtime skips HSTS."
}

variable "error_page_5xx_html" {
  type        = string
  description = "HTML content for the 5xx error page served by the inline-response plugin"
}

variable "baseline" {
  type = object({
    rfc1918_except   = list(string)
    node_cidr        = string
    coredns_selector = any
    pod_security_context = object({
      run_as_non_root        = bool
      run_as_user            = number
      run_as_group           = number
      fs_group               = number
      fs_group_change_policy = string
      seccomp_profile_type   = string
    })
    container_security_context = object({
      run_as_non_root            = bool
      allow_privilege_escalation = bool
      read_only_root_filesystem  = bool
      capabilities_drop          = list(string)
    })
  })
  description = "Baseline security constants and contexts from the baseline module"
}

variable "traefik_ready" {
  type        = string
  description = "Traefik helm_release_id — used as depends_on token"
}

variable "namespace_ready" {
  type        = list(string)
  description = "Baseline namespace names — ensures namespace exists before any resource in this module"
}
