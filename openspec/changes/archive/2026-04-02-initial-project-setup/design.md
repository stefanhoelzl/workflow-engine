## Context

The repository contains only a README and OpenSpec configuration. The `runtime` package needs scaffolding before any feature work can begin. The monorepo structure is set up for future packages (`sdk`, `vite-plugin`) but only `runtime` is created now. The tooling must support strict TypeScript type checking, Biome linting/formatting, and Vitest testing from day one.

Current state: a single root `package.json` with `@fission-ai/openspec` as the only dev dependency.

## Goals / Non-Goals

**Goals:**

- A working pnpm workspace where `pnpm install` resolves all dependencies
- `pnpm check` runs TypeScript type checking across all packages via project references
- `pnpm lint` and `pnpm format` run Biome across the entire repo
- `pnpm test` runs Vitest from a single root config
- Each package is independently publishable with its own `package.json`
- Strict TypeScript catches as many issues as possible at compile time

**Non-Goals:**

- Application code in any package (scaffolding only)
- Vite build configuration for individual packages (deferred to per-package changes)
- CI/CD pipeline setup
- Publishing configuration (npm registry, changelogs, versioning)
- Package-specific Vitest configs (start with root, split later if needed)

## Decisions

### D1: TypeScript strict settings — maximize compiler strictness

Use `strict: true` plus additional flags: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noEmit`, `declaration`, `composite`, `isolatedModules`, `verbatimModuleSyntax`, `skipLibCheck`.

**Why `noEmit`**: tsc is used only for type checking. Vite/Rolldown handles emit. This avoids dual-output confusion.

**Why `composite` + `declaration`**: Required for project references so packages can type-check against each other without building first.

**Why `verbatimModuleSyntax`**: Enforces explicit `import type` for type-only imports. Works well with Biome's `useImportType` rule and bundlers that need to distinguish type vs value imports.

**Why `isolatedModules`**: Required by all modern bundlers (Vite, esbuild, Rolldown) since they transpile files independently.

**Why `module: "NodeNext"`**: Forward-looking module resolution strategy that tracks the latest Node.js module behavior. Preferred over `"Node16"` for new projects.

**Alternative considered**: Omitting `composite` and using path aliases instead. Rejected because project references give proper cross-package type checking with incremental builds.

### D2: Biome — all rules enabled, disable individually as needed

Start with `"all": true` at the linter rules level. This enables every rule in every group (correctness, suspicious, style, complexity, performance, security). Individual rules that prove too noisy will be disabled one-by-one with a comment explaining why.

**Why all**: The project runs untrusted code. Maximum static analysis coverage is worth the initial noise. It's easier to disable specific rules than to discover you needed one after a bug ships.

**Alternative considered**: `recommended` baseline with `all` only on security-critical groups. Rejected — the project is greenfield, so there's no legacy code to fight. Start strict, loosen where justified.

### D3: Vitest — single root config with workspace awareness

Use a `vitest.config.ts` at the root. Vitest natively discovers tests in workspace packages. The root config sets shared defaults (TypeScript transform via Vite, test file patterns). Individual packages can override via `vitest.config.ts` in their directory if needed later.

**Why root config**: A single package doesn't justify per-package configs. Root config means one `pnpm test` command works everywhere. Easy to split later when more packages arrive or test requirements diverge.

**Alternative considered**: Per-package configs from the start. Rejected — premature with one package.

### D4: pnpm workspaces — no orchestration layer

Use `pnpm-workspace.yaml` pointing at `packages/*`. Workspace scripts in root `package.json` use `pnpm -r run` for cross-package commands. No Turborepo or Nx.

**Why no Turbo**: One package with no build step yet. The overhead of configuring Turbo's pipeline and caching isn't justified. `pnpm -r` handles topological ordering natively.

**Alternative considered**: Turborepo for caching. Deferred — easy to add later when build times warrant it.

### D5: Build system — Vite with Rolldown

Install Vite 8 (which ships Rolldown as the single unified bundler) as a shared root devDependency. No build config is created in this change — Vite is installed so it's available for Vitest 4 and ready for per-package build configs in later changes.

**Why Vite 8 + Rolldown**: Vite 8 is the first version where Rolldown fully replaces esbuild and Rollup as the default bundler. Rust-based, up to 10-30x faster builds. Handles TypeScript transformation for Vitest and will power the action bundling in the vite-plugin package.

**Why not Vite 7**: Vite 7 introduced Rolldown as opt-in. Vite 8 makes it the default. No reason to start on an older version.

### D6: Module system — ESM only

All packages use `"type": "module"` and target `ES2025`. No CJS dual-publishing. The runtime (and future sdk/vite-plugin) runs in modern Node.js (LTS) or Vite's bundler — both support ESM natively.

**Why ES2025**: The latest ECMAScript standard fully supported by Node.js 24 (V8 13.6). Includes all ES2024 features plus additions like `Set` methods, `Promise.withResolvers`, and more.

**Alternative considered**: Dual CJS/ESM output. Rejected — adds build complexity for no benefit. All consumers are modern.

## Risks / Trade-offs

- **Biome `all` rules may be noisy** → Mitigated by disabling individual rules as they surface, with comments. The first few tasks will likely reveal a handful to turn off.
- **No per-package build config yet** → The runtime package's `src/index.ts` will be a placeholder. Build configuration is deferred to feature changes. Risk: the first feature change has more setup work. Acceptable tradeoff to keep this change focused.
- **Only runtime package created** → `sdk` and `vite-plugin` are deferred. When they're needed, adding a new package is straightforward: create `packages/<name>/`, add `package.json` + `tsconfig.json`, add a reference in root `tsconfig.json`.
- **Project references add config overhead** → Each new package needs a `tsconfig.json` and an entry in the root `tsconfig.json` references array. Minimal overhead for one package. If the monorepo grows significantly, tooling like `tsconfig-paths` or a generator script could help.
