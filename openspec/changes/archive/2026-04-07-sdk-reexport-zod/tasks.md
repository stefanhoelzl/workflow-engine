## 1. SDK

- [x] 1.1 Add `export { z } from "zod"` to `packages/sdk/src/index.ts`

## 2. Runtime

- [x] 2.1 Update `sample.ts` to import `z` from `@workflow-engine/sdk` instead of `zod`
- [x] 2.2 Remove `zod` from `packages/runtime/package.json` dependencies

## 3. Verification

- [x] 3.1 Verify `pnpm lint` passes
- [x] 3.2 Verify `pnpm check` passes
- [x] 3.3 Verify `pnpm test` passes
