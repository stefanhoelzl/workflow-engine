terraform {
  required_version = ">= 1.11"

  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "~> 2.50"
    }
    restapi = {
      source  = "Mastercard/restapi"
      version = "~> 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Scaleway Object Storage is S3-compatible. Bucket is pre-created out-of-band.
  backend "s3" {
    bucket                      = "tofu-states"
    key                         = "vps"
    endpoints                   = { s3 = "https://s3.fr-par.scw.cloud" }
    region                      = "fr-par"
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_s3_checksum            = true
    skip_requesting_account_id  = true
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

provider "scaleway" {
  region          = var.scaleway_region
  zone            = var.scaleway_zone
  project_id      = var.scaleway_project_id
  organization_id = var.scaleway_organization_id
}

provider "restapi" {
  uri                  = "https://api.dynu.com/v2"
  write_returns_object = true
  headers = {
    accept       = "application/json"
    Content-Type = "application/json"
    API-Key      = var.dynu_api_key
  }
}

# Public IPv4 — survives stop/start cycles, so DNS records remain valid even
# if the instance is replaced.
resource "scaleway_instance_ip" "vps" {
  type = "routed_ipv4"
}

# Inbound traffic policy. Default deny everything; allow only HTTP, HTTPS, and
# the configured SSH port. Outbound traffic is unrestricted.
resource "scaleway_instance_security_group" "vps" {
  name                    = "wfe-vps"
  inbound_default_policy  = "drop"
  outbound_default_policy = "accept"

  inbound_rule {
    action = "accept"
    port   = 80
  }
  inbound_rule {
    action = "accept"
    port   = 443
  }
  inbound_rule {
    action = "accept"
    port   = var.ssh_port
  }
}

# Tracks the rendered cloud-init content. Any change to the template (or its
# inputs) flips the hash → forces VPS replacement via the lifecycle rule on
# `scaleway_instance_server.vps`. Without this, the Scaleway provider would
# update `user_data` in-place (API-mutable), but cloud-init only runs at
# first boot — the new config would never take effect on the existing box.
resource "terraform_data" "cloud_init" {
  input = sha256(templatefile("${path.module}/cloud-init.yaml", {
    ssh_port              = var.ssh_port
    deploy_ssh_public_key = var.deploy_ssh_public_key
  }))
}

resource "scaleway_instance_server" "vps" {
  name              = "wfe"
  type              = var.instance_type
  image             = var.instance_image
  ip_id             = scaleway_instance_ip.vps.id
  security_group_id = scaleway_instance_security_group.vps.id

  # Force replacement when cloud-init template content changes.
  lifecycle {
    replace_triggered_by = [terraform_data.cloud_init]
  }

  # Local SSD root volume (10 GB, included with STARDUST1-S, free).
  # Local SSDs are bound to the instance's lifecycle — they die on
  # instance replacement. For data that should survive replacement,
  # add a separate `scaleway_block_volume` SBS resource and mount it at
  # /srv via cloud-init (additional volume, not root). Root volume on
  # Scaleway is always bound to instance creation (the image is written
  # at that point), so root-volume survival across replacement is not
  # achievable via `delete_on_termination = false` alone — tofu would
  # orphan the old volume and create a fresh one from the image anyway.
  root_volume {
    size_in_gb            = 10
    volume_type           = "l_ssd"
    delete_on_termination = true
  }

  # Any change to user_data triggers VPS replacement. Cloud-init only runs at
  # first boot, so this is the only way to re-bake host config (sshd port,
  # firewall rules, deploy user's SSH key, swapfile). Costs: local-disk data
  # at /srv/wfe/* + /srv/caddy/data is lost on replacement; the IP survives
  # (separate scaleway_instance_ip resource), so DNS need not change.
  user_data = {
    cloud-init = templatefile("${path.module}/cloud-init.yaml", {
      ssh_port              = var.ssh_port
      deploy_ssh_public_key = var.deploy_ssh_public_key
    })
  }
}

# Single source of truth for per-env configuration. Every other resource
# (apps.tf, caddy.tf, dns.tf, outputs.tf) iterates this map — adding a third
# env is a single new key here plus whatever GHA secrets it needs.
locals {
  envs = {
    prod = {
      domain             = "workflow-engine.webredirect.org"
      dns_node           = ""
      port               = 8081
      image_ref          = "${var.app_image}:release"
      data_dir           = "/srv/wfe/prod"
      memory_max         = "350M"
      gh_oauth_client_id = var.gh_oauth_client_id_prod
      gh_oauth_secret    = var.gh_oauth_client_secret_prod
      # NOTE: separator is `;` to match the currently-deployed :release/:main
      # image (built from a pre-`863377a0` commit). Switch to `,` once a fresh
      # image is built from this branch (the comma-separator code lands).
      auth_allow = "github:user:stefanhoelzl;github:user:mrh1997;github:org:baltech-ag;github:org:sharepad-de"
    }
    staging = {
      domain             = "staging.workflow-engine.webredirect.org"
      dns_node           = "staging"
      port               = 8082
      image_ref          = "${var.app_image}:main"
      data_dir           = "/srv/wfe/staging"
      memory_max         = "350M"
      gh_oauth_client_id = var.gh_oauth_client_id_staging
      gh_oauth_secret    = var.gh_oauth_client_secret_staging
      auth_allow         = "github:user:stefanhoelzl"
    }
  }

  # SSH connection block shared by every provisioner.
  ssh = {
    type        = "ssh"
    host        = scaleway_instance_ip.vps.address
    user        = "deploy"
    port        = var.ssh_port
    private_key = var.deploy_ssh_private_key
    timeout     = "5m"
  }
}

# Block until cloud-init has finished. Every other provisioner depends on this
# so we never race the bootstrap.
resource "null_resource" "wait_cloud_init" {
  triggers = {
    server_id = scaleway_instance_server.vps.id
  }

  connection {
    type        = local.ssh.type
    host        = local.ssh.host
    user        = local.ssh.user
    port        = local.ssh.port
    private_key = local.ssh.private_key
    timeout     = local.ssh.timeout
  }

  provisioner "remote-exec" {
    # cloud-init exits 2 on any recoverable error (deprecation warnings,
    # Scaleway-Debian-specific module noise), so treat 0 and 2 as success
    # and assert the textual status is `done`.
    inline = [
      "cloud-init status --wait || [ $? -eq 2 ]",
      "cloud-init status | grep -q '^status: done$'",
    ]
  }
}
