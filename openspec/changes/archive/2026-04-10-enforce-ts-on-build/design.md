## Context

The `workflowPlugin` Vite plugin currently processes workflow files in two passes (manifest extraction + actions bundling) but performs no TypeScript type checking. Vite transpiles TypeScript via esbuild/Rolldown without invoking the type checker. Type errors are only caught by a separate `pnpm check` (`tsc --build`) step, which can be skipped.

The SDK provides rich compile-time type safety (typed event payloads, emit validation, env narrowing via Zod schemas). These guarantees are only effective if the type checker actually runs before deployment.

Workflows will eventually live in their own repositories with only `@workflow-engine/sdk` and `@workflow-engine/vite-plugin` as dependencies. The type checking must be self-contained within the plugin.

## Goals / Non-Goals

**Goals:**
- Production workflow builds fail on TypeScript errors
- Type checking is self-contained in the plugin (no external tsconfig required)
- Zero configuration for workflow authors — works out of the box

**Non-Goals:**
- Type checking during dev watch mode (editor provides real-time feedback)
- Replacing `pnpm check` for full project-wide type checking
- Making the plugin's tsconfig customizable

## Decisions

### 1. TypeScript compiler API over shelling out to `tsc`

Use `ts.createProgram` + `ts.getPreEmitDiagnostics` programmatically.

**Why over `tsc` subprocess:** No subprocess overhead, no CLI output parsing, precise control over diagnostic formatting. The plugin already runs in a Node.js process where the TS API is available.

### 2. Plugin ships its own compiler options

The plugin defines a hardcoded set of strict compiler options rather than reading a tsconfig file from the workflow project.

**Why over reading user tsconfig:** Guarantees consistent strictness across all workflow projects. Prevents authors from weakening checks. Eliminates configuration — the plugin is the single source of truth for build-time type safety.

Compiler options:
- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- `verbatimModuleSyntax: true` (ESM correctness)
- `noEmit: true`, `isolatedModules: true`, `skipLibCheck: true`
- `target: esnext`, `module: NodeNext`, `moduleResolution: NodeNext`

### 3. Workflow entries as `rootNames`

The `workflows` array already passed to the plugin doubles as `rootNames` for `ts.createProgram`. TypeScript transitively checks all imports from these entry points.

**Why over globbing:** Checks exactly what gets built — nothing more, nothing less. No risk of checking stale or unrelated files.

### 4. Skip type checking in watch mode

Detect `build.watch` from the Vite config in the `buildStart` hook. When set, skip type checking entirely.

**Why:** The editor's language server already provides real-time type feedback via `workflows/tsconfig.json`. Adding a second type check to every hot reload adds latency without catching anything new.

### 5. `typescript` as peer dependency

The plugin declares `typescript` as a peer dependency (`>=5.0.0`).

**Why over direct dependency:** Ensures the same TypeScript version is used for build-time checking as for editor feedback and `tsc --build`. Critical for the future separate-repo setup where the workflow project must explicitly install TypeScript.

### 6. Pretty error formatting

Use `ts.formatDiagnosticsWithColorAndContext` for build failure output.

**Why:** Matches the `tsc --pretty` experience — shows source lines with carets pointing to errors. Makes build failures immediately actionable.

## Build flow

```
buildStart hook
│
├─ watch mode? ──yes──▶ skip, return
│
└─ no
   │
   ├─ resolve workflow entry paths against Vite root
   │
   ├─ ts.createProgram(rootNames, compilerOptions)
   │
   ├─ ts.getPreEmitDiagnostics(program)
   │
   ├─ errors? ──no──▶ continue to generateBundle (existing logic)
   │
   └─ yes
      │
      └─ format with color + context, throw Error (fails build)
```

## Risks / Trade-offs

- **[Build time increase]** → `ts.createProgram` adds ~200-500ms to production builds depending on workflow count. Acceptable since production builds are infrequent and correctness is the priority.
- **[TS version coupling]** → The peer dependency means the plugin's behavior depends on the consumer's TypeScript version. Mitigated by the `>=5.0.0` floor and the fact that strict mode semantics are stable across versions.
- **[Duplicate checking]** → `pnpm check` still runs `tsc --build` which also checks workflows. This is intentional redundancy — the plugin check catches errors at build time, `pnpm check` catches them during development/CI.
