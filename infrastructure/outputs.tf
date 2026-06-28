output "vps_ip" {
  value       = scaleway_instance_ip.vps.address
  description = "Public IPv4 of the VPS. Stable across instance stop/start."
}

output "ssh_port" {
  value       = var.ssh_port
  description = "Non-default SSH port. Used by `ssh -p <port> deploy@<vps_ip>`."
}

output "urls" {
  # VPS envs (prod) get their TLS from Caddy/LE ACME; staging runs on Bunny
  # Magic Containers (managed HTTPS), so its URL comes from local.bunny_staging.
  value = merge(
    { for name, cfg in local.envs : name => "https://${cfg.domain}" },
    { staging = "https://${local.bunny_staging.domain}" },
  )
  description = "Per-env public URL. prod: TLS via Caddy/LE ACME; staging: Bunny managed HTTPS."
}

output "deploy_ssh_private_key" {
  value       = tls_private_key.deploy.private_key_openssh
  sensitive   = true
  description = "Private key for the `deploy` user. Retrieve for emergency SSH access with `tofu output -raw deploy_ssh_private_key > ~/.ssh/wfe_deploy && chmod 600 ~/.ssh/wfe_deploy`."
}
