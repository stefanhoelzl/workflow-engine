## 1. Monorepo Structure

- [x] 1.1 Create `pnpm-workspace.yaml` with `packages: ["packages/*"]`
- [x] 1.2 Update root `package.json` with `devEngines` (Node.js >=24.0.0, `onFail: "download"`), `type: "module"`, workspace scripts (`check`, `lint`, `format`, `test`), and devDependencies (`typescript` 6.x, `@biomejs/biome` 2.x, `vitest` 4.x, `vite` 8.x)
- [x] 1.3 Create `packages/runtime/package.json` with name `@workflow-engine/runtime`, `type: "module"`
- [x] 1.4 Create placeholder `packages/runtime/src/index.ts`
- [x] 1.5 Update `.gitignore` to include `dist/` and `*.tsbuildinfo`

## 2. TypeScript Configuration

- [x] 2.1 Create `tsconfig.base.json` with strict settings: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noEmit`, `isolatedModules`, `verbatimModuleSyntax`, target `ES2025`, module `NodeNext`
- [x] 2.2 Create root `tsconfig.json` with project reference to `packages/runtime`
- [x] 2.3 Create `packages/runtime/tsconfig.json` extending base, with `composite`, `declaration`, `include: ["src"]`, `outDir: "dist"`
- [x] 2.4 Verify `pnpm check` runs `tsc --build` and reports no errors

## 3. Linting and Formatting

- [x] 3.1 Create `biome.json` with `linter.rules.all: true`, formatter enabled, ignore `node_modules` and `dist`
- [x] 3.2 Wire root `lint` script to `biome lint .`
- [x] 3.3 Wire root `format` script to `biome format --write .`
- [x] 3.4 Verify `pnpm lint` passes on the placeholder files
- [x] 3.5 Disable any Biome rules that conflict with the placeholder scaffolding (document reasons)

## 4. Testing Setup

- [x] 4.1 Create `vitest.config.ts` at root with test file patterns for `packages/*/src/**/*.{test,spec}.ts`
- [x] 4.2 Wire root `test` script to `vitest run`
- [x] 4.3 Verify `pnpm test` exits successfully with zero tests

## 5. Validation

- [x] 5.1 Run `pnpm install` and verify the runtime workspace package is linked
- [x] 5.2 Run `pnpm check` and verify zero type errors
- [x] 5.3 Run `pnpm lint` and verify zero violations
- [x] 5.4 Run `pnpm test` and verify clean exit
