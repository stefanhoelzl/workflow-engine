## Why

The current deployment uses Pulumi with Docker containers (Caddy + oauth2-proxy + app) managed via TypeScript. This approach doesn't scale to production — it lacks Kubernetes orchestration, health management, and environment parity. We need infrastructure-as-code that supports both local development and a future production deployment on UpCloud Managed Kubernetes, using the same application modules with swappable infrastructure backends.

## What Changes

- **BREAKING**: Replace Pulumi IaC with OpenTofu HCL — delete all Pulumi files (`index.ts`, `package.json`, `tsconfig.json`, `Pulumi.yaml`, `Pulumi.dev.yaml`)
- **BREAKING**: Replace Caddy reverse proxy with Traefik deployed via Helm — delete `Caddyfile`
- **BREAKING**: Replace Docker container orchestration with Kubernetes via kind (local dev cluster)
- Add OpenTofu module structure with strategy pattern: swappable infrastructure modules (`kubernetes/kind`, `image/local`, `s3/s2`) behind consistent output contracts
- Add shared `workflow-engine` application module composing app deployment, oauth2-proxy, and Traefik routing
- Add S2 (mojatter/s2-server) as local S3-compatible storage, replacing filesystem persistence in dev
- Add `kind_load` for loading locally-built container images into the kind cluster
- Pin all provider versions (OpenTofu ≥ 1.11, tehcyx/kind ~> 0.11, hashicorp/kubernetes ~> 3.0, hashicorp/helm ~> 3.1, hashicorp/random ~> 3.8, hashicorp/null ~> 3.2)
- Pin all image/chart versions (S2 0.4.1, oauth2-proxy v7.15.1, Traefik Helm chart 39.0.7)

## Capabilities

### New Capabilities
- `infrastructure`: Complete OpenTofu-based deployment infrastructure — dev stack root configuration, kind cluster module, local/registry image modules, S2 local S3 module, shared workflow-engine application module (app + oauth2-proxy + routing sub-modules), Dockerfile integration, version pinning, secrets management

### Modified Capabilities
- `pulumi-stack`: **BREAKING** — entirely removed and replaced by OpenTofu modules
- `compose-stack`: **BREAKING** — already replaced by Pulumi, now fully superseded by OpenTofu
- `reverse-proxy`: **BREAKING** — Caddy replaced by Traefik; routing rules preserved but expressed as Traefik IngressRoute CRDs instead of Caddyfile directives
- `docker`: **BREAKING** — Dockerfile unchanged, but image build/orchestration moves from Pulumi/Docker to OpenTofu/podman/Kubernetes. Consolidated into `infrastructure` capability.

## Impact

- **Infrastructure**: `infrastructure/` directory restructured — Pulumi files deleted, new `modules/` and `dev/` directories with OpenTofu HCL
- **Dependencies**: Pulumi npm packages removed from `infrastructure/package.json`; replaced by OpenTofu providers (downloaded by `tofu init`)
- **Secrets**: OAuth2 credentials migrated from Pulumi encrypted config to `dev.secrets.auto.tfvars` (gitignored)
- **Developer workflow**: `pulumi up` replaced by `tofu apply`; requires OpenTofu ≥ 1.11 and Podman installed
- **Storage**: App switches from `PERSISTENCE_PATH` (filesystem) to `PERSISTENCE_S3_*` env vars (S2) in dev
- **No application code changes**: All changes are infrastructure-only
