## Context

The runtime entry point (`main.ts`) reads `LOG_LEVEL` and `PORT` from `process.env` with inline defaults and no validation. These accesses are scattered across the file and suppressed with biome-ignore comments. There is no centralized configuration module.

## Goals / Non-Goals

**Goals:**
- Centralize server-level environment variable parsing into a single module
- Validate config values at startup (fail-fast on invalid input)
- Make configuration testable without touching `process.env`
- Provide a typed config object to `main.ts`

**Non-Goals:**
- Centralizing action-level env vars (those stay in `ContextFactory` / `ctx.env`)
- Supporting config files (JSON, YAML, TOML, etc.)
- Supporting `.env` file loading (dotenv)

## Decisions

### Use Zod for env parsing
Parse environment variables with a Zod schema. Zod is already used in the SDK for payload validation, so the pattern is familiar and consistent across the project. No new dependency concept — just adding `zod` to runtime's `package.json`.

**Alternatives considered:**
- **t3-env**: Built on Zod, adds runtime access proxy. Overkill for 2 server vars in a backend-only runtime.
- **envalid**: Dedicated env library with its own API. Introduces a new validation pattern alongside Zod.
- **Manual parsing**: No validation, no types, status quo problems persist.

### Export a `createConfig(env)` factory, not a singleton
The module exports a `createConfig(env: Record<string, string | undefined>)` function rather than a pre-parsed config object. The caller passes `process.env` explicitly.

**Rationale:** Keeps `process.env` access in `main.ts` (the entry point), makes config trivially testable, and avoids top-level side effects in the module.

### Only export `createConfig`
No separate `Config` type export. Consumers derive the type via `ReturnType<typeof createConfig>` if needed.

**Rationale:** Minimal API surface. One export, one purpose.

### Add `zod` as a direct runtime dependency
Rather than importing from `@workflow-engine/sdk` which re-exports `z`, add `zod` directly to runtime's `package.json`.

**Rationale:** Config is a runtime concern. Coupling it to the SDK for a transitive dependency is fragile and semantically wrong.

## Risks / Trade-offs

- **Zod parse on full `process.env`**: Zod's `z.object().parse()` with `.default()` on a large `process.env` works fine because `.parse()` only validates declared keys — extra keys are stripped (or ignored with `.passthrough()`). No risk here.
- **Two `process.env` touchpoints in `main.ts`**: `main.ts` will still pass `process.env` to both `createConfig()` and `ContextFactory`. This is intentional — they serve different purposes and should not be coupled.
