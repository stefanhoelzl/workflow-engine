## 1. Vite Build

- [x] 1.1 Create `vite.config.ts` at the repository root with SSR build config (entry: `packages/runtime/src/main.ts`, output: `dist/`, bundle all deps, externalize `node:*`)
- [x] 1.2 Add `build` script to root `package.json`: `vite build`
- [x] 1.3 Verify `pnpm build` produces `dist/main.js` and it runs with `node dist/main.js`

## 2. Port Configuration

- [x] 2.1 Update `packages/runtime/src/main.ts` to read `PORT` from `process.env` with default `8080`
- [x] 2.2 Verify existing tests still pass after the port change

## 3. Docker

- [x] 3.1 Create `.dockerignore` at the repository root (exclude `node_modules`, `dist`, `.git`, `.env`, `openspec/`, editor configs)
- [x] 3.2 Create `Dockerfile` at the repository root with multi-stage build: `node:24-slim` + corepack/pnpm build stage, `gcr.io/distroless/nodejs24-debian13` production stage with `nonroot` user
- [x] 3.3 Verify `docker build -t workflow-engine .` completes successfully

## 4. Validation

- [x] 4.1 Run `pnpm lint`, `pnpm check`, and `pnpm test` to confirm nothing is broken
