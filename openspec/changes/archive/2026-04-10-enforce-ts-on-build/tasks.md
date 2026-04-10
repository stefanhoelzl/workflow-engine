## 1. Plugin Dependencies

- [x] 1.1 Add `typescript` as peer dependency (`>=5.0.0`) in `packages/vite-plugin/package.json`

## 2. Type Checking Implementation

- [x] 2.1 Add `buildStart` hook to `workflowPlugin` that detects watch mode via `config.build.watch` and skips type checking if set
- [x] 2.2 Define hardcoded compiler options matching the strict tsconfig (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax, noEmit, isolatedModules, skipLibCheck, target esnext, module/moduleResolution NodeNext)
- [x] 2.3 Resolve workflow entry paths against Vite root and pass as `rootNames` to `ts.createProgram`
- [x] 2.4 Call `ts.getPreEmitDiagnostics`, format errors with `ts.formatDiagnosticsWithColorAndContext`, and throw to fail the build if any diagnostics are found

## 3. Testing

- [x] 3.1 Add test: production build fails when a workflow has a type error
- [x] 3.2 Add test: production build succeeds when workflows are type-correct
- [x] 3.3 Add test: type checking is skipped in watch mode
