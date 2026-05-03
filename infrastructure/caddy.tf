locals {
  caddyfile = templatefile("${path.module}/files/Caddyfile.tmpl", {
    acme_email = var.acme_email
    sites = [
      for name, cfg in local.envs : {
        domain   = cfg.domain
        upstream = "127.0.0.1:${cfg.port}"
      }
    ]
  })

  caddy_quadlet = templatefile("${path.module}/files/caddy.container.tmpl", {
    caddy_image = var.caddy_image
  })

  # Caddy's two managed-file entries. Both auto-clean: removing the
  # declaration stops Caddy and removes the file. Edit-induced replacement
  # causes a brief HTTPS interruption (destroy stops + rm; create writes
  # + restart). Removing Caddy from configuration is operator-intentional
  # teardown, not a casual edit.
  managed_files_caddy = {
    caddyfile = {
      path    = "/etc/caddy/Caddyfile"
      content = local.caddyfile
      mode    = "0644"
      owner   = "deploy"
      group   = "deploy"
      sudo    = false
      stage   = "pre"
      # No reload here: caddy_quadlet's stage-post restart picks it up.
      on_change  = ""
      on_destroy = "rm -f /etc/caddy/Caddyfile"
    }
    caddy_quadlet = {
      path       = "/home/wfe-caddy/.config/containers/systemd/caddy.container"
      content    = local.caddy_quadlet
      mode       = "0644"
      owner      = "wfe-caddy"
      group      = "wfe-caddy"
      sudo       = true
      stage      = "post"
      on_change  = "uid=$(id -u wfe-caddy) && sudo /usr/sbin/runuser -u wfe-caddy -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user daemon-reload && sudo /usr/sbin/runuser -u wfe-caddy -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user restart caddy.service"
      on_destroy = "uid=$(id -u wfe-caddy 2>/dev/null) && [ -n \"$uid\" ] && sudo /usr/sbin/runuser -u wfe-caddy -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user stop caddy.service 2>/dev/null; sudo /usr/bin/rm -f /home/wfe-caddy/.config/containers/systemd/caddy.container; [ -n \"$uid\" ] && sudo /usr/sbin/runuser -u wfe-caddy -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user daemon-reload 2>/dev/null || true"
    }
  }
}
