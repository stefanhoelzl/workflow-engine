## Why

Vite intentionally skips TypeScript type checking during builds — it only transpiles. This means workflows can be built and deployed with type errors if `pnpm check` is not run separately. Since the workflow SDK provides rich compile-time type safety (typed event payloads, emit validation, env narrowing), these guarantees are only effective if enforced at build time.

## What Changes

- The `workflowPlugin` gains a `buildStart` hook that runs the TypeScript compiler API against workflow entry files before bundling
- Type checking uses a strict tsconfig shipped by the plugin itself, ensuring consistent strictness across all workflow projects
- Type checking is skipped in watch mode (dev) — only production builds are gated
- `typescript` becomes a peer dependency of `@workflow-engine/vite-plugin`

## Capabilities

### New Capabilities

- `build-time-typecheck`: TypeScript type checking enforced during workflow production builds via the Vite plugin's `buildStart` hook

### Modified Capabilities

- `vite-plugin`: Adds a `buildStart` hook for type checking and a `typescript` peer dependency

## Impact

- **`packages/vite-plugin`**: New `buildStart` hook with TypeScript compiler API integration; new peer dependency on `typescript`
- **Build pipeline**: Production workflow builds will fail on type errors (intentional); dev watch mode unaffected
- **Future workflow repos**: Will need `typescript` installed alongside `@workflow-engine/sdk` and `@workflow-engine/vite-plugin`
