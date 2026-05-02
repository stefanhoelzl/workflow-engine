locals {
  quadlets = {
    for name, cfg in local.envs : name => templatefile(
      "${path.module}/files/wfe.container.tmpl",
      {
        env_name   = name
        image_ref  = cfg.image_ref
        host_port  = cfg.port
        data_dir   = cfg.data_dir
        memory_max = cfg.memory_max
        base_url   = "https://${cfg.domain}"
        auth_allow = cfg.auth_allow
      }
    )
  }

  # Env file holds ONLY secrets (OAuth credentials). Non-secret values
  # (AUTH_ALLOW, BASE_URL, AUTH_PROVIDER, PERSISTENCE_PATH, PORT) are
  # rendered into the Quadlet's `Environment=` directives — see comment
  # in wfe.container.tmpl for why we avoid Podman's --env-file for those.
  # Bytes still land in tofu state but state is AES-GCM encrypted at rest
  # via the `encryption {}` block in main.tf.
  env_files = {
    for name, cfg in local.envs : name => <<-EOT
      GITHUB_OAUTH_CLIENT_ID=${cfg.gh_oauth_client_id}
      GITHUB_OAUTH_CLIENT_SECRET=${cfg.gh_oauth_secret}
      SECRETS_PRIVATE_KEYS=v1:${random_bytes.secrets_key[name].base64}
    EOT
  }
}

# Per-env X25519 sealing key for the workflow-secrets feature. 32 random
# bytes, base64-encoded. Runtime format: `keyId:base64(sk)`, comma-separated
# for rotation. Generated once per env on first apply, preserved across
# applies (state-tracked). Rotate with `tofu taint
# 'random_bytes.secrets_key["<env>"]'` + apply.
resource "random_bytes" "secrets_key" {
  for_each = local.envs
  length   = 32
}

# Quadlet unit files. Non-secret content (image ref, port, mem cap) — `content`
# attribute is fine; the value is also discoverable from the Caddyfile.
resource "null_resource" "wfe_quadlet" {
  for_each = local.quadlets

  triggers = {
    instance = null_resource.wait_cloud_init.id
    content  = sha256(each.value)
  }

  depends_on = [null_resource.wait_cloud_init]

  connection {
    type        = local.ssh.type
    host        = local.ssh.host
    user        = local.ssh.user
    port        = local.ssh.port
    private_key = local.ssh.private_key
    timeout     = local.ssh.timeout
  }

  provisioner "file" {
    content     = each.value
    destination = "/tmp/wfe-${each.key}.container"
  }

  provisioner "remote-exec" {
    inline = [
      # /etc/containers/systemd is owned by deploy (cloud-init), so no sudo needed.
      "install -m 0644 /tmp/wfe-${each.key}.container /etc/containers/systemd/wfe-${each.key}.container",
      "rm -f /tmp/wfe-${each.key}.container",
      # daemon-reload makes Quadlet generate the .service unit. Restart
      # itself is left to wfe_env_file once /etc/wfe/<env>.env exists —
      # otherwise the unit's EnvironmentFile= would point at a missing path.
      "sudo systemctl daemon-reload",
    ]
  }
}

# Per-env secret env files. Content rendered inline from TF_VAR_* values.
# Bytes are part of state but state is AES-GCM encrypted at rest via the
# `encryption {}` block in main.tf.
resource "null_resource" "wfe_env_file" {
  for_each = local.env_files

  triggers = {
    instance = null_resource.wait_cloud_init.id
    content  = sha256(each.value)
  }

  depends_on = [
    null_resource.wait_cloud_init,
    null_resource.wfe_quadlet,
  ]

  connection {
    type        = local.ssh.type
    host        = local.ssh.host
    user        = local.ssh.user
    port        = local.ssh.port
    private_key = local.ssh.private_key
    timeout     = local.ssh.timeout
  }

  provisioner "file" {
    content     = each.value
    destination = "/tmp/wfe-${each.key}.env.new"
  }

  provisioner "remote-exec" {
    inline = [
      "install -m 0600 -o deploy -g deploy /tmp/wfe-${each.key}.env.new /etc/wfe/${each.key}.env",
      "rm -f /tmp/wfe-${each.key}.env.new",
      "sudo systemctl restart wfe-${each.key}.service",
    ]
  }
}
