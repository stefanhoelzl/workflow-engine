## Context

Today the workflow-engine runs on a UpCloud Managed Kubernetes cluster with Caddy as a cluster-level ingress (raw `kubernetes_manifest` resources, built-in HTTP-01 ACME on a PVC), the app as a single-replica Deployment per env (`prod`, `staging`), and event-store + bundle persistence on UpCloud Object Storage via the `S3` `StorageBackend` implementation. Authentication is in-app (no `oauth2-proxy`, no forward-auth); Caddy is a pure TLS-terminating reverse proxy. Tofu state lives in UpCloud Object Storage; secrets transit GitHub Actions → `TF_VAR_*` → `kubernetes_secret`. Four tofu projects (`envs/{cluster,prod,staging,persistence}` plus a kind-based `envs/local`) are gated by a four-job pre-merge `tofu plan` matrix; deploys are CI-driven via `tofu apply -var image_digest=<sha>`.

The infrastructure was sized for HA, multi-replica, multi-namespace concerns that the application does not actually need:

- The app is structurally single-replica (`packages/runtime/src/auth/key.ts` seals session cookies with an in-memory password generated at process start; multi-replica would require a shared sealing mechanism).
- Per-env namespace isolation via PSA + NetworkPolicy is operationally meaningful but is being paid for with a full K8s control plane + LB + Object Storage.
- Cross-cluster type-checking via `terraform_remote_state` motivated the four-project layout but exists only because the layout is four projects.

Constraints driving the new shape:

- **Cost** is the headline motivation; UpCloud K8s + LB + Object Storage adds up for a personal-scale deploy.
- **OpenTofu must remain the IaC tool** (per user choice).
- **Local-disk persistence replaces S3** (per user choice — also simpler).
- **No backups in this change** (deferred); **no rollback strategy** (cutover is one-way, fix-forward).
- **Throwaway data** at cutover (no event-store migration; users re-upload bundles via `wfe upload`).

The design below was fully resolved in an interview-driven session before this proposal was authored. Each subsection of "Decisions" records both the choice and the alternatives considered.

## Goals / Non-Goals

**Goals:**

