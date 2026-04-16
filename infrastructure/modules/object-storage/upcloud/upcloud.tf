terraform {
  required_providers {
    upcloud = {
      source  = "UpCloudLtd/upcloud"
      version = "~> 5.0"
    }
  }
}

variable "service_uuid" {
  type        = string
  description = "UUID of the Managed Object Storage instance"
}

variable "endpoint" {
  type        = string
  description = "Public endpoint URL of the Object Storage instance"
}

variable "bucket_name" {
  type        = string
  description = "Name of the bucket to create"
}

resource "upcloud_managed_object_storage_bucket" "this" {
  service_uuid = var.service_uuid
  name         = var.bucket_name
}

resource "upcloud_managed_object_storage_user" "this" {
  service_uuid = var.service_uuid
  username     = "${var.bucket_name}-user"
}

resource "upcloud_managed_object_storage_policy" "this" {
  service_uuid = var.service_uuid
  name         = "${var.bucket_name}-access"
  document = urlencode(jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
      ]
      Resource = [
        "arn:aws:s3:::${var.bucket_name}",
        "arn:aws:s3:::${var.bucket_name}/*",
      ]
    }]
  }))
}

resource "upcloud_managed_object_storage_user_policy" "this" {
  service_uuid = var.service_uuid
  username     = upcloud_managed_object_storage_user.this.username
  name         = upcloud_managed_object_storage_policy.this.name
}

resource "upcloud_managed_object_storage_user_access_key" "this" {
  service_uuid = var.service_uuid
  username     = upcloud_managed_object_storage_user.this.username
  status       = "Active"
}

output "endpoint" {
  value       = var.endpoint
  description = "S3-compatible endpoint URL"
}

output "bucket" {
  value       = var.bucket_name
  description = "Bucket name"
}

output "access_key" {
  value       = upcloud_managed_object_storage_user_access_key.this.access_key_id
  sensitive   = true
  description = "S3 access key ID"
}

output "secret_key" {
  value       = upcloud_managed_object_storage_user_access_key.this.secret_access_key
  sensitive   = true
  description = "S3 secret access key"
}

output "region" {
  value       = "us-east-1"
  description = "S3 region (placeholder for UpCloud)"
}
