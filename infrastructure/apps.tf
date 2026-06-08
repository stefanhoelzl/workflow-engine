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
        domain     = cfg.domain
        base_url   = "https://${cfg.domain}"
        auth_allow = cfg.auth_allow

        retention_days = cfg.retention_days
      }
    )
  }

  # Env file holds ONLY secrets (OAuth credentials). Non-secret values
  # (AUTH_ALLOW, BASE_URL, AUTH_PROVIDER, PERSISTENCE_PATH, PORT) are
  # rendered into the Quadlet's `Environment=` directives — see comment
  # in wfe.container.tmpl for why we avoid Podman's --env-file for those.
  env_files = {
    for name, cfg in local.envs : name => <<-EOT
      GITHUB_OAUTH_CLIENT_ID=${cfg.gh_oauth_client_id}
      GITHUB_OAUTH_CLIENT_SECRET=${cfg.gh_oauth_secret}
      SECRETS_PRIVATE_KEYS=v1:${random_bytes.secrets_key[name].base64}
    EOT
  }

  # Per-env file entries fed into the unified managed_files map in main.tf.
  # User-mode design:
  # - Quadlets live in /home/wfe-<env>/.config/containers/systemd/ owned by
  #   the tenant user (linger-enabled). Podman runs rootless under that user.
  # - Env files live at /etc/wfe/<env>.env owned by the tenant user (mode
  #   0600) so user-mode systemd can read them via EnvironmentFile=.
  # - Both auto-clean: removing the declaration stops the tenant's service
  #   and removes the file. Edit-induced replacement causes a brief service
  #   interruption (destroy stops + rm; create writes + restart). Acceptable
  #   per the convergence contract; intentional removal of a tenant requires
  #   removing the user, dirs, env file AND Quadlet in the same apply (tofu
  #   destroys dependents in reverse-dependency order so the Quadlet stops
  #   before the user is removed).
  managed_files_apps = merge(
    {
      for env, cfg in local.envs : "wfe_env_${env}" => {
        path    = "/etc/wfe/${env}.env"
        content = local.env_files[env]
        mode    = "0600"
        owner   = cfg.runtime_user
        group   = cfg.runtime_user
        sudo    = true
        stage   = "pre"
        # User-mode `systemctl --user restart` via runuser. The `|| true`
        # swallow handles the first-apply case where the unit doesn't
        # exist yet (Quadlet entry is stage `post`, lands later in the
        # same apply); on subsequent secret rotations the unit exists
        # and restarts cleanly.
        on_change  = "uid=$(id -u ${cfg.runtime_user}) && sudo /usr/sbin/runuser -u ${cfg.runtime_user} -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user restart wfe-${env}.service 2>/dev/null || true"
        on_destroy = "uid=$(id -u ${cfg.runtime_user} 2>/dev/null) && [ -n \"$uid\" ] && sudo /usr/sbin/runuser -u ${cfg.runtime_user} -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user stop wfe-${env}.service 2>/dev/null; sudo /usr/bin/rm -f /etc/wfe/${env}.env"
      }
    },
    {
      for env, cfg in local.envs : "wfe_quadlet_${env}" => {
        path       = "/home/${cfg.runtime_user}/.config/containers/systemd/wfe-${env}.container"
        content    = local.quadlets[env]
        mode       = "0644"
        owner      = cfg.runtime_user
        group      = cfg.runtime_user
        sudo       = true
        stage      = "post"
        on_change  = "uid=$(id -u ${cfg.runtime_user}) && sudo /usr/sbin/runuser -u ${cfg.runtime_user} -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user daemon-reload && sudo /usr/sbin/runuser -u ${cfg.runtime_user} -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user restart wfe-${env}.service"
        on_destroy = "uid=$(id -u ${cfg.runtime_user} 2>/dev/null) && [ -n \"$uid\" ] && sudo /usr/sbin/runuser -u ${cfg.runtime_user} -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user stop wfe-${env}.service 2>/dev/null; sudo /usr/bin/rm -f /home/${cfg.runtime_user}/.config/containers/systemd/wfe-${env}.container; [ -n \"$uid\" ] && sudo /usr/sbin/runuser -u ${cfg.runtime_user} -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user daemon-reload 2>/dev/null || true"
      }
    },
  )
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
