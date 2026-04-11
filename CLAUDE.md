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

## Definition of Done

- `pnpm validate` must pass (runs lint, format check, type check, and tests)

## Code Conventions

- All relative imports must use `.js` extensions (required by `verbatimModuleSyntax`)
- Use `z.exactOptional()` not `.optional()` for optional Zod fields (`exactOptionalPropertyTypes` is enabled)
- Factory functions over classes. Closures for private state.
- Named exports only. Separate `export type {}` from value exports.
- `biome-ignore` comments must have a good reason suffix. Write code that doesn't need them. Remove any that lack justification.
