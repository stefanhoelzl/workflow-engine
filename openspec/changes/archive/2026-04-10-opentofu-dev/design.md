## Context

The workflow-engine is currently deployed locally via Pulumi with Docker containers (Caddy reverse proxy + oauth2-proxy + app). This works but doesn't scale to production: no orchestration, no health management, no environment parity. The target production environment is UpCloud Managed Kubernetes.

We need an IaC setup where local dev and production share the same application modules, differing only in infrastructure backends. OpenTofu was chosen for native UpCloud provider support and open-source governance. kind (Kubernetes IN Docker) was chosen for local dev as it provides a vanilla K8s cluster closest to managed K8s services, with an actively maintained OpenTofu provider.

## Goals / Non-Goals

**Goals:**
- Single `tofu apply` creates the entire local dev environment from scratch
- Swappable infrastructure modules behind consistent output contracts (strategy pattern)
- Shared `workflow-engine` application module usable in both dev and prod
- All provider and image versions pinned for reproducibility
- Only two prerequisites: OpenTofu and Podman

**Non-Goals:**
- Production deployment (UpCloud K8s, DNS, Let's Encrypt) — separate future step
- CI/CD pipeline changes — existing GHCR release workflow is untouched
- Application code changes — this is infrastructure-only
- Network isolation / SSRF proxy — deferred to sandboxing step

## Decisions

### 1. kind over k3d for local Kubernetes

**Chosen:** kind with `tehcyx/kind` provider (v0.11.0, actively maintained, 912K downloads)

**Rejected:** k3d with `pvotal-tech/k3d` provider (v0.0.7, last release 2023, unmaintained)

**Rationale:** kind provides a vanilla K8s cluster — no built-in ingress, no pre-installed CRDs — which closely mirrors UpCloud Managed K8s. Both dev and prod install Traefik via Helm, making the environments consistent. k3d's built-in Traefik created a dev/prod divergence and introduced a CRD timing race condition during `tofu apply`.

### 2. Traefik via Helm (not built-in)

**Chosen:** Deploy Traefik via `hashicorp/helm` provider in the routing module

**Rejected:** k3d's built-in Traefik, standard Kubernetes Ingress with annotations

**Rationale:** Deploying Traefik via Helm solves the CRD timing problem — the Helm release installs CRDs before `kubernetes_manifest` resources reference them. It also gives explicit control over the Traefik version and configuration, and matches the prod setup exactly.

### 3. Strategy pattern for infrastructure modules

**Chosen:** Modules organized by capability with swappable implementations:
- `modules/kubernetes/kind/` (dev) ↔ `modules/kubernetes/upcloud/` (future prod)
- `modules/image/local/` (dev) ↔ `modules/image/registry/` (prod)
- `modules/s3/s2/` (dev) ↔ `modules/s3/upcloud/` (future prod)

**Rationale:** Each capability has a consistent output contract. The caller (`dev/main.tf` or `prod/main.tf`) picks the implementation. Inputs differ per implementation (cluster_name vs zone/network/plan), outputs are identical (host, ca_cert, client_cert, client_key).

### 4. Image loading inside kubernetes/kind module (not image/local)

**Chosen:** `terraform_data` with `podman save | ctr images import` lives in `modules/kubernetes/kind/`, receiving `image_name` as input. The `tehcyx/kind` provider's `kind_load` resource does not exist — the provider only has `kind_cluster`.

**Rejected:** Image loading in `modules/image/local/` or in `dev/main.tf`

**Rationale:** `image/local` should only know about podman — it builds and outputs an image name. How that image gets into a cluster is the cluster module's concern. This keeps `image/local` reusable regardless of cluster type. The `image_name` input is kind-specific (UpCloud pulls from a registry, no loading needed).

### 5. Routing inside workflow-engine module

**Chosen:** `modules/workflow-engine/modules/routing/` contains a single Traefik Helm release with IngressRoute and Middleware CRDs deployed via `extraObjects` in the Helm values. Traefik uses a `NodePort` service on port 30443 (not `hostPort: 443`) to avoid conflicting with the K8s API server on single-node kind clusters. An `errors` middleware is chained before `forwardAuth` on protected routes to render the oauth2-proxy sign-in page on 401.

**Rejected:** Separate top-level `modules/routing/`, `kubernetes_manifest` resources for CRDs (causes plan-time validation failure without existing cluster), `hostPort: 443` (hijacks K8s API traffic)

**Rationale:** Routing is part of the application stack. Using `extraObjects` bundles all Traefik CRDs into the Helm release, eliminating the `kubernetes_manifest` CRD timing problem and enabling single `tofu apply` from clean state.

### 6. Random values generated inside sub-modules

**Chosen:** `random_password` for oauth2-proxy cookie secret generated inside `modules/workflow-engine/modules/oauth2-proxy/`

**Rejected:** Caller generates and passes in, parent module generates

**Rationale:** The cookie secret is an implementation detail of oauth2-proxy. Each sub-module that needs random values owns them. The `random` provider has no configuration, so declaring it in sub-modules is essentially free.

### 7. S2 with osfs (filesystem storage, no PVC)

**Chosen:** `S2_SERVER_TYPE=osfs` — filesystem-backed S3, data persists across app restarts but lost on S2 pod restart (no PVC)

**Rejected:** `memfs` (S2's in-memory backend has a bug where `ListObjectsV2` does not return keys containing `/`, which breaks the app's `pending/` and `archive/` prefix-based listing), MinIO, LocalStack, PVC

**Rationale:** S2 (mojatter/s2-server v0.4.1) is tiny (3.5MB), actively maintained, has a health endpoint, and supports AWS Signature V4 auth. The `osfs` backend correctly handles hierarchical keys. Dev data is disposable (lost on S2 pod restart) but persists across app restarts, which is sufficient for development.

### 8. Local state backend for dev

**Chosen:** `backend "local" {}` — state file at `dev/terraform.tfstate`, gitignored

**Rejected:** UpCloud S3 remote backend

**Rationale:** Single developer, local-only stack. No need for remote locking or shared state. Can migrate to remote backend later when prod is added.

## Risks / Trade-offs

- **[tehcyx/kind provider — no kind_load resource]** REALIZED: The provider only has `kind_cluster`, no image loading resource. → Resolved: `terraform_data` with `podman save | ctr images import` in the kubernetes/kind module.

- **[kubernetes_manifest CRD timing]** REALIZED: `kubernetes_manifest` validates CRDs at plan time, failing on first apply before Helm installs them. → Resolved: moved all CRDs (IngressRoute, Middlewares) into Traefik Helm chart's `extraObjects`. Single `tofu apply` works from clean state.

- **[Traefik hostPort 443 conflicts with K8s API]** REALIZED: `hostPort: 443` on Traefik hijacks the K8s API server's ClusterIP traffic on single-node kind clusters. → Resolved: switched to `NodePort: 30443` with kind port mapping `host:8443 → node:30443`.

- **[S2 memfs ListObjectsV2 bug]** REALIZED: S2's in-memory backend silently drops keys containing `/` from list operations. Writes succeed but `pending/` and `archive/` prefixes are invisible. → Resolved: switched to `osfs` backend.

- **[hashicorp/kubernetes v3 and hashicorp/helm v3]** Minor syntax changes from v2: `kubernetes {}` block → `kubernetes = {}` attribute, `set {}` blocks → `set = [{}]` list. → Resolved during implementation.

- **[Podman in Toolbox containers]** Rootless Podman cannot run inside Toolbox due to user namespace restrictions (`newuidmap` denied). → Resolved: configured Podman remote mode (`/etc/containers/containers.conf.d/toolbox-remote.conf`) to talk to host's Podman socket.

- **[Provider config from module output]** Kubernetes and Helm providers configured from `module.cluster` outputs. → Works correctly with OpenTofu's deferred provider initialization. No `-target` needed.

## Migration Plan

1. Extract OAuth2 secrets from Pulumi config → `dev.secrets.auto.tfvars`
2. `pulumi destroy` — tear down existing Docker containers
3. `pulumi stack rm dev` — remove Pulumi stack
4. Delete Pulumi files: `index.ts`, `package.json`, `tsconfig.json`, `Pulumi.yaml`, `Pulumi.dev.yaml`, `Caddyfile`
5. Remove Pulumi npm dependencies from lockfile
6. Implement OpenTofu modules and dev root
7. `tofu init` + `tofu apply` — verify dev stack works end-to-end
8. Verify: app accessible at `https://localhost:8443`, OAuth flow works, S3 storage works

Rollback: git revert to restore Pulumi files + `pulumi up` to recreate Docker stack.

## Open Questions

- None remaining — all questions resolved during design exploration.
