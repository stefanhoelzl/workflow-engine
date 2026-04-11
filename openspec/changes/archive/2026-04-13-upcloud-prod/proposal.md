## Why

The workflow-engine needs a production deployment. UpCloud provides European-hosted managed Kubernetes with a free control plane and free managed load balancer (Essentials tier), making it the cheapest viable option (~8 EUR/mo total). The local dev infrastructure was already refactored (Phase 1) to make modules reusable across environments. This change implements the production environment using those shared modules.

## What Changes

- Add `modules/kubernetes/upcloud/` implementing the kubernetes module contract using UpCloud Managed K8s with ephemeral credential outputs
- Add `modules/s3/upcloud/` implementing the S3 module contract using UpCloud Managed Object Storage with a scoped IAM user policy
- Add `infrastructure/upcloud/persistence/` as a standalone OpenTofu project managing the Object Storage instance, app bucket, and scoped service user (separate lifecycle from cluster)
- Add `infrastructure/upcloud/upcloud.tf` as the production composition root wiring cluster, app, routing, DNS, and TLS
- Add `tls` variable to `modules/workflow-engine/` for optional IngressRoute TLS configuration (certResolver)
- Add `wait` variable to `modules/routing/` to support Helm `--wait` behavior for LoadBalancer IP readiness
- Manage Dynu DNS A record via `Mastercard/restapi` provider (domain looked up by name, A record pointing at LB IP)
- Configure Traefik with Let's Encrypt TLS-ALPN-01 certificate resolver (staging/prod switchable) and PVC for cert persistence
- Extend CI to validate all OpenTofu projects
- Update CLAUDE.md with production deployment documentation

## Capabilities

### New Capabilities

(none — all changes fall under the existing `infrastructure` capability)

### Modified Capabilities
- `infrastructure`: Add UpCloud Kubernetes module, UpCloud Object Storage module, persistence project, production composition root (Dynu DNS, Let's Encrypt TLS, Managed LB), `tls` variable on workflow-engine, `wait` variable on routing, CI validation for all projects, CLAUDE.md prod docs

## Impact

- New providers: `UpCloudLtd/upcloud ~> 5.0`, `Mastercard/restapi` (latest)
- New environment variables for prod: `UPCLOUD_USERNAME`, `UPCLOUD_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`
- New secrets file: `infrastructure/upcloud/prod.secrets.auto.tfvars` (OAuth credentials, ACME email, Dynu API key)
- Manual prerequisite: create UpCloud Object Storage instance + state bucket + admin user via console
- CI workflow changes: add `tofu init && tofu validate` for upcloud projects
- No changes to application code, Dockerfile, or existing local infrastructure behavior
