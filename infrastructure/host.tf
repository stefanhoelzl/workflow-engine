# Host-level convergence inputs. Six typed maps drive the unified
# null_resources in main.tf:
#
#   managed_users     → wfe-* per-tenant container-runtime accounts (linger-enabled)
#   managed_dirs      → /etc/* and /srv/* layout, plus per-user ~/.config/...
#   managed_packages  → apt list (idempotent install on change of the joined hash)
#   managed_files     → typed files with content + mode + owner; pre/post stages
#   managed_exec      → imperative one-shots (swapfile, system-mode service enables,
#                       per-user enable of podman-auto-update.timer)
#   managed_ufw       → app-side firewall rules
#
# `managed_files_apps` (apps.tf) and `managed_files_caddy` (caddy.tf) are
# merged in main.tf to form the full file set.

locals {
  # Per-tenant rootless container-runtime users. Each runs its own user-mode
  # systemd (linger-enabled) hosting one Quadlet under
  # /home/<user>/.config/containers/systemd/. Subuid ranges are explicit and
  # stable — auto-allocation (`100000 + i*65536`) would shift ranges when
  # tenants are added/removed, invalidating existing on-disk subuid-mapped
  # ownership of /srv/<tenant>/* data.
  managed_users = {
    "wfe-prod" = {
      shell  = "/usr/sbin/nologin"
      subuid = "100000-165535"
    }
    "wfe-staging" = {
      shell  = "/usr/sbin/nologin"
      subuid = "165536-231071"
    }
    "wfe-caddy" = {
      shell  = "/usr/sbin/nologin"
      subuid = "231072-296607"
    }
  }

  # Convenience: list of tenant user keys, used to generate per-user dirs +
  # timer-override files below.
  tenants = ["wfe-prod", "wfe-staging", "wfe-caddy"]

  # Per-env data volumes (defined in main.tf). The format script resolves each
  # device by matching the volume UUID (the segment after the zone in the
  # resource id `<zone>/<uuid>`) against the block device's virtio serial.
  # Spec format consumed by files/wfe-data-format.sh.tmpl: "<uuid>:<fs-label>".
  data_volume_ids = {
    prod    = scaleway_block_volume.prod.id
    staging = scaleway_block_volume.staging.id
  }
  data_volume_specs = [
    for env, vid in local.data_volume_ids :
    "${element(split("/", vid), length(split("/", vid)) - 1)}:wfe-${env}"
  ]

  # Exec-stage one-shot: enable the per-env data mounts (which pull in the
  # format service to mkfs-if-empty), then hand a freshly-formatted root:root
  # mount root to its tenant so the container's `:U` chown works (guarded so a
  # reattached, already-subuid-owned volume is left untouched). Content-only —
  # references no volume ids — so its hash is stable across applies and only
  # flips when this logic or the env set changes.
  enable_data_mounts_script = <<-EOT
    set -euo pipefail
    sudo /bin/systemctl daemon-reload
    %{~for env, cfg in local.envs~}
    sudo /bin/systemctl enable --now srv-wfe-${env}.mount
    if [ -n "$(find ${cfg.data_dir} -maxdepth 0 -uid 0 2>/dev/null)" ]; then
      sudo /usr/bin/chown -R ${cfg.runtime_user}:${cfg.runtime_user} ${cfg.data_dir}
      sudo /usr/bin/chmod 0700 ${cfg.data_dir}
    fi
    %{~endfor~}
  EOT

  # Directories. Order is irrelevant within the stage — `install -d` creates
  # parents and is idempotent.
  managed_dirs = merge(
    {
      # deploy-owned config dirs. /etc/wfe is mode 0711 (not 0700) so each
      # `wfe-<env>` user-mode systemd can traverse the dir and open() its
      # own `<env>.env` file (which is 0600 owned wfe-<env>); listing the
      # dir is still owner-only. Per-file ownership prevents cross-tenant
      # reads of the actual secret content.
      "/etc/wfe"   = { mode = "0711", owner = "deploy", group = "deploy" }
      "/etc/caddy" = { mode = "0755", owner = "deploy", group = "deploy" }
      # Per-tenant data dirs. Owned by the tenant user — escape from one
      # tenant's container lands the attacker in that user's namespace,
      # which has no read access to peers (mode 0700 owned by other user).
      "/srv/wfe"          = { mode = "0755", owner = "root", group = "root" }
      "/srv/wfe/prod"     = { mode = "0700", owner = "wfe-prod", group = "wfe-prod" }
      "/srv/wfe/staging"  = { mode = "0700", owner = "wfe-staging", group = "wfe-staging" }
      "/srv/caddy"        = { mode = "0755", owner = "root", group = "root" }
      "/srv/caddy/data"   = { mode = "0700", owner = "wfe-caddy", group = "wfe-caddy" }
      "/srv/caddy/config" = { mode = "0700", owner = "wfe-caddy", group = "wfe-caddy" }
    },
    # Per-tenant ~/.config/ subtree. EVERY dir level is enumerated
    # explicitly because `install -d /a/b/c -o user` only sets ownership
    # on `c`; parents get default (root-owned, mode 0755). On re-apply,
    # install -d updates ownership on existing dirs, so listing each
    # level is both correct and idempotent.
    {
      for u in local.tenants : "/home/${u}/.config" => {
        mode = "0755", owner = u, group = u
      }
    },
    {
      for u in local.tenants : "/home/${u}/.config/containers" => {
        mode = "0755", owner = u, group = u
      }
    },
    {
      for u in local.tenants : "/home/${u}/.config/containers/systemd" => {
        mode = "0755", owner = u, group = u
      }
    },
    {
      for u in local.tenants : "/home/${u}/.config/systemd" => {
        mode = "0755", owner = u, group = u
      }
    },
    {
      for u in local.tenants : "/home/${u}/.config/systemd/user" => {
        mode = "0755", owner = u, group = u
      }
    },
    {
      for u in local.tenants : "/home/${u}/.config/systemd/user/podman-auto-update.timer.d" => {
        mode = "0755", owner = u, group = u
      }
    },
    {
      for u in local.tenants : "/home/${u}/.config/systemd/user/timers.target.wants" => {
        mode = "0755", owner = u, group = u
      }
    },
  )

  # Apt packages. Cloud-init installs only `ufw` and `sudo`; everything else
  # the host needs is here.
  managed_packages = [
    "podman",
    "fail2ban",
    "unattended-upgrades",
    "curl",
    "ca-certificates",
    "systemd-container", # provides machinectl + machined for cross-user systemctl ops
  ]

  # /etc/subuid + /etc/subgid content: one line per managed user, format
  # `<user>:<start>:<count>` where count = end - start + 1. Rendered from
  # local.managed_users (the single source of truth). Sorted by user name
  # so the file content is deterministic across applies — different
  # iteration order across plans would otherwise show spurious diffs.
  subid_content = join("", [
    for line in sort([
      for u, c in local.managed_users :
      "${u}:${split("-", c.subuid)[0]}:${tonumber(split("-", c.subuid)[1]) - tonumber(split("-", c.subuid)[0]) + 1}"
    ]) : "${line}\n"
  ])

  # Host-level managed files. Auto-clean (default): removing an entry removes
  # the file on next apply. App-level files (env files, Quadlets) live in
  # apps.tf and caddy.tf.
  managed_files_host = merge(
    {
      # /etc/subuid and /etc/subgid: explicit per-tenant ranges. Overwrites
      # useradd's auto-allocated ranges. Auto-clean: removing the entry
      # from configuration removes the file. Running containers cache
      # their UID mappings at start, so a brief absence between destroy
      # and re-create on content edits doesn't disrupt them; new podman
      # invocations during the window may fail (rare, sub-second).
      subuid = {
        path       = "/etc/subuid"
        content    = local.subid_content
        mode       = "0644"
        owner      = "root"
        group      = "root"
        sudo       = true
        stage      = "pre"
        on_change  = ""
        on_destroy = "sudo /usr/bin/rm -f /etc/subuid"
      }
      subgid = {
        path       = "/etc/subgid"
        content    = local.subid_content
        mode       = "0644"
        owner      = "root"
        group      = "root"
        sudo       = true
        stage      = "pre"
        on_change  = ""
        on_destroy = "sudo /usr/bin/rm -f /etc/subgid"
      }
      sshd_hardening = {
        path       = "/etc/ssh/sshd_config.d/10-hardening.conf"
        content    = templatefile("${path.module}/files/sshd_hardening.conf.tmpl", { ssh_port = var.ssh_port })
        mode       = "0644"
        owner      = "root"
        group      = "root"
        sudo       = true
        stage      = "pre"
        on_change  = "sudo /bin/systemctl reload ssh"
        on_destroy = "sudo /usr/bin/rm -f /etc/ssh/sshd_config.d/10-hardening.conf && sudo /bin/systemctl reload ssh"
      }
      # NOTE: /etc/sudoers.d/deploy is NOT in this map — it's owned by the
      # dedicated `null_resource.managed_sudoers` stage-0 resource in main.tf,
      # which runs BEFORE managed_user. Otherwise managed_user's create script
      # (which uses sudo loginctl + sudo runuser) would fail on a VPS whose
      # existing sudoers predates the addition of those verbs.
      fail2ban_jail = {
        path       = "/etc/fail2ban/jail.d/sshd.local"
        content    = templatefile("${path.module}/files/fail2ban_jail.conf.tmpl", { ssh_port = var.ssh_port })
        mode       = "0644"
        owner      = "root"
        group      = "root"
        sudo       = true
        stage      = "pre"
        on_change  = "sudo /bin/systemctl restart fail2ban"
        on_destroy = "sudo /usr/bin/rm -f /etc/fail2ban/jail.d/sshd.local && sudo /bin/systemctl restart fail2ban 2>/dev/null || true"
      }
      sysctl_unprivileged = {
        path       = "/etc/sysctl.d/10-unprivileged-ports.conf"
        content    = file("${path.module}/files/sysctl_unprivileged.conf")
        mode       = "0644"
        owner      = "root"
        group      = "root"
        sudo       = true
        stage      = "pre"
        on_change  = "sudo /usr/sbin/sysctl --system"
        on_destroy = "sudo /usr/bin/rm -f /etc/sysctl.d/10-unprivileged-ports.conf && sudo /usr/sbin/sysctl --system"
      }
      # Daily disk reclaim: apt archive cache + systemd journal + dangling
      # rootless images per tenant. The script + .service file go in "pre";
      # the .timer goes in "post" so it cannot fire (Persistent=true catch-up)
      # before its prerequisites are on disk — managed_file_pre's for_each is
      # unordered, but managed_file_post depends_on managed_file_pre.
      disk_cleanup_script = {
        path       = "/usr/local/sbin/disk-cleanup.sh"
        content    = templatefile("${path.module}/files/disk-cleanup.sh.tmpl", { tenants = join(" ", local.tenants) })
        mode       = "0755"
        owner      = "root"
        group      = "root"
        sudo       = true
        stage      = "pre"
        on_change  = ""
        on_destroy = "sudo /usr/bin/rm -f /usr/local/sbin/disk-cleanup.sh"
      }
      disk_cleanup_service = {
        path       = "/etc/systemd/system/disk-cleanup.service"
        content    = file("${path.module}/files/disk-cleanup.service")
        mode       = "0644"
        owner      = "root"
        group      = "root"
        sudo       = true
        stage      = "pre"
        on_change  = "sudo /bin/systemctl daemon-reload"
        on_destroy = "sudo /usr/bin/rm -f /etc/systemd/system/disk-cleanup.service && sudo /bin/systemctl daemon-reload"
      }
      disk_cleanup_timer = {
        path       = "/etc/systemd/system/disk-cleanup.timer"
        content    = file("${path.module}/files/disk-cleanup.timer")
        mode       = "0644"
        owner      = "root"
        group      = "root"
        sudo       = true
        stage      = "post"
        on_change  = "sudo /bin/systemctl daemon-reload && sudo /bin/systemctl enable --now disk-cleanup.timer"
        on_destroy = "sudo /bin/systemctl disable --now disk-cleanup.timer 2>/dev/null || true; sudo /usr/bin/rm -f /etc/systemd/system/disk-cleanup.timer && sudo /bin/systemctl daemon-reload"
      }

      # ── Per-env data-volume formatting + swap, all routed through systemd ──
      # so no new sudoers verbs are needed (mkfs/blkid/mount/swapon run as root
      # via systemd, enabled with the already-allowed `systemctl`). Keeps the
      # apply a stop/start — no sudoers edit, no cloud-init hash flip.

      # Root-owned format script: mkfs.ext4 -L wfe-<env> a data volume ONLY when
      # `blkid -p` finds no signature (so reattached/already-formatted volumes
      # and the root are never wiped). Rendered with the volume UUIDs.
      wfe_data_format_script = {
        path = "/usr/local/sbin/wfe-data-format.sh"
        content = templatefile("${path.module}/files/wfe-data-format.sh.tmpl", {
          specs = local.data_volume_specs
        })
        mode       = "0755"
        owner      = "root"
        group      = "root"
        sudo       = true
        stage      = "pre"
        on_change  = ""
        on_destroy = "sudo /usr/bin/rm -f /usr/local/sbin/wfe-data-format.sh"
      }
      # Oneshot service that runs the format script, ordered Before the mounts.
      # No [Install]; the .mount units pull it in via Requires=.
      wfe_data_format_service = {
        path       = "/etc/systemd/system/wfe-data-format.service"
        content    = file("${path.module}/files/wfe-data-format.service")
        mode       = "0644"
        owner      = "root"
        group      = "root"
        sudo       = true
        stage      = "pre"
        on_change  = "sudo /bin/systemctl daemon-reload"
        on_destroy = "sudo /usr/bin/rm -f /etc/systemd/system/wfe-data-format.service && sudo /bin/systemctl daemon-reload"
      }
      # Swap activated via a .swap unit (systemd does the swapon) — retires the
      # /etc/fstab swap line and the latent leaked-line wart. The swapfile
      # itself is created in managed_exec (fallocate + mkswap, both allowlisted).
      swapfile_swap = {
        path       = "/etc/systemd/system/swapfile.swap"
        content    = file("${path.module}/files/swapfile.swap")
        mode       = "0644"
        owner      = "root"
        group      = "root"
        sudo       = true
        stage      = "post"
        on_change  = "sudo /bin/systemctl daemon-reload && sudo /bin/systemctl enable --now swapfile.swap"
        on_destroy = "sudo /bin/systemctl disable --now swapfile.swap 2>/dev/null || true; sudo /usr/bin/rm -f /etc/systemd/system/swapfile.swap && sudo /bin/systemctl daemon-reload"
      }
    },
    # Per-env mount unit FILES. Written in the `pre` stage (reload only, NOT
    # enabled here) so they exist before the `exec`-stage enable below; the
    # actual `enable --now` lives in managed_exec["enable_data_mounts"] so the
    # mount is active BEFORE the app Quadlets (post stage) restart with their
    # `ExecStartPre=mountpoint -q` guard. Ordering across stages is the only way
    # to sequence this — within a single stage the convergence runs in parallel.
    {
      for env, cfg in local.envs : "srv_wfe_mount_${env}" => {
        path = "/etc/systemd/system/srv-wfe-${env}.mount"
        content = templatefile("${path.module}/files/srv-wfe.mount.tmpl", {
          env_name = env
          data_dir = cfg.data_dir
        })
        mode       = "0644"
        owner      = "root"
        group      = "root"
        sudo       = true
        stage      = "pre"
        on_change  = "sudo /bin/systemctl daemon-reload"
        on_destroy = "sudo /bin/systemctl disable --now srv-wfe-${env}.mount 2>/dev/null || true; sudo /usr/bin/rm -f /etc/systemd/system/srv-wfe-${env}.mount && sudo /bin/systemctl daemon-reload"
      }
    },
    # Per-tenant podman-auto-update.timer override. With user-mode Quadlets
    # each tenant runs its own podman-auto-update.timer in user systemd; the
    # default fires daily, we override to minutely.
    {
      for u in local.tenants : "podman_timer_override_${u}" => {
        path    = "/home/${u}/.config/systemd/user/podman-auto-update.timer.d/override.conf"
        content = file("${path.module}/files/podman_timer_override.conf")
        mode    = "0644"
        owner   = u
        group   = u
        sudo    = true
        stage   = "pre"
        # User-mode systemd reload + restart of the timer. Wrapped in
        # `runuser ... env XDG_RUNTIME_DIR=/run/user/<uid>` so user-mode
        # systemctl can reach the user's session bus.
        on_change  = "uid=$(id -u ${u}) && sudo /usr/sbin/runuser -u ${u} -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user daemon-reload && sudo /usr/sbin/runuser -u ${u} -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user restart podman-auto-update.timer 2>/dev/null || true"
        on_destroy = "uid=$(id -u ${u} 2>/dev/null) && sudo /usr/bin/rm -f /home/${u}/.config/systemd/user/podman-auto-update.timer.d/override.conf && [ -n \"$uid\" ] && sudo /usr/sbin/runuser -u ${u} -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user daemon-reload 2>/dev/null || true"
      }
    },
  )

  # Imperative one-shots. Swapfile, system-mode service enables, and per-tenant
  # user-mode podman-auto-update.timer enables (the units' timer-override files
  # come via managed_files; the enable is one-shot).
  managed_exec = merge(
    {
      # Create-only: allocate + mkswap the swapfile. Activation is owned by the
      # swapfile.swap systemd unit (managed_files, stage post) — systemd does the
      # swapon, so no /etc/fstab line and no `swapon`/`swapoff` in the convergence
      # (the latter isn't even in the sudoers allowlist). change_key flips from
      # the pre-unit "1G" so this re-runs once to drop the legacy fstab line
      # (which would otherwise make the fstab-generator synthesize a competing
      # swapfile.swap unit). Teardown is rm-only; the .swap unit's `disable --now`
      # deactivates swap first.
      swapfile = {
        change_key = "1G-unit"
        on_create  = <<-EOT
          set -euo pipefail
          if [ ! -f /swapfile ]; then
            sudo /usr/bin/fallocate -l 1G /swapfile
            sudo /usr/bin/chmod 0600 /swapfile
            sudo /usr/sbin/mkswap /swapfile
          fi
          if grep -q '^/swapfile' /etc/fstab; then
            grep -v '^/swapfile' /etc/fstab | sudo /usr/bin/tee /etc/fstab >/dev/null
          fi
        EOT
        on_destroy = "sudo /usr/bin/rm -f /swapfile"
      }
      services_enable = {
        change_key = "v2"
        # No system-mode podman-auto-update.timer — each tenant runs its own
        # user-mode timer (see user_timers_<u> entries below).
        on_create  = "sudo /bin/systemctl enable --now fail2ban.service unattended-upgrades.service"
        on_destroy = ""
      }
      # Enable the per-env data mounts in the `exec` stage — AFTER the mount +
      # format unit files are written (pre) and BEFORE the app Quadlets restart
      # (post) with their `ExecStartPre=mountpoint -q` guard. `enable --now`
      # starts each mount, which pulls in wfe-data-format.service (Requires=) to
      # mkfs-if-empty, then mounts by label. Fails the apply loudly if a volume
      # can't be formatted/mounted (better than a silently-down Quadlet).
      #
      # A freshly `mkfs`'d volume's root (and lost+found) is owned root:root,
      # which the rootless tenant can't chown — so the container's `:U` mount
      # flag (which recursively chowns the source into the tenant's subuid range)
      # fails with EPERM. Hand the mount root to the tenant first; `:U` then maps
      # it. Guarded on root-ownership so a reattached volume (already subuid-owned
      # after a prior `:U`) is left untouched — no pointless recursive chown.
      enable_data_mounts = {
        # Content-addressed: re-runs whenever the script (logic or env set)
        # changes — no hand-bumped version string. Safe because the body is
        # idempotent (enable is a no-op if already enabled; the chown is guarded
        # on root-ownership).
        change_key = sha256(local.enable_data_mounts_script)
        on_create  = local.enable_data_mounts_script
        on_destroy = ""
      }
    },
    # Per-tenant user-mode podman-auto-update.timer enable. Idempotent.
    # `systemctl --user enable` has a lifecycle quirk on freshly-lingered
    # users where it fails to create the wants/ symlink (the unit's `--now`
    # start succeeds but the persistent enable errors out). We sidestep
    # by creating the wants/ symlink manually — this is exactly what
    # `enable` would do — and then `start` instead of `enable --now`.
    # On subsequent boots, user-mode systemd reads the wants/ dir and
    # auto-starts the timer.
    {
      for u in local.tenants : "user_timer_${u}" => {
        change_key = "v2"
        on_create  = <<-EOT
          set -euo pipefail
          uid=$(id -u ${u})
          sudo /usr/sbin/runuser -u ${u} -- /usr/bin/mkdir -p /home/${u}/.config/systemd/user/timers.target.wants
          sudo /usr/sbin/runuser -u ${u} -- /usr/bin/ln -sf /usr/lib/systemd/user/podman-auto-update.timer /home/${u}/.config/systemd/user/timers.target.wants/podman-auto-update.timer
          sudo /usr/sbin/runuser -u ${u} -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user daemon-reload
          sudo /usr/sbin/runuser -u ${u} -- env XDG_RUNTIME_DIR=/run/user/$uid /bin/systemctl --user start podman-auto-update.timer
        EOT
        on_destroy = ""
      }
    },
  )

  # App-side firewall rules. Cloud-init opened only the SSH port; these are
  # added on top.
  managed_ufw = {
    http  = { port = 80, proto = "tcp" }
    https = { port = 443, proto = "tcp" }
  }
}
