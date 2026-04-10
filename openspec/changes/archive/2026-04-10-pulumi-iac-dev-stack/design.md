## Context

The deployment stack currently uses `docker-compose.yml` to orchestrate three containers (app, caddy, oauth2-proxy). Configuration is split across docker-compose env vars (manually exported), a hardcoded `localhost` Caddyfile, and pinned image tags. There is no mechanism for managing multiple environments or encrypting secrets at rest.

This is the first step toward full IaC — future steps will add Scaleway VPS provisioning (Step 6) and CI/CD promotion (Step 7) on top of this foundation.

## Goals / Non-Goals

**Goals:**
- Replace docker-compose with Pulumi as the single orchestration tool
- Pulumi stack config is the single source of truth for all configuration — no defaults in Caddyfile or other config files
- Encrypted secret storage for oauth2-proxy credentials
- Stack-based environment separation (dev stack now, prod stack in Step 6)
- Native ESM TypeScript consistent with the rest of the monorepo
- Simple UX: `pnpm deploy` / `pnpm deploy:destroy`

**Non-Goals:**
- Network isolation (deferred to sandboxing step)
- Egress proxy / Smokescreen (deferred to sandboxing step)
- VPS provisioning or remote Docker host (Step 6)
- Watchtower / ddclient (later step)
- Provider-portable abstraction layer (Step 6)
- CI/CD integration with Pulumi (Step 7)

## Decisions

### 1. Two Docker providers: `@pulumi/docker` + `@pulumi/docker-build`

Pulumi recommends the newer `docker-build` provider (BuildKit/buildx) for image builds, while `@pulumi/docker` handles containers, volumes, and networks. Using both follows current best practice.

- `@pulumi/docker-build` v0.0.15: `docker_build.Image` for building the app image locally
- `@pulumi/docker` v4.11.1: `docker.Container`, `docker.Volume` for runtime resources

Alternative considered: `@pulumi/docker` v4 alone (has `docker.Image` for builds). Rejected because Pulumi explicitly recommends migrating image builds to the docker-build provider for better BuildKit support.

### 2. Local image build with `exports: [{ docker: { tar: true } }]`

The `docker-build.Image` resource builds the app image and loads it into the local Docker daemon via tar export. No registry push for the dev stack.

```
docker_build.Image("app")
  context: { location: ".." }
  dockerfile: { location: "./Dockerfile" }
  tags: ["workflow-engine:dev"]
  exports: [{ docker: { tar: true } }]
  push: false
```

Future prod stack will pull pre-built images from `ghcr.io` instead.

### 3. Flat `index.ts` structure

Single file, no abstractions. All resources defined inline. Provider-portable abstraction (e.g., `provider/scaleway.ts`) deferred to Step 6 when we'll know the right interface.

### 4. Pulumi Cloud state backend

Free tier handles state locking, encryption, and history. Requires one-time `pulumi login`. Alternative considered: local filesystem state. Rejected because it doesn't support collaboration or remote state locking.

### 5. Caddyfile uses `{$DOMAIN}` with no fallback

Caddy natively supports environment variable substitution. The `DOMAIN` env var is set on the caddy container by Pulumi from stack config. No default — Caddy fails loudly if not set. This ensures the single-source-of-truth principle: all defaults live in `Pulumi.dev.yaml`.

### 6. ESM module format

The infrastructure package uses `"type": "module"` and `tsconfig` with `module: "nodenext"`. Pulumi supports native ESM. This is consistent with the rest of the monorepo.

### 7. Container-to-container communication via Docker DNS

Containers reference each other by name (e.g., `app:8080`, `oauth2-proxy:4180`). Pulumi's Docker provider places containers on a default network where Docker DNS resolves container names. This replicates docker-compose's default behavior.

## Risks / Trade-offs

**Pulumi CLI dependency** — Developers now need `pulumi` CLI installed in addition to `pnpm` and Docker. → Mitigation: Document in setup instructions. Pulumi CLI is a single binary install.

**`@pulumi/docker-build` is v0.0.x** — Pre-1.0, API may change. → Mitigation: Pin version, minor API surface used (single `Image` resource). Easy to update.

**No docker-compose fallback** — Removing docker-compose means anyone without Pulumi can't run the stack. → Accepted trade-off: single source of truth is the priority. The Dockerfile and Caddyfile still work with manual `docker build` + `docker run` if needed.

**State in Pulumi Cloud** — External dependency for state. → Mitigation: Free tier is sufficient. Can migrate to S3 or local state later with `pulumi stack export/import`.

## Migration Plan

1. Add `infrastructure` to `pnpm-workspace.yaml`, create `package.json` and `tsconfig.json`
2. Add Pulumi project files (`Pulumi.yaml`, `Pulumi.dev.yaml`)
3. Write `index.ts` with all resources
4. Modify Caddyfile (`localhost` → `{$DOMAIN}`)
5. Test: `pulumi login` → set secrets → `pnpm deploy` → verify all 3 containers work
6. Remove `docker-compose.yml` and `compose:*` scripts
7. Update root `package.json` with `deploy` / `deploy:destroy` scripts

Rollback: `git revert` restores docker-compose.yml. No shared infrastructure is affected.

## Open Questions

None — all decisions resolved during design interview.
