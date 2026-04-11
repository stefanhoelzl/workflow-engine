# Project Notes

## Tools

- Run `openspec` via: `pnpm exec openspec`
- Read `openspec/project.md` for architecture context

## Commands

- `pnpm lint` — Biome linter
- `pnpm check` — TypeScript type checking
- `pnpm test` — Vitest test suite
- `pnpm build` — Build runtime + workflows
- `pnpm start` — Build workflows and start runtime

## Infrastructure (OpenTofu + kind)

Prerequisites: OpenTofu >= 1.11, Podman

- `pnpm infra:up` — create/update local environment
- `pnpm infra:up:build` — rebuild app image + create/update local environment
- `pnpm infra:destroy` — tear down local environment

Local stack: kind K8s cluster, Traefik (Helm), S2 (local S3), oauth2-proxy, workflow-engine app.
Accessible at `https://localhost:8443` (self-signed cert).

Secrets: copy `infrastructure/local/local.secrets.auto.tfvars.example` to `local.secrets.auto.tfvars` and fill in OAuth2 credentials.

## Production (OpenTofu + UpCloud)

Prerequisites: OpenTofu >= 1.11, UpCloud account, Dynu DNS domain

Three separate tokens with least-privilege. State credentials via `AWS_*` (S3 backend requirement), everything else via `TF_VAR_*`:

Shared by both projects (state backend, scoped to `tofu-state` bucket only):
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — S3 state backend credentials
- `TF_VAR_state_passphrase` — passphrase for client-side state encryption (AES-GCM)

Persistence project (`infrastructure/upcloud/persistence/`):
- `TF_VAR_upcloud_token` — UpCloud API token (Object Storage permissions)

Main project (`infrastructure/upcloud/`):
- `TF_VAR_upcloud_token` — UpCloud API token (K8s + networking permissions)
- `TF_VAR_dynu_api_key` — Dynu DNS API key
- `TF_VAR_oauth2_client_id`, `TF_VAR_oauth2_client_secret` — GitHub OAuth App credentials
- `TF_VAR_acme_email` — Email for Let's Encrypt notifications
- `TF_VAR_kubernetes_version`, `TF_VAR_node_plan` — UpCloud K8s config

Note: `TF_VAR_upcloud_token` is set to a different scoped token per project.
State bucket and endpoint are hardcoded in backend configs.

One-time setup:
1. Create UpCloud Object Storage instance via console
2. Create admin user + access key + `terraform-state` bucket
3. Register GitHub OAuth App for `workflow-engine.webredirect.org`

Deploy:
1. `cd infrastructure/upcloud/persistence && tofu init && tofu apply` — creates app bucket + scoped user
2. `cd infrastructure/upcloud && tofu init && tofu apply` — creates K8s cluster + deploys app + sets DNS

Accessible at `https://workflow-engine.webredirect.org` (Let's Encrypt TLS).

## Definition of Done

- `pnpm validate` must pass (runs lint, format check, type check, and tests)

## Code Conventions

- All relative imports must use `.js` extensions (required by `verbatimModuleSyntax`)
- Use `z.exactOptional()` not `.optional()` for optional Zod fields (`exactOptionalPropertyTypes` is enabled)
- Factory functions over classes. Closures for private state.
- Named exports only. Separate `export type {}` from value exports.
- `biome-ignore` comments must have a good reason suffix. Write code that doesn't need them. Remove any that lack justification.
