## Why

The current UpCloud K8s + Caddy + S3 stack costs more and carries more operational surface than the workload (one app, single-replica by design) justifies. Replacing it with a single Scaleway VPS running Podman + Quadlet drops monthly cost dramatically, removes the K8s control plane / NetworkPolicy / PSA / cluster-Caddy / S3 layers from the operational footprint, and turns the in-app `replicas = 1` policy into a structural invariant. Local-disk persistence replaces S3, eliminating cross-cloud credentials in the runtime.

## What Changes

- **BREAKING (operational):** Production and staging move from a UpCloud K8s cluster to a single Scaleway STARDUST1-S running Podman + Quadlet. The K8s cluster, the cluster-level Caddy ingress, and the UpCloud Object Storage persistence buckets are decommissioned.
- **BREAKING (data):** The existing event store on UpCloud Object Storage is **not migrated**. Users re-upload workflow bundles via `wfe upload` after cutover. There is **no rollback strategy**; cutover is one-way.
- The OpenTofu layout collapses from four projects (`envs/{cluster,prod,staging,persistence,local}`) to a single flat `infrastructure/` project. Tofu state moves from UpCloud Object Storage to Scaleway Object Storage.
- The deploy seam changes from "tofu apply pins a digest" to **tag-based auto-update**: `:release` for prod, `:main` for staging, polled by `podman-auto-update.timer` every 1 minute. Tofu is no longer in the per-deploy path.
- Deploy GHA workflows (`deploy-prod`, `deploy-staging`, `plan-infra`) are rewritten. New `apply-infra` workflow is operator-driven (`workflow_dispatch`) for infra changes; staging poll-and-upload of demo workflows uses `/readyz` `version.gitSha` to detect the new image is live.
- Caddy runs as a rootless Quadlet container alongside two app Quadlet units (`wfe-prod`, `wfe-staging`). Apps bind to `127.0.0.1`; Caddy terminates TLS via built-in ACME on a host volume at `/srv/caddy/data`.
- Secrets transit GitHub Actions → tofu `file` provisioner with `source = <local-path>` → `/etc/wfe/<env>.env` (mode 0600). State stores only the file's md5 hash, never the secret bytes.
- The kind-based local cluster (`infrastructure/envs/local/`, `pnpm local:up*`) is deleted. `pnpm dev` is the sole local mode.
- The pre-merge plan gate collapses from four jobs to one (`plan (vps)`, `changes-allowed: false`).

## Capabilities

### New Capabilities

- `host-security-baseline`: Single source of truth for the workload-isolation and host-hardening posture on the VPS. Covers rootless Podman + subuid mapping, host firewall default-deny, scoped NOPASSWD sudo for the `deploy` user, sshd hardening (key-only, non-standard port, root login disabled, `AllowUsers deploy`), `fail2ban`, secret-file modes, sysctl tuning (including `net.ipv4.ip_unprivileged_port_start=80`), per-Quadlet `MemoryMax`/`CPUQuota`, and unattended security upgrades. Replaces the K8s-shaped `pod-security-baseline` capability.

### Modified Capabilities

- `infrastructure`: Full content rewrite. Capability identity ("production deployment shape") is unchanged; the implementation goes from UpCloud K8s + manifest Caddy + S3 to Scaleway VPS + Podman + Quadlet (Caddy + two app units) + local-disk persistence + Dynu DNS + Scaleway Object Storage state backend. Caddy/ingress requirements (previously in `reverse-proxy`) are absorbed here. Single tofu project at `infrastructure/`, no subdirs.
- `ci-workflow`: Full content rewrite. Three K8s-shaped workflows (`deploy-prod`, `deploy-staging`, `plan-infra`) are replaced by `apply-infra` (operator-driven, runs tofu), `deploy-staging` (push to `main`: build + push `:main`, poll `/readyz` for `version.gitSha` match, run `wfe upload`), `deploy-prod` (push to `release`: `environment: production` approval gate, then build + push `:release`). Pre-merge plan gate collapses to one job.
- `auth`: Rationale-text-only change. The single-replica invariant in `auth/spec.md` is reframed from "K8s Deployment locked to `replicas = 1`" to "structurally enforced by one Quadlet unit per env". The contract surface (in-app `apiAuthMiddleware` / `sessionMiddleware`, Caddy as pure TLS+routing, never read `X-Auth-Request-*`) is unchanged.
- `health-endpoints`: `/readyz`'s `version.gitSha` field becomes load-bearing (the `deploy-staging` workflow polls it to detect the new image is live before running `wfe upload`). The endpoint's shape is unchanged; only the contract that `gitSha` MUST be present and SHALL reflect the running image's build SHA is tightened from informational to required.

