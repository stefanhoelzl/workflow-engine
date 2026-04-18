## Why

The sandbox lacks `URLPattern`, a WinterCG Minimum Common API global the runtime targets. The entire `urlpattern/**` WPT subtree is currently glob-skipped in `packages/sandbox/test/wpt/skip.ts:96` with reason `"needs URLPattern polyfill"`. Shipping a pure-JS polyfill closes the WinterCG gap, unblocks ~7 WPT files, and introduces no new host-bridge surface. The `virtual:sandbox-polyfills` Vite plugin added in `2026-04-18-sandbox-event-target` provides the integration scaffolding — adding URLPattern is now a three-line change plus documentation.

## What Changes

- Add `urlpattern-polyfill@10.0.0` (exact pin, MIT, zero runtime deps, pure JS) as a `@workflow-engine/sandbox` dependency.
- Add `import "urlpattern-polyfill";` as the final line of `packages/sandbox/src/polyfills/entry.ts`. The polyfill's own `index.js` self-installs `globalThis.URLPattern` behind a feature-detect guard (`if (!globalThis.URLPattern)`), so no wrapper file is needed.
- Add `"URLPattern"` to the `RESERVED_BUILTIN_GLOBALS` set in `packages/sandbox/src/index.ts`. This lets the existing collision check at line 189 reject `extraMethods: { URLPattern: … }` at sandbox-construction time, matching every other shim global.
- Extend the existing shadow-rejection test at `packages/sandbox/src/sandbox.test.ts:1374` to include `"URLPattern"` in its iteration array.
- Delete the `"urlpattern/**": "needs URLPattern polyfill"` line from `packages/sandbox/test/wpt/skip.ts`. Pass becomes implicit. Classify any concrete per-subtest failures surfaced by the trial run with specific non-polyfill reasons (`skip.ts`'s stated convention: `grep '"needs .* polyfill"' skip.ts` must not match any `urlpattern/` line after the change).
- Amend `/SECURITY.md §2` allowlist with a single-line `URLPattern` enumeration entry. The entry names the pinned polyfill version, quotes the polyfill's install line verbatim, and documents the residual risk class as identical to the already-exposed `RegExp`: pattern-side user input can trigger catastrophic regex backtracking in QuickJS's engine, bounded to the invoking workflow's own worker thread by per-workflow worker_thread isolation.
- Amend `openspec/specs/sandbox/spec.md`: modify `Isolation — no Node.js surface` to list `URLPattern` among the guest-side shims; add `Safe globals — URLPattern` requirement with scenarios covering constructability, `exec()` named-group capture, and `test()`.

## Capabilities

### New Capabilities

_(none — all additions extend the existing sandbox capability)_

### Modified Capabilities

- `sandbox`: add `Safe globals — URLPattern` requirement with scenarios; amend the `Isolation — no Node.js surface` allowlist enumeration to list `URLPattern` alongside the other shim-installed globals.

## Impact

- **Code**:
  - Edits: `packages/sandbox/src/polyfills/entry.ts` (+1 import line), `packages/sandbox/src/index.ts` (+1 entry in `RESERVED_BUILTIN_GLOBALS`), `packages/sandbox/src/sandbox.test.ts` (extend array at line 1374), `packages/sandbox/test/wpt/skip.ts` (delete `urlpattern/**` line; add per-subtest entries only for concrete failures).
  - `packages/sandbox/package.json`: add `"urlpattern-polyfill": "10.0.0"` (exact pin, not caret — §2 allowlist audit is version-specific).
- **Security**: `SECURITY.md §2` amended with one new allowlist entry. No new host-bridge surface; pure compute inside the existing `virtual:sandbox-polyfills` IIFE. Risk class is identical to the already-allowlisted `RegExp`: guest-crafted URL patterns can trigger catastrophic regex backtracking in QuickJS's engine, bounded to the invoking workflow's own worker thread by per-workflow worker_thread isolation. No new capability to affect other workflows or the host main thread.
- **Build**: no build-system changes. The existing `sandboxPolyfills()` Vite plugin resolves `urlpattern-polyfill` via `nodeResolve` (prefers ESM `./index.js` over CJS `./index.cjs`); `rollup-plugin-esbuild` with `target: "es2022"` preserves the polyfill's private class fields (compatible with QuickJS-NG 2.2.0).
- **Dependencies**: `urlpattern-polyfill@10.0.0` (runtime dep, MIT, no transitive deps). Exact version pinned rather than caret-ranged — version bumps trigger their own §2 re-audit PR.
- **Tests**: WPT `urlpattern/**` subtree now runs. Unit tests: extend the one existing shadow-rejection iteration; no new behavioral unit tests (WPT owns behavioral coverage, matching the Apr 18 event-target change's precedent of pruning pure-spec duplicates from `sandbox.test.ts`).
- **Out of scope**: wiring a QuickJS `interruptHandler` to bound long-running guest execution. This is a pre-existing sandbox gap (the sandbox installs no interrupt handler today; `currentAbort` in `worker.ts:208` is fetch-level only) that applies equally to `RegExp` and `while(true){}`. Addressing it is a separate change.
