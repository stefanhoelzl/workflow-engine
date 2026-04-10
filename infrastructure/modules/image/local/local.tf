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

resource "terraform_data" "build" {
  provisioner "local-exec" {
    command     = "podman build -t \"${var.image_name}\" -f \"${var.dockerfile_path}\" \"${var.context_dir}\""
    interpreter = ["bash", "-c"]
  }
}

output "image_name" {
  value       = var.image_name
  description = "The built image name"
}
