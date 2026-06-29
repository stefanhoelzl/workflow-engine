output "urls" {
  # Both envs run on bunny.net Magic Containers with Bunny-managed HTTPS.
  value       = { for name, cfg in local.bunny_envs : name => "https://${cfg.domain}" }
  description = "Per-env public URL (Bunny managed HTTPS)."
}
