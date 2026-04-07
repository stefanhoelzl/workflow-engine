## Context

The runtime currently runs via `tsx src/main.ts` with no build step and no container packaging. It listens on hardcoded port 3000, depends on `hono` and `@hono/node-server`, and requires 4 Nextcloud environment variables at startup. The project is a pnpm monorepo with `vite` already present as a dev dependency.

## Goals / Non-Goals

**Goals:**
- Produce a minimal, secure production container image
- Bundle the runtime into a single JS file with no `node_modules` in the image
- Make the server port configurable

**Non-Goals:**
- Development container or hot-reload support
- Health check endpoint
- Graceful shutdown / SIGTERM handling
- Decoupling the sample workflow from the runtime
- docker-compose configuration

## Decisions

### 1. Vite SSR build to produce a single bundle

Use Vite's SSR build mode with `ssr.noExternal: true` to bundle all dependencies (`hono`, `@hono/node-server`) into a single JS file. Node.js built-in modules (`node:http`, `node:http2`, etc.) are automatically externalized by Vite's SSR target.

**Why Vite over tsc:** tsc only transpiles — it doesn't bundle. The output would still require `node_modules` with `hono` and `@hono/node-server` installed in the production image. Vite produces a single self-contained file, eliminating `node_modules` entirely.

**Config location:** `vite.config.ts` at the repository root, since `vite` is a root-level dev dependency and the `build` script will run from the root.

### 2. Multi-stage Dockerfile

```
Stage 1: node:24-slim       Stage 2: distroless/nodejs24-debian13
┌───────────────────────┐   ┌────────────────────────────────────┐
│ corepack enable       │   │ COPY --from=build dist/main.js     │
│ pnpm install          │   │ USER nonroot                       │
│ pnpm build (vite)     │──▶│ EXPOSE 8080                        │
│                       │   │ CMD ["app/main.js"]                │
│ Output: dist/main.js  │   │                                    │
└───────────────────────┘   └────────────────────────────────────┘
  ~200MB (discarded)          ~30-50MB (shipped)
```

**Build stage** (`node:24-slim`): Installs pnpm via corepack, installs dependencies, runs Vite build. Chosen over Alpine for glibc compatibility; chosen over full `node:24` to reduce pull time.

**Production stage** (`gcr.io/distroless/nodejs24-debian13`): Copies only the bundled JS file. No shell, no package manager, no `node_modules`. Runs as the built-in `nonroot` user (UID 65532).

### 3. Port configuration via PORT env var

Read `process.env.PORT` in `main.ts` with a default of `8080`. This is the standard convention for container platforms (Cloud Run, Heroku, Railway all inject `PORT`).

**Why 8080 over 3000:** 8080 is the conventional default for containerized HTTP services. Port 3000 remains the implicit default for local `tsx` development (unchanged unless `PORT` is set).

### 4. .dockerignore excludes

Exclude `node_modules`, `dist`, `.git`, `.env`, `openspec/`, and editor config to keep the Docker build context small and prevent secrets from leaking into build layers.

## Risks / Trade-offs

**Single-file bundle may complicate debugging** → Stack traces will reference bundled code, not original TypeScript. Mitigation: can add source maps later if needed, but for a small codebase this is acceptable.

**Distroless has no shell for debugging** → Cannot `docker exec` into the container. Mitigation: this is intentional for security. For debugging, use logging or build a debug image from `node:24-slim` instead.

**Sample workflow is baked in** → The image only works with the Cronitor→Nextcloud workflow and crashes without those env vars. Accepted: the sample is the product for now; generalization is a future concern.
