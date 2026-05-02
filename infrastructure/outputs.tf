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
