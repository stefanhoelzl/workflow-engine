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

- `pnpm infra:up` — build app image + create/update dev environment
- `pnpm infra:destroy` — tear down dev environment

Dev stack: kind K8s cluster, Traefik (Helm), S2 (local S3), oauth2-proxy, workflow-engine app.
Accessible at `https://localhost:8443` (self-signed cert).

Secrets: copy `infrastructure/dev/dev.secrets.auto.tfvars.example` to `dev.secrets.auto.tfvars` and fill in OAuth2 credentials.

## Definition of Done

- `pnpm validate` must pass (runs lint, format check, type check, and tests)

## Code Conventions

- All relative imports must use `.js` extensions (required by `verbatimModuleSyntax`)
- Use `z.exactOptional()` not `.optional()` for optional Zod fields (`exactOptionalPropertyTypes` is enabled)
- Factory functions over classes. Closures for private state.
- Named exports only. Separate `export type {}` from value exports.
- `biome-ignore` comments must have a good reason suffix. Write code that doesn't need them. Remove any that lack justification.

## Security Invariants

Full threat model: `/SECURITY.md`. Consult it before writing security-sensitive code.

- **NEVER** add a global, host-bridge API, or Node.js surface to the QuickJS sandbox (§2).
- **NEVER** add authentication to `/webhooks/*` — public ingress is intentional (§3).
- **NEVER** add a UI route (`/dashboard`, `/trigger`, or any future authenticated UI prefix) without confirming oauth2-proxy forward-auth covers it at Traefik (§4).
- **NEVER** add an `/api/*` route without the `githubAuthMiddleware` in front of it (§4).
- **NEVER** trust `X-Auth-Request-*` or `X-Forwarded-*` headers as authoritative while a K8s `NetworkPolicy` is absent (§4 / §5).
- **NEVER** hardcode or commit a secret; route all secrets through K8s Secrets injected via `envFrom.secretRef` (§5).
- **NEVER** log, emit, or store the `Authorization` header, session cookies, or OAuth secrets (§4).
