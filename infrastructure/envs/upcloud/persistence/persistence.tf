terraform {
  required_version = ">= 1.11"

  required_providers {
    upcloud = {
      source  = "UpCloudLtd/upcloud"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket                      = "tofu-state"
    key                         = "persistence"
    endpoints                   = { s3 = "https://7aqmi.upcloudobjects.com" }
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_s3_checksum            = true
    skip_requesting_account_id  = true
    region                      = "us-east-1"
  }

  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

variable "state_passphrase" {
  type        = string
  sensitive   = true
  description = "Passphrase for client-side state encryption"
}

variable "service_uuid" {
  type        = string
  description = "UUID of the existing Object Storage instance"
}

variable "service_endpoint" {
  type        = string
  description = "Public endpoint URL of the existing Object Storage instance"
}

variable "bucket_name" {
  type        = string
  description = "Name of the app persistence bucket"
}

module "s3" {
  source = "../../../modules/object-storage/upcloud"

  service_uuid = var.service_uuid
  endpoint     = var.service_endpoint
  bucket_name  = var.bucket_name
}

output "endpoint" {
  value       = module.s3.endpoint
  description = "S3-compatible endpoint URL"
}

output "bucket" {
  value       = module.s3.bucket
  description = "Bucket name"
}

output "access_key" {
  value       = module.s3.access_key
  sensitive   = true
  description = "S3 access key ID"
}

output "secret_key" {
  value       = module.s3.secret_key
  sensitive   = true
  description = "S3 secret access key"
}

output "region" {
  value       = module.s3.region
  description = "S3 region"
}
