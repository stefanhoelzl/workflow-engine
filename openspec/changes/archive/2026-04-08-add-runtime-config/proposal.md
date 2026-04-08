## Why

The runtime reads `LOG_LEVEL` and `PORT` directly from `process.env` in `main.ts` with inline defaults and no validation. Adding a dedicated config module centralizes environment parsing, validates values at startup (fail-fast on misconfiguration), and makes configuration testable without touching `process.env`.

## What Changes

- Add a `config.ts` module to `@workflow-engine/runtime` that defines a Zod schema for server-level environment variables and exports a `createConfig(env)` factory function.
- `main.ts` calls `createConfig(process.env)` at startup and uses the returned typed config object instead of accessing `process.env` directly.
- Add `zod` as a direct dependency of `@workflow-engine/runtime`.

## Capabilities

### New Capabilities
- `runtime-config`: Typed, validated configuration for the runtime server parsed from environment variables via Zod.

### Modified Capabilities

None. Action-level env vars (`ctx.env`) and `ContextFactory` are unchanged.

## Impact

- `packages/runtime/src/main.ts` — removes direct `process.env` access for `LOG_LEVEL` and `PORT`
- `packages/runtime/src/config.ts` — new file
- `packages/runtime/package.json` — adds `zod` dependency
- No API changes, no manifest changes, no sandbox boundary impact
