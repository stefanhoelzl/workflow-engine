## 1. Rename and extend schema preparation

- [x] 1.1 Rename `simplifyNullable` to `prepareSchema` in `packages/runtime/src/trigger/middleware.ts`
- [x] 1.2 Add example-to-default promotion: in the recursive walk, if `obj.example` is set and `obj.default` is not, copy `example` into `default`
- [x] 1.3 Export `prepareSchema` for testing

## 2. Unit tests for prepareSchema

- [x] 2.1 Test: field with example and no default → default is set to example value
- [x] 2.2 Test: field with both example and existing default → default is preserved
- [x] 2.3 Test: field with no example → no default added
- [x] 2.4 Test: nested object properties → examples promoted at all depths
- [x] 2.5 Test: nullable simplification still works (existing behavior)
- [x] 2.6 Test: nullable + example combined → both transformations applied

## 3. Verification

- [x] 3.1 Run `pnpm lint`, `pnpm check`, and `pnpm test` — all must pass