- Replace the K8s + Caddy-manifest + S3 stack with a single Scaleway STARDUST1-S running Podman + Quadlet + Caddy + local-disk persistence.
- Collapse the four-project tofu layout to a single flat `infrastructure/` project with one state on Scaleway Object Storage.
- Decouple release from infrastructure: image-tag-based auto-update (`podman-auto-update.timer`), no tofu in the per-deploy path, no SSH from the deploy job.
- Preserve the existing `main`→staging / `release`→prod branching model and the prod approval gate (`environment: production`).
- Preserve every application-level invariant verbatim: in-app auth, single-replica session sealing, no `X-Auth-Request-*` reads, CSP/HSTS posture, `<owner>`/`<repo>` enumeration defense, sandbox boundary contracts.
- Keep secret bytes out of tofu state by using the `file` provisioner with a `source =` path (only the file's md5 hash and the path string land in state).
- Replace the `pod-security-baseline` capability with a `host-security-baseline` capability that documents the rootless-Podman + firewall + scoped-sudo + sshd-hardening + fail2ban + sysctl posture.
- Drop the kind-based local cluster entirely; `pnpm dev` is the sole local mode.

**Non-Goals:**

1. **Migrating event-store data** from UpCloud Object Storage to local disk. Throwaway; users re-upload bundles.
2. **Backups** of the new local-disk persistence. Deferred to a follow-up change. Top-of-list accepted risk in steady state.
3. **Application or runtime behavior changes.** Infra-only. App image is unchanged.
4. **Auth contract changes.** Only the rationale text in `auth/spec.md` is edited; the contract surface is identical.
5. **Sandbox / SDK / workflow-author surface changes.** None. `workflows/src/demo.ts` requires no edits.
6. **Multi-replica or HA.** Single VPS, single region, single Quadlet unit per env. Migrating the session-sealing key to a shared mechanism is explicitly *not* part of this change.
7. **Monitoring / alerting / SLO instrumentation.** Operators rely on `journalctl` and `/readyz`. The K8s stack had none either.
8. **Local-dev rewrite beyond removing kind.** No new podman-on-laptop story replacing kind.
9. **Pre-merge plan-gate complexity beyond what's structurally required.** One project, one job, `changes-allowed: false`.
10. **Preserving K8s isolation primitives as such.** PSA + NetworkPolicy do not exist on the new shape; their *intent* (workload isolation, default-deny) is preserved by host firewall + bind-locality + rootless Podman.

## Decisions

### D1. Runtime: Podman + Quadlet (rejected: kreuzwerker/docker, docker-compose, single-node Nomad, k3s, bare Node)

**Choice:** All workloads (Caddy, `wfe-prod`, `wfe-staging`) run as rootless Podman containers driven by systemd Quadlet `.container` files in `/etc/containers/systemd/`. Quadlet is Podman's upstream-recommended systemd integration since 4.4.

**Why:**
- Preserves the K8s "Pod = systemd unit" mental model with no extra control plane.
- Re-uses the existing `ghcr.io/.../workflow-engine` image unchanged.
- Rootless containers + per-unit `MemoryMax`/`CPUQuota` + scoped sudo give a meaningful defense-in-depth replacement for the PSA/NetworkPolicy stack.
- Logs go to journald (`journalctl -u wfe-prod`); restart policy via `Restart=always`; rendering Quadlet from tofu is a plain templated file write.

**Rejected alternatives:**
- *kreuzwerker/docker provider over SSH:* Tofu becomes the container-lifecycle owner with automatic drift detection — but `tofu plan` would require an SSH key to prod on every PR (regression vs the current credential-free pre-merge gate). Also requires Docker (rootful by default), losing the rootless story.
- *docker-compose:* Adds compose as a layer purely to wire three containers; the compose file becomes a second source of truth alongside tofu.
- *single-node Nomad:* Overkill for three services.
- *k3s:* Defeats most of the simplification goal.
- *bare Node + host Caddy:* Loses the image-digest deploy idiom; forces a Node toolchain on the VPS.

### D2. Deploy seam: tag-based `podman-auto-update.timer` (rejected: tofu pins digest, hybrid)

**Choice:** Quadlet units carry `Label=io.containers.autoupdate=registry`. The image reference is `ghcr.io/.../workflow-engine:release` (prod) and `:main` (staging) — no digest pinning. `podman-auto-update.timer` is overridden to fire **every 1 minute**: it queries the registry HEAD, compares the manifest digest to the running container, and `systemctl restart`s the unit on diff.

The deploy GHA workflows (`deploy-prod`, `deploy-staging`) do nothing more than `docker build && docker push`. **No tofu in the deploy path. No SSH in the deploy path.**

Rollback is `git revert <bad-sha>` on the affected branch → CI re-pushes the prior code under the same tag → next timer tick picks it up (≤ 1 min).

**Why:**
- Achieves the user-stated goal of "release and infrastructure are separate." Tofu apply runs only on infra-shape changes.
- Eliminates the `image_digest` tofu variable, the per-deploy state mutation, and three of four pre-merge plan-gate jobs.
- Simpler GHA secrets footprint (deploy jobs need only `GITHUB_TOKEN` to push).
- ghcr.io packages are public — no PAT needs to live on the VPS for `podman auto-update`.

**Rejected alternatives:**
- *Tofu pins digest (`tofu apply -var image_digest=<sha>`):* Mirrors today exactly. Coupled release to infra; kept the pre-merge plan gate matrix non-trivial. Rejected by user after considering the explicit decoupling benefit of auto-update.
- *Hybrid (auto-update + GHA SSH-kick to skip the timer wait):* Considered for faster deploys; rejected by user — the 1-minute timer is fast enough and SSH stays out of CI entirely.
- *Manual "deploy now" `workflow_dispatch`:* Considered; rejected. No escape hatch is needed at a 1-minute interval.

**Trade-off accepted:** The `:release`/`:main` tags are mutable. "What was running 2 weeks ago" is approximate (git history of the branch + ghcr.io's tag history if not force-pushed). Mitigated by treating `release` as a protected, never-force-pushed branch (already the case) and by `journalctl -u wfe-prod | grep "Trying to pull"` recording the digest at each rotation.

### D3. Deploy liveness signal: `/readyz` `version.gitSha` (rejected: registry HEAD comparison, fixed sleep)

**Choice:** `deploy-staging` polls `https://staging.workflow-engine.webredirect.org/readyz` until `version.gitSha === ${{ github.sha }}` before running `wfe upload`. The app already exposes `version.gitSha` from `APP_GIT_SHA` env (`packages/runtime/src/health.ts`). The Dockerfile is updated to take a `BUILD_SHA` ARG and bake it into `APP_GIT_SHA` so the env var lives inside the image, with no runtime plumbing required.

**Why:**
- Already-existing endpoint surface; no new app code required.
- `github.sha` is a known-at-build-time value the GHA can poll against.
- Robust against ordering: the upload step waits for the new image to actually be serving, regardless of how long the auto-update timer takes.

**Rejected alternatives:**
- *Registry HEAD comparison from GHA:* Doesn't tell you whether the new image is *running* on the box, only whether it's been pushed. Useless as a liveness signal.
- *Fixed sleep before upload:* Brittle. "It's probably running by now" energy.

### D4. Tofu layout: single flat `infrastructure/` project (rejected: per-env subdirs, workspaces)

**Choice:** One project at `infrastructure/`, no `envs/<name>/` subdirs. Files: `main.tf`, `caddy.tf`, `apps.tf`, `variables.tf`, `outputs.tf`, `terraform.tfvars`, `cloud-init.yaml`, `files/` (Quadlet templates, Caddyfile template). Run as `tofu -chdir=infrastructure {init|plan|apply}`. Single state on Scaleway Object Storage.

**Why:**
- Today's four-project layout was driven by HA-shaped concerns (separate persistence lifecycle, separate per-env namespaces with their own secrets, cross-project type checking). None apply to a single VPS hosting prod + staging.
- One state, one apply, one plan-gate job. Massive simplification of CI.
- The deploy seam (D2) means tofu doesn't run per release, so there's no per-env apply contention to engineer around.

**Rejected alternatives:**
- *Tofu workspaces (one project dir, state per env):* Would have been needed if D2 were "tofu pins digest" (to scope per-env applies). Not needed here.
- *Per-env subdirs:* Most boilerplate; copies the K8s-era pattern with no underlying need.

### D5. Tofu state backend: Scaleway Object Storage (rejected: keep UpCloud OS, local state)

**Choice:** Tofu state moves to Scaleway Object Storage (S3-compatible API, configured via the `s3` backend block with custom `endpoint`). The existing `state_passphrase` client-side encryption mechanism is retained.

**Why:**
- One-vendor administration post-cutover (UpCloud account is retired entirely).
- State backend choice is independent of workload location; moving it is a one-time migration.

**Rejected alternatives:**
- *Keep state in UpCloud Object Storage:* Would block the "retire UpCloud" simplification. The marginal one-time cost of moving the state is small.
- *Local state file in the repo:* Loses concurrency safety; fragile under CI applies; rejected.

### D6. Secrets delivery: tofu `file` provisioner with `source =` (rejected: `local_sensitive_file`, `remote-exec` echo, separate bootstrap workflow, ephemeral resources)

**Choice:** GHA renders each env file to a tmp path on the runner before `tofu apply`:

```yaml
- run: |
    install -d -m 700 /tmp/wfe-secrets
    cat > /tmp/wfe-secrets/prod.env <<EOF
    GITHUB_OAUTH_CLIENT_ID=${{ secrets.GH_OAUTH_CLIENT_ID_PROD }}
    GITHUB_OAUTH_CLIENT_SECRET=${{ secrets.GH_OAUTH_CLIENT_SECRET_PROD }}
    AUTH_ALLOW=${{ vars.AUTH_ALLOW_PROD }}
    EOF
- run: tofu -chdir=infrastructure apply -auto-approve
- if: always()
  run: rm -rf /tmp/wfe-secrets
```

A `null_resource` with `triggers = { content_hash = filemd5("/tmp/wfe-secrets/prod.env") }` invokes a `file` provisioner with `source = "/tmp/wfe-secrets/prod.env"` to copy to `/etc/wfe/prod.env`, then a `remote-exec` provisioner runs `chmod 600` and `sudo systemctl restart wfe-prod`.

**Why:**
- The `file` provisioner with `source =` (not `content =`) reads the file at apply time and streams it over SSH; the bytes never enter state. Only the path string and the md5 hash are persisted.
- Single workflow (`apply-infra`) handles infra + secrets; no separate bootstrap workflow to remember to run.
- `filemd5` provides proper change detection — edit a GH secret, hash differs, tofu re-runs the provisioner and restarts the unit.

**Rejected alternatives:**
- *`local_sensitive_file` / `file` provisioner with `content =`:* Content attribute is stored in state.
- *`remote-exec` with `inline = ["echo '${secret}' > file"]`:* The `inline` list is a resource attribute, stored verbatim in state.
- *Separate `bootstrap-secrets` workflow:* User explicitly vetoed; adds a workflow to remember.
- *Ephemeral resources / write-only attributes (OpenTofu 1.11+):* Don't compose with provisioners (the consumer attribute would also need to be ephemeral; the `file` provisioner's are not).

### D7. SSH posture (rejected: SSH on port 22, password auth, root SSH, IP allowlist, Tailscale)

**Choice:**
- Dedicated `deploy` user; root login over SSH disabled (`PermitRootLogin no`).
- Key authentication only (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`).
- `AllowUsers deploy` — only the deploy user accepted.
- Non-standard SSH port (e.g. 2222) — eliminates drive-by botnet noise; not a security boundary.
- `MaxAuthTries 3`, `LoginGraceTime 20s`.
- `fail2ban` enabled with sshd jail (5 failed auths → 1 hour ban).
- Host firewall: default deny, allow only `80/tcp`, `443/tcp`, `<ssh-port>/tcp`.
- NOPASSWD sudo for `deploy` scoped via `/etc/sudoers.d/deploy` to: `systemctl daemon-reload`, `systemctl {start,stop,restart,status} wfe-prod wfe-staging caddy podman-auto-update.service`. Anything broader requires `sudo -i` and root password (set, stored in operator's password manager, used only in genuine emergencies).
- Unattended security upgrades enabled.

**Why:**
- Port 22 → 2222 isn't a security boundary but kills 99% of botnet log noise.
- Key-only + non-root + AllowUsers is the standard hardened sshd posture.
- fail2ban handles the residual brute-force exposure after the IP makes it to the SSH port.

**Rejected alternatives:**
- *Restrict SSH to GitHub Actions IP ranges:* GHA IP blocks rotate; the freshness-vs-firewall maintenance trade is bad at this scale.
- *Tailscale/WireGuard mesh, no public SSH:* Strongest posture but adds a mesh agent on the VPS and on GHA runners — operationally heavy for the value at this scale.

### D8. Caddy mode: all rootless with `net.ipv4.ip_unprivileged_port_start=80` (rejected: rootful Caddy, all rootful)

**Choice:** A host sysctl lowers the unprivileged port floor to 80 so the rootless Podman socket activation can bind 80/443 without elevation. All three Quadlet units (caddy, wfe-prod, wfe-staging) run as the `deploy` user under rootless Podman with their own subuid range.

**Why:**
- Most uniform: every container runs the same way.
- Preserves the rootless isolation story for Caddy, not just the apps.

**Rejected alternatives:**
- *Rootful Caddy + rootless apps:* Standard Podman pattern but creates two delivery shapes for one box.
- *All rootful:* Loses the per-unit subuid isolation; weaker default.

### D9. Operating system: Debian 12 (rejected: Ubuntu, Fedora CoreOS)

**Choice:** Debian 12 (Bookworm) — Podman 4.3+ in default repos, Quadlet supported, long support window (LTS until 2028), maintained Scaleway image with cloud-init integration, no snapd or telemetry surface, `unattended-upgrades` works out of the box.

**Rejected alternatives:**
- *Ubuntu:* Functional but adds snapd, `ubuntu-advantage`, telemetry — more surface for no benefit at this scale.
- *Fedora CoreOS:* Quadlet's native home and immutable — but more opinionated, harder to debug ad-hoc, and the Scaleway cloud-init story is rougher.

### D10. Cutover: one-way, no rollback (rejected: 7-day warm K8s, rollback CNAME flip, dual-write)

**Choice:** Single PR includes both "stand up VPS" and "delete K8s envs/modules/workflows". Merge = cutover. Validation gates (see "Migration Plan") are *deploy success criteria*, not *rollback triggers*. If cutover fails, fix forward.

**Why:**
- Per user choice. Throwaway data + single CNAME flip + the K8s code lives at the previous git SHA mean elaborate rollback machinery would buy little.
- Repo never carries dead K8s code alongside live VPS code; no transitional state.
- Simplest possible scope.

**Rejected alternatives:**
- *Keep K8s warm 7 days; deletion in follow-up PR:* Earlier proposed; vetoed by user. Adds operational overhead and bisects the migration story.
- *Dual-write / canary:* No data path supports it (events are written to one storage backend per process); no traffic management above DNS.

### D11. Local dev: `pnpm dev` only (rejected: keep kind, podman-on-laptop)

**Choice:** Delete `infrastructure/envs/local/` and `pnpm local:up*`. `pnpm dev` is the only local mode. The CLAUDE.md "Cluster smoke (human)" tasks.md pattern goes away — there is no cluster.

**Why:**
- CLAUDE.md already states agents verify against `pnpm dev`; the kind path was used only for K8s-specific concerns that no longer exist.
- Simpler agent workflow; no cluster boot in the inner loop.

**Rejected alternatives:**
- *Keep kind:* No corresponding production K8s to mirror.
- *Podman-on-laptop stack mirroring prod:* Earlier offered; rejected. `pnpm dev` is sufficient.

## Risks / Trade-offs

**Risks accepted (top-of-list, by user choice):**

- **No backups → Mitigation: documented as the top steady-state risk; follow-up change to add restic snapshots to a small bucket is the planned next step but is not in scope here. A VPS-loss event causes total data loss for both envs until a manual `wfe upload` round.**
- **No rollback → Mitigation: rigorous pre-merge validation in non-prod (manual `tofu apply` against a personal Scaleway account / a throwaway VPS); cutover validation gates as deploy success criteria; fix-forward as the only failure mode. The `apply-infra` workflow supports partial re-runs (Quadlet edit → restart without re-provisioning), so most failure modes are recoverable in place.**

**Other risks:**

- **Single VPS, single region, no HA → Mitigation: matches the cost-optimised motivation; explicitly a non-goal. A hardware fault causes downtime until manual recovery (re-provision + re-upload bundles).**
- **STARDUST1-S memory headroom is genuinely tight (1 GB physical RAM across Caddy + 2 app instances + sandbox workers + page cache + system daemons) → Mitigation: per-Quadlet `MemoryMax=` ceilings (350M per app, 80M for Caddy); 1 GiB swapfile provisioned by cloud-init absorbs transient bursts; OOM events surface as `journalctl | grep -i oom`. Mitigation if recurrent: bump `var.instance_type` to `PLAY2-MICRO` (2 GB) — one-line change + re-apply (instance is recreated, brief downtime).**
- **Mutable `:release`/`:main` tags lose strict point-in-time reproducibility → Mitigation: `release` branch protection (no force-push, no delete) keeps git history authoritative; `journalctl -u wfe-prod | grep "Trying to pull"` records the digest at each rotation as belt-and-suspenders.**
- **Auto-update timer at 1 min × 2 envs = ~2880 ghcr.io HEAD requests/day per IP → Mitigation: ghcr packages are public; HEAD requests aren't subject to the same rate limits as authenticated pulls. If `429`s ever appear, the timer simply retries on the next tick; no deploy is lost, just delayed.**
- **Host kernel is the only isolation boundary between prod and staging (no namespace separation) → Mitigation: rootless Podman with separate subuid ranges per unit; per-unit `MemoryMax`/`CPUQuota`; `unattended-upgrades` keeps kernel CVEs patched; both apps bind only to `127.0.0.1`.**
- **`deploy` user's SSH key is a high-value GH Actions secret → Mitigation: rotate on a schedule (e.g. 90 days); GH OIDC → short-lived SSH cert is a v2 follow-up if the threat model evolves.**
- **Loss of admission-time policy enforcement (no PSA gate on Quadlet content) → Mitigation: `tofu apply` is operator-driven (`apply-infra` is `workflow_dispatch`-only); a bad Quadlet committed to the repo cannot ship without a human running apply.**
- **Secret bytes streamed over SSH at apply time → Mitigation: SSH session is encrypted; the `deploy` private key is GHA-secret-managed; `/etc/wfe/<env>.env` is mode 0600 owned by `deploy`. State holds only the file's md5 hash.**

## Migration Plan

This is a one-way cutover. There is no rollback strategy; the validation gates below are deploy success criteria, not rollback triggers.

### Pre-merge (operator, manual)

1. Provision a personal/throwaway Scaleway VPS using the proposed `infrastructure/` from a feature branch. Walk the full bootstrap end-to-end: `tofu apply` → cloud-init completes → Quadlet units come up → Caddy obtains LE certs (against a temporary subdomain) → `/readyz` returns valid `version.gitSha`.
2. Confirm `wfe upload` works against the throwaway box.
3. Tear down the throwaway box.

### Cutover (single PR merge to `main`)

The PR contains: new `infrastructure/`; deletion of all old `infrastructure/envs/*` + `infrastructure/modules/*`; rewritten GHA workflows; spec deltas; `docs/infrastructure.md` rewrite; `CLAUDE.md` and `SECURITY.md` updates.

1. Operator runs the new `apply-infra` workflow (`workflow_dispatch`) → tofu provisions the production Scaleway VPS, writes Quadlet units, copies env files via the `file` provisioner, runs `systemctl daemon-reload && systemctl start ...`.
2. Caddy obtains Let's Encrypt certs for `workflow-engine.webredirect.org` and `staging.workflow-engine.webredirect.org` once Dynu CNAMEs propagate to the VPS IP.
3. **DNS flip (manual step before merge or first-thing post-merge):** Operator updates Dynu CNAME targets from the UpCloud LB hostname to the VPS IP. Tofu owns the Dynu CNAMEs in the new world; the apply step does this automatically once the VPS is up.

### Cutover validation gates (deploy success criteria)

All of the following SHALL pass for cutover to be declared successful:

1. `curl -I https://workflow-engine.webredirect.org` returns `200` with a publicly-trusted Let's Encrypt cert. Same for `staging.workflow-engine.webredirect.org`.
2. `GET /readyz` on both URLs returns `200` with `version.gitSha === <expected SHA>`.
3. Login flow works end-to-end via GitHub OAuth on both envs (manual click-through).
4. `wfe upload` succeeds against staging (auto-exercised by the next push to `main`; can be exercised manually pre-merge).
5. A canonical `demo.ts` trigger fires and produces an event visible in the dashboard.
6. `dig` from at least one external resolver shows the new IP for both hostnames (Dynu propagation stable).

### Post-cutover (operator, manual)

1. Tear down the UpCloud K8s cluster, the per-env namespaces, the Object Storage buckets, and the Dynu CNAMEs that pointed at the old LB. (The DNS records are managed by the new tofu state; the K8s/OS resources need explicit `tofu destroy` against the *old* code, executed from the previous git SHA.)
2. Retire the UpCloud account / API token.
3. Set repo secrets in GitHub Actions: `SCW_*` credentials for tofu, `DEPLOY_SSH_PRIVATE_KEY`, refreshed `GH_OAUTH_*_{PROD,STAGING}` (if the OAuth callback URL changes — it should not, since the hostnames are unchanged).

### Rollback

Not provided. If cutover fails, fix forward:

- For pre-validation failures (Caddy can't ACME, Quadlet won't start, env file malformed): re-run `apply-infra` after fixing the underlying cause; tofu's idempotency + Quadlet's restart semantics let the operator iterate without re-provisioning the VM.
- For post-validation failures discovered later (e.g. a workflow trigger doesn't fire correctly): a follow-up PR + `apply-infra` rerun, or — for app-level bugs — a normal `git revert` + auto-update tick.
