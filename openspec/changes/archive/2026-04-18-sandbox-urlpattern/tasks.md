## 1. Dependency

- [x] 1.1 Add `"urlpattern-polyfill": "10.0.0"` (exact pin, not caret) to `dependencies` in `packages/sandbox/package.json`
- [x] 1.2 Run `pnpm install` and verify `urlpattern-polyfill@10.0.0` resolves with no peer-dep warnings; confirm `pnpm-lock.yaml` pins the expected tarball hash

## 2. Polyfill wiring

- [x] 2.1 Append `import "urlpattern-polyfill";` as the final line of `packages/sandbox/src/polyfills/entry.ts`, below the existing `./fetch.js` import. Include a short comment pointing at the polyfill's own `index.js` install semantics and at `SECURITY.md §2` for the allowlist rationale
- [x] 2.2 Run `pnpm --filter @workflow-engine/sandbox build` and confirm `dist/src/worker.js` rebuilds cleanly (rollup+nodeResolve+esbuild resolve the polyfill's ESM entry; no "unexpected top-level await" or similar bundler errors)

## 3. Reserved globals

- [x] 3.1 Add `"URLPattern",` to the `RESERVED_BUILTIN_GLOBALS` set in `packages/sandbox/src/index.ts` (around line 75, alphabetically or at the end of the list — match existing ordering convention)
- [x] 3.2 Extend the iteration array in the test `"reserved globals reject extraMethods that would shadow …"` at `packages/sandbox/src/sandbox.test.ts:1374` to include `"URLPattern"`; update the test title to list URLPattern among the examples
- [x] 3.3 Run the extended test in isolation and confirm it passes (`pnpm --filter @workflow-engine/sandbox test -- --testNamePattern "reserved globals"`)

## 4. WPT classification

- [x] 4.1 Delete the line `"urlpattern/**": "needs URLPattern polyfill",` from `packages/sandbox/test/wpt/skip.ts` (currently at line 96)
- [x] 4.2 Run `pnpm test:wpt:refresh` to re-materialize vendor files now that `urlpattern/**` is implicitly-pass-classified
- [x] 4.3 Run `WPT_CONCURRENCY=1 pnpm test:wpt` and triage the `urlpattern/**` results. For every failing file or subtest, add an entry to `skip.ts` with a **concrete non-polyfill-gap reason** (e.g. `"polyfill diverges from spec on <X>"`). Verify `grep '"needs .* polyfill"' skip.ts` matches no `urlpattern/` line after the change
- [x] 4.4 Re-run `WPT_CONCURRENCY=1 pnpm test:wpt` and confirm the suite is green (all non-skipped `urlpattern/**` subtests pass)

## 5. SECURITY.md §2

- [x] 5.1 Append a single-line URLPattern entry to the "Globals exposed inside the sandbox" enumeration in `/SECURITY.md §2`, alongside the other guest-side shim entries. The entry SHALL: name the pinned polyfill version (`urlpattern-polyfill@10.0.0`); identify the bundle path (part of the `virtual:sandbox-polyfills` IIFE resolved by `sandboxPolyfills()`); quote the polyfill's install line verbatim (`if (!globalThis.URLPattern) globalThis.URLPattern = URLPattern;`) so the §2 reader does not need to open `node_modules/` to audit; document the residual risk class as identical to the already-exposed `RegExp` (pattern-side user input can trigger catastrophic regex backtracking in QuickJS's engine, bounded to the invoking workflow's worker thread by per-workflow worker_thread isolation; no new attacker capability over existing `RegExp`)
- [x] 5.2 Do NOT add a standalone residual-risk paragraph. The enumeration-entry parenthetical is the whole treatment (per design.md Decision 6)

## 6. Sandbox spec

- [x] 6.1 Apply the MODIFIED `Isolation — no Node.js surface` requirement from `openspec/changes/sandbox-urlpattern/specs/sandbox/spec.md` to `openspec/specs/sandbox/spec.md` at archive time via `openspec archive`
- [x] 6.2 Apply the ADDED `Safe globals — URLPattern` requirement at archive time — placed near the other `Safe globals — …` requirements (currently near line 494 onward in the canonical spec)
- [x] 6.3 Run `pnpm exec openspec validate sandbox-urlpattern --strict` and confirm the change passes validation

## 7. Validation

- [x] 7.1 `pnpm lint` — Biome clean
- [x] 7.2 `pnpm check` — tsc clean (the polyfill ships `types: "./dist/index.d.ts"`, so guest-side `URLPattern` type is ambient without manual `.d.ts` additions)
- [x] 7.3 `pnpm test` — unit suite green including the extended shadow-rejection test
- [x] 7.4 `WPT_CONCURRENCY=1 pnpm test:wpt` — re-run after any `skip.ts` additions from 4.3 to confirm stable
- [x] 7.5 `pnpm validate` — definition-of-done (all concurrent jobs green)

## 8. Archive

- [x] 8.1 Use `openspec archive` to move the change folder to `openspec/changes/archive/<date>-sandbox-urlpattern/`, applying the spec deltas to the canonical `openspec/specs/sandbox/spec.md`