### Removed Capabilities

- `pod-security-baseline`: Replaced by `host-security-baseline`. K8s primitives (PSA labels, default-deny `NetworkPolicy`, shared `security_context` outputs) do not exist on a single VPS; their *intent* (workload isolation, default-deny posture) is preserved by the host firewall + bind-locality (apps on `127.0.0.1`) + rootless Podman + scoped sudo + fail2ban, captured in the new spec.
- `reverse-proxy`: Folded into `infrastructure`. The K8s-specific surface (Service, LoadBalancer, ACME PVC, ConfigMap-mounted Caddyfile, cluster-level site templating) does not exist on the new shape. Caddy becomes one of three Quadlet units on the VPS with a tofu-rendered Caddyfile and an ACME state host volume — small enough to live as a section of `infrastructure/spec.md` with no enduring cross-capability contract to anchor a separate spec.

## Impact

- **Code (deleted):** `infrastructure/envs/{cluster,prod,staging,persistence,local}/`; `infrastructure/modules/{kubernetes,object-storage,app-instance,baseline,caddy}/`; `scripts/prune-legacy-storage.ts` and any other K8s-era one-shot scripts; `pnpm local:up*` script entries.
- **Code (added/rewritten):** Single flat `infrastructure/` project (`main.tf`, `caddy.tf`, `apps.tf`, `cloud-init.yaml`, Quadlet templates under `infrastructure/files/`); `Dockerfile` updated to bake `APP_GIT_SHA` from a build ARG so `/readyz` reflects the running image.
- **CI/CD:** All three current workflows (`deploy-prod`, `deploy-staging`, `plan-infra`) are rewritten. New `apply-infra.yml` workflow (`workflow_dispatch`) runs `tofu apply` from an operator's manual trigger.
- **Secrets:** GitHub Actions secrets remain the source of truth. Delivery shifts from K8s `Secret` → `envFrom.secretRef` to a tofu `file` provisioner copying a runner-local file to `/etc/wfe/<env>.env`. Tofu state stores only the file's md5 hash, never plaintext.
- **Dependencies (external):** Scaleway account, Scaleway Object Storage bucket for tofu state. UpCloud account is retired post-cutover. ghcr.io packages are made public (no PAT on the VPS).
- **Docs:** `docs/infrastructure.md` rewritten for steady-state VPS ops. `CLAUDE.md` edited to drop kind-cluster references and the "Cluster smoke (human)" tasks.md pattern. `SECURITY.md` §5 (deployment surface) rewritten to describe rootless-Podman + firewall + scoped-sudo posture.
- **OpenSpec project context:** `openspec/project.md`'s "Infrastructure" line ("OpenTofu (HCL), kind (local K8s), Traefik (Helm + IngressRoute CRDs), oauth2-proxy, S2 (local S3)") is stale post-merge and is updated as part of this change.
- **Operational risks accepted:** No backups (a VPS-loss event is total data loss until a follow-up change adds them); no rollback (cutover failure means fix-forward, not revert); Stardust/START-2-S memory headroom is real but not generous and depends on per-Quadlet `MemoryMax` discipline.
- **Non-goals:** Detailed in `design.md`. Highlights: no event-store data migration; no backups; no app/runtime/auth-contract behavior changes; no multi-replica or HA; no monitoring/alerting; no podman-on-laptop local-dev path; K8s isolation primitives are not preserved as such, only their intent.
