## REMOVED Requirements

### Requirement: Production builds enforce TypeScript type checking

**Reason**: `build-time-typecheck` is a single-topic spec that belongs inside the workflow-build capability alongside manifest generation and export-identifier rules. Splitting typecheck out artificially separates two halves of the same pipeline step.

**Migration**: See `workflow-build` — the `buildStart` typecheck requirement lives there now, with identical scenarios (build fails on type error; build succeeds with valid types; watch mode skips typecheck).

### Requirement: Plugin ships fixed strict compiler options

**Reason**: Same absorption into `workflow-build`.

**Migration**: See `workflow-build` — the hardcoded strict options (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noEmit`, `isolatedModules`, `skipLibCheck`, `target: esnext`, `module/moduleResolution: NodeNext`) are preserved verbatim.

### Requirement: Type checking scoped to declared workflow entries

**Reason**: Same absorption into `workflow-build`.

**Migration**: See `workflow-build` — the declared-entries-only typecheck scope is preserved.

### Requirement: TypeScript as peer dependency

**Reason**: Same absorption into `workflow-build`. Note: the package name changes from `@workflow-engine/vite-plugin` to `@workflow-engine/sdk/plugin` per `fix-http-trigger-url` et al.; the peer-dep requirement tracks the new package.

**Migration**: See `workflow-build` — `typescript >=5.0.0` peer dep on `@workflow-engine/sdk` (where the plugin is now re-exported).

### Requirement: Pretty error formatting

**Reason**: Same absorption into `workflow-build`.

**Migration**: See `workflow-build` — `ts.formatDiagnosticsWithColorAndContext` invocation with same error output contract.
