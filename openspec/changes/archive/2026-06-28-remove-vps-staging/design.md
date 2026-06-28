## Context

The VPS was originally the sole host for both prod and staging (two app Quadlets, two tenant users, two data volumes, a two-site Caddyfile). The `staging-bunny-magic-containers` spike then moved staging's *live* frontend to bunny.net Magic Containers — the `staging.workflow-engine.stho.net` CNAME points at Bunny's CDN host and `deploy-staging.yml` rolls Bunny forward on every push to `main`. The VPS staging stack was deliberately **kept running, unedited, as a warm fallback** (still auto-pulling `:main`), with a documented "switch back to the VPS" revert path.

That fallback is now dead weight: it consumes a block volume, a tenant user + subuid range, ~350 MB of the 1 GB RAM, and forces a VPS stop/start whenever its volume attachment changes — for a path we don't intend to use. This change retires it, collapsing the VPS to a single-tenant (prod) host while staging continues to live entirely on Bunny.

The non-trivial wrinkle: `local.envs["staging"]` is read by **both** the VPS resources being removed **and** survivors — `bunny-staging.tf` (`local.bunny_staging`, `random_bytes.secrets_key["staging"]`) and the `staging_cname` DNS record (which must keep pointing at Bunny). So staging config can't simply be deleted; it has to be relocated to its sole remaining consumer.

## Goals / Non-Goals

**Goals:**
- Remove every VPS-side staging resource: `wfe-staging` Quadlet + `/etc/wfe/staging.env`, the `wfe-staging` tenant user (+ subuid range), `/srv/wfe/staging` dir + `srv-wfe-staging.mount`, `scaleway_block_volume.staging` (+ its `additional_volume_ids` entry), and the Caddy `staging.*` site block.
- Keep staging fully live on Bunny throughout — the `staging_cname` CNAME value is unchanged.
- Keep `local.envs` semantically honest: it enumerates VPS-hosted app envs, now just `prod`.
- Bring docs/comments/specs in line: Bunny is the sole staging backend, no warm-fallback narrative, no revert path.

**Non-Goals:**
- Touching prod's deployment shape (image, volume, OAuth, retention) beyond the unavoidable stop/start.
- Changing any CI workflow — `deploy-staging.yml` already targets Bunny only; `plan-infra.yml` already passes the staging OAuth vars that Bunny consumes.
- Modifying the `bunny-staging` capability spec — the sealing-key source is an implementation detail, not a named requirement, and "staging runs only on Bunny" is expressed as the *absence* of VPS staging resources in the `infrastructure` deltas.
- Adding off-box backups, a `staging_backend` toggle, or any new abstraction.

## Decisions

### D1 — Relocate staging config to `bunny-staging.tf`; `local.envs` becomes prod-only

`local.envs` is iterated by `apps.tf`, `caddy.tf`, `host.tf`, and `outputs.tf` to drive VPS resources. Dropping the `staging` key there makes all of those auto-shed staging in one stroke. The config Bunny still needs (domain, dns_node, auth_allow, retention_days, OAuth var refs) moves into a `local` in `bunny-staging.tf`, which is already the consumer (`local.bunny_staging`). `dns.tf`'s `staging_cname` and `outputs.urls` source the staging hostname from that relocated local.

**Alternative considered:** keep both keys in `local.envs` and introduce `local.vps_envs = {prod}` for the VPS resources to iterate. Rejected — it preserves a "VPS env" that isn't on the VPS, the exact confusion this change exists to remove. `local.envs` should mean "envs the VPS hosts."

`local.envs` stays a **map keyed by env name** (with the single `prod` entry) rather than collapsing to a scalar, so the generic per-env iteration machinery survives and re-adding a VPS env later is a one-key edit.

### D2 — Let the staging sealing key regenerate (no `moved` block)

`random_bytes.secrets_key` is `for_each = local.envs`; removing `staging` from the map destroys the `["staging"]` instance. Rather than preserve it with a `moved` block, declare a **fresh standalone** `random_bytes` resource in `bunny-staging.tf` for the Bunny app's `SECRETS_PRIVATE_KEYS`. The old key is destroyed; a new value is generated and pushed to the Bunny env (a one-time container update). The unseal gap for already-uploaded bundles is closed by the next push-to-`main`, which re-uploads them via `wfe upload`.

