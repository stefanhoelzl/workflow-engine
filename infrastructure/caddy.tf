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
}

resource "null_resource" "caddyfile" {
  triggers = {
    instance = null_resource.wait_cloud_init.id
    content  = sha256(local.caddyfile)
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
    content     = local.caddyfile
    destination = "/tmp/Caddyfile"
  }

  provisioner "remote-exec" {
    inline = [
      # /etc/caddy is owned by deploy (cloud-init), so no sudo needed.
      "install -m 0644 /tmp/Caddyfile /etc/caddy/Caddyfile",
      "rm -f /tmp/Caddyfile",
      # Reload happens via the caddy_quadlet restart cascade; explicit
      # reload here would need an extra sudoers entry for the `reload` verb.
    ]
  }
}

resource "null_resource" "caddy_quadlet" {
  triggers = {
    instance = null_resource.wait_cloud_init.id
    content  = sha256(local.caddy_quadlet)
  }

  # Caddyfile must be in place before podman tries to bind-mount it.
  depends_on = [null_resource.caddyfile]

  connection {
    type        = local.ssh.type
    host        = local.ssh.host
    user        = local.ssh.user
    port        = local.ssh.port
    private_key = local.ssh.private_key
    timeout     = local.ssh.timeout
  }

  provisioner "file" {
    content     = local.caddy_quadlet
    destination = "/tmp/caddy.container"
  }

  provisioner "remote-exec" {
    inline = [
      # /etc/containers/systemd is owned by deploy (cloud-init), so no sudo needed.
      "install -m 0644 /tmp/caddy.container /etc/containers/systemd/caddy.container",
      "rm -f /tmp/caddy.container",
      "sudo systemctl daemon-reload",
      "sudo systemctl restart caddy.service",
    ]
  }
}
