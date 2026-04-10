variable "registry" {
  type        = string
  description = "Container registry hostname"
}

variable "repository" {
  type        = string
  description = "Image repository path"
}

variable "tag" {
  type        = string
  description = "Image tag"
}

output "image_name" {
  value       = "${var.registry}/${var.repository}:${var.tag}"
  description = "Fully qualified image reference"
}