**Alternative considered:** a `moved {}` block to retain the exact key bytes. Rejected by the operator — the regeneration cost is a brief, self-healing unseal gap on a low-stakes env, and a standalone resource reads more clearly than a `moved` from a now-deleted map key.

### D3 — Single apply, operator-applied before merge

The change produces a destroy-heavy, **non-empty plan**, and the `plan (vps)` gate fails on non-empty plans. Per `docs/infrastructure.md`, the operator runs `apply-infra` from the feature branch **before** requesting merge, so the PR's plan gate sees an empty plan. No DNS two-step targeted apply is needed (unlike the domain migration) because the `staging_cname` value is unchanged — only its HCL source moves, which is not a plan diff.

### D4 — Leave the freed subuid range as a gap

`wfe-staging` held `165536-231071`; `wfe-caddy` sits at `231072+`. Deleting only the `wfe-staging` managed-user entry leaves a gap. Renumbering `wfe-caddy` down into the freed range would invalidate `/srv/caddy`'s on-disk subuid-mapped ownership and risk the running Caddy container. The gap is harmless and the explicit ranges remain non-overlapping.

### D5 — Retarget the `infrastructure` tenant-removal scenario to `wfe-experimental`

The `Managed user accounts` requirement's "Removing a tenant cleans up host state" scenario uses `wfe-staging` as its worked example. This change *executes* that scenario, but the tenant-removal *capability* persists. Re-target the example to a hypothetical `wfe-experimental` so the spec doesn't cite a tenant that no longer exists. Done as a normal scenario edit inside the MODIFIED requirement (the `Quadlet units…` requirement is the only one needing a RENAMED, for its title).

## Risks / Trade-offs

- **[Prod downtime during the apply]** Removing `scaleway_block_volume.staging` from `additional_volume_ids` is an in-place server stop/start → prod is briefly down. → Mitigation: operator-driven `apply-infra`, timed for low traffic; verify prod `/readyz` recovers post-apply.

- **[Detach-before-delete ordering — OBSERVED FAILURE, requires a two-step apply]** A single `tofu apply` does **not** reliably detach the staging volume before deleting it. Because the new config no longer references `scaleway_block_volume.staging` from the instance's `additional_volume_ids`, OpenTofu drops the dependency edge that would order the instance update (detach) before the volume destroy. On the first apply the provider attempted `scaleway_block_volume.staging` delete while still attached → `waiting for Volume failed: timeout after 5m0s` → apply errored. → **Mitigation (load-bearing): apply in two steps.** First `tofu apply -target=scaleway_instance_server.vps` (updates `additional_volume_ids` → detaches; observed as a ~2 s *live* hot-detach, not the expected stop/start, so prod downtime was effectively nil). Then a full `tofu apply` deletes the now-detached volume and recreates the host-convergence files. See tasks.md §6.

- **[`userdel` fails closed but `on_failure=continue` drops the user from state]** The `managed_user["wfe-staging"]` destroy ran `loginctl disable-linger` then `userdel --remove`, which failed (`user wfe-staging is currently used by process 988` — its rootless container/`systemd --user` was still alive). `on_failure = continue` let tofu mark the resource destroyed and remove it from state anyway, leaving an **orphaned OS account + running process outside tofu's view**. Because Step 1 was a live hot-detach (no reboot), the process was not reaped automatically. → Mitigation: a manual post-apply cleanup (`disable-linger` → stop `user@<uid>.service` → `pkill -u` → `userdel --remove`) is required; the empty-plan gate is unaffected (the orphan is out of state). Captured as an explicit task.

- **[Mount/boot safety]** `nofail` on the mount units means a missing/detached volume never wedges boot. The cluster-smoke step verifies `findmnt /srv/wfe/prod`, that `wfe-staging.service`/`srv-wfe-staging.mount` are gone, and that the staging volume is deleted.

- **[Staging data loss]** `scaleway_block_volume.staging` has no `prevent_destroy`; the apply deletes it. → Accepted per existing design: staging is disposable and Bunny re-receives demo bundles on every deploy.

- **[Sealing-key regeneration unseal gap]** Already-uploaded staging bundles can't unseal secrets until the next deploy re-uploads them. → Accepted (D2); self-heals on the next push to `main`.

- **[Stale `Dynu` reference]** The `infrastructure` §"Single flat tofu project" requirement still says "Dynu CNAMEs" (stale since the Bunny DNS migration). → Fixed opportunistically in the same MODIFIED requirement (`Bunny DNS records`), since the sentence is already being rewritten for the one-Quadlet change.
