## 1. Vite Config

- [x] 1.1 Add `@duckdb/node-api` and `@duckdb/node-bindings` to `ssr.external` in `vite.config.ts`

## 2. Dockerfile

- [x] 2.1 Add `pnpm deploy --prod --filter @workflow-engine/runtime dist/` step after `pnpm build`
- [x] 2.2 Update `COPY --from=build` to copy entire `dist/` directory instead of just `dist/main.js`
- [x] 2.3 Verify the Docker build succeeds locally
