output "vps_ip" {
  value       = scaleway_instance_ip.vps.address
  description = "Public IPv4 of the VPS. Stable across instance stop/start."
}

output "ssh_port" {
  value       = var.ssh_port
  description = "Non-default SSH port. Used by `ssh -p <port> deploy@<vps_ip>`."
}

output "urls" {
  value       = { for name, cfg in local.envs : name => "https://${cfg.domain}" }
  description = "Per-env public URL — TLS terminated by Caddy via LE ACME."
}

output "deploy_ssh_private_key" {
  value       = tls_private_key.deploy.private_key_openssh
  sensitive   = true
  description = "Private key for the `deploy` user. Retrieve for emergency SSH access with `tofu output -raw deploy_ssh_private_key > ~/.ssh/wfe_deploy && chmod 600 ~/.ssh/wfe_deploy`."
}
