## Why

Actions currently read environment variables via `process.env` at module scope, closing over them in handlers. This couples action definitions to the global environment and makes testing harder — there's no injection point to control what env vars an action sees. Adding `ctx.env` follows the same constructor-injection pattern established by `ctx.fetch`, giving the runtime a clean interception point and making tests trivial.

## What Changes

- Add a `readonly env` property to `ActionContext` exposing environment variables as `Record<string, string | undefined>`
- Extend `ContextFactory` constructor to accept an env record (same injection pattern as `fetch`)
- Thread the env record from `ContextFactory` into every `ActionContext` it creates
- Migrate sample actions from module-scope `requireEnv()` closures to `ctx.env.*` reads
- Remove the `requireEnv` helper from `sample.ts`

## Capabilities

### New Capabilities

_(none — this extends the existing context capability)_

### Modified Capabilities

- `context`: ActionContext gains a new `env` property and ContextFactory accepts an additional constructor parameter

## Impact

- `packages/runtime/src/context/index.ts` — ActionContext class, ContextFactory class
- `packages/runtime/src/main.ts` — passes `process.env` to ContextFactory
- `packages/runtime/src/sample.ts` — action handlers switch to `ctx.env`, `requireEnv` removed
- Context tests and integration tests need updating for new constructor parameter
- No impact on QueueStore interface, manifest format, or sandbox boundary
