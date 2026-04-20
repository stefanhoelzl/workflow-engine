variable "image_name" {
  type        = string
  description = "Tag for the built image"
}

variable "dockerfile_path" {
  type        = string
  description = "Path to the Dockerfile"
}

variable "context_dir" {
  type        = string
  description = "Build context directory"
}

terraform {
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

resource "terraform_data" "build" {
  triggers_replace = timestamp()

  provisioner "local-exec" {
    command     = <<-EOT
      podman build -t "${var.image_name}" -f "${var.dockerfile_path}" "${var.context_dir}"
      podman inspect --format '{{.Id}}' "${var.image_name}" > "${path.module}/.image-id"
    EOT
    interpreter = ["bash", "-c"]
  }
}

data "local_file" "image_id" {
  filename   = "${path.module}/.image-id"
  depends_on = [terraform_data.build]
}

output "image_name" {
  value       = var.image_name
  description = "The built image name"
}

output "image_hash" {
  value       = trimspace(data.local_file.image_id.content)
  description = "Content hash of the built image"
}

output "build_id" {
  value       = terraform_data.build.id
  description = "Unique ID of the most recent build; changes on every tofu apply (since `triggers_replace = timestamp()`). Use as an extra rollout signal when the content-addressable image hash happens to match across builds."
}
