variable "namespace" {
  type        = string
  default     = "caddy"
  description = "Namespace where Caddy resources are created. Must already exist (created by the baseline module)."
}

variable "sites" {
  type = list(object({
    domain = string
    upstream = object({
      namespace = string
      name      = string
      port      = number
    })
  }))
  description = "Site blocks Caddy serves. One entry per env (prod, staging, ...). Each renders a `<domain> { reverse_proxy <name>.<namespace>.svc.cluster.local:<port> }` block in the Caddyfile."

  validation {
    condition     = length(var.sites) > 0
    error_message = "At least one site must be provided."
  }
}

variable "service_type" {
  type        = string
  default     = "LoadBalancer"
  description = "Kubernetes Service type. LoadBalancer for cluster envs (UpCloud LB), NodePort for the local kind stack."
}

variable "service_annotations" {
  type        = map(string)
  default     = {}
  description = "Annotations on the Caddy Service. Cluster envs pass the UpCloud CCM LB config; local passes none."
}

variable "node_port_https" {
  type        = number
  default     = null
  description = "NodePort for :443 when service_type = NodePort. Ignored otherwise."
}

variable "acme_email" {
  type        = string
  default     = ""
  description = "ACME account email for Let's Encrypt. Empty triggers `tls internal` (Caddy's internal CA) — used in the local kind stack to avoid public LE."
}

variable "image_tag" {
  type        = string
  default     = "2.10.0-alpine"
  description = "Caddy container image tag. Bump deliberately."
}

variable "pvc_size" {
  type        = string
  default     = "1Gi"
  description = "PVC size for /data (ACME account, certificates, OCSP staples)."
}

variable "pvc_storage_class" {
  type        = string
  default     = null
  description = "PVC storage class. Null uses the cluster default. UpCloud Managed K8s exposes `standard`."
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
  description = "Baseline security constants and contexts from the baseline module."
}

variable "namespace_ready" {
  type        = list(string)
  default     = []
  description = "Baseline namespace names — used as a depends_on token to ensure the namespace exists before Caddy resources are created."
}
