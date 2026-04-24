variable "name" {
  type        = string
  description = "NetworkPolicy resource name"
}

variable "namespace" {
  type        = string
  description = "Target namespace"
}

variable "pod_selector" {
  type        = map(string)
  description = "Labels selecting target pods"
}

variable "egress_internet" {
  type        = bool
  default     = false
  description = "When true, adds egress to 0.0.0.0/0 except RFC1918"
}

variable "egress_dns" {
  type        = bool
  default     = false
  description = "When true, adds UDP+TCP 53 egress to CoreDNS"
}

variable "egress_to" {
  type = list(object({
    pod_selector       = map(string)
    namespace_selector = optional(map(string))
    port               = number
    enabled            = optional(bool, true)
  }))
  default     = []
  description = "Per-pod egress rules with an optional enabled flag"
}

variable "ingress_from_pods" {
  type = list(object({
    pod_selector       = map(string)
    namespace_selector = optional(map(string))
    port               = number
  }))
  default     = []
  description = "Per-pod ingress rules"
}

variable "ingress_from_cidrs" {
  type = list(object({
    cidr  = string
    ports = list(number)
  }))
  default     = []
  description = "Per-CIDR ingress rules with multiple ports"
}

variable "rfc1918_except" {
  type        = list(string)
  description = "RFC1918 + link-local CIDRs to exclude from internet egress"
}

variable "coredns_selector" {
  type = object({
    namespace  = string
    k8s_app_in = list(string)
  })
  description = "Shorthand CoreDNS selector: target namespace (matched via kubernetes.io/metadata.name) and list of k8s-app label values to accept (typically [\"coredns\", \"kube-dns\"])."
}
