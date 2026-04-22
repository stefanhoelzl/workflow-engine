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

variable "image_build_id" {
  type        = string
  default     = ""
  description = "Optional extra rollout signal. Intended for local dev, where the content-addressable image hash from `podman inspect` can remain stable across builds even when source bytes changed. Prod callers leave this empty; local callers pass `module.image.build_id`."
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

# AUTH_ALLOW grammar: provider:kind:id, comma-separated.
# Example: "github:user:stefanhoelzl,github:org:acme"
# Empty or unset => disabled mode (401 everywhere).
# See packages/runtime/src/auth/allowlist.ts.
variable "auth_allow" {
  type        = string
  description = "AUTH_ALLOW env value for the app; provider-prefixed grammar consumed by the in-app auth capability."
}

variable "github_oauth" {
  type = object({
    client_id     = string
    client_secret = string
  })
  sensitive   = true
  description = "GitHub OAuth App credentials. Required when auth_allow resolves to restricted mode."
}

variable "network" {
  type = object({
    domain     = string
    https_port = number
  })
  description = "Network configuration"
}

variable "tls" {
  type = object({
    secretName = string
  })
  default     = null
  description = "TLS configuration. When set, the routes-chart IngressRoute includes a tls block."
}

variable "active_issuer_name" {
  type        = string
  default     = null
  description = "Name of the cert-manager ClusterIssuer used to sign the app's leaf Certificate. When set together with tls, the routes-chart renders a Certificate resource in the app's namespace."
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

variable "cert_manager_ready" {
  type        = string
  default     = ""
  description = "cert-manager readiness token (typically `module.cert_manager.extras_ready`). Used as a depends_on gate for the routes helm_release so the Certificate manifest is not submitted before the cert-manager validating webhook is accepting connections. Only load-bearing for co-applied envs (e.g. local); in split-project envs the cluster apply completes before apps start."
}

variable "image_ready" {
  type        = string
  default     = ""
  description = "Depends-on token for image availability. In local dev, pass `module.cluster.image_ready` so the app Deployment's rollout waits until the new image is imported into kind's containerd (prevents pods from silently running the previous image). In prod, leave empty — the image comes from a registry, not a local import."
}

variable "namespace_ready" {
  type        = list(string)
  description = "Baseline namespace names — ensures namespace exists before any resource in this module"
}
