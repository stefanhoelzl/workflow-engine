## Why

The QuickJS sandbox targets the WinterCG Minimum Common API (MCA), but today we have no systematic way to measure compliance. Users hit library breakages only at runtime, and there is no artifact that answers "which MCA surfaces work and which are missing?". We need a reproducible, subtest-granular coverage report against Web Platform Tests (WPT) — both to drive the polyfill roadmap and to catch regressions when the sandbox changes.

## What Changes

- **Add a WPT compliance harness** at `packages/sandbox/test/wpt/` that runs every worker-scope WPT test inside the sandbox and reports results per subtest.
- **Add a vendor script** `scripts/wpt-refresh.ts` that clones upstream WPT, walks the tree, applies `META: global=` + spec-classifier rules, and produces `vendor/manifest.json` plus the transitive closure of runnable test files.
- **Add two pnpm commands**: `test:wpt` (run the suite) and `test:wpt:refresh` (regenerate the vendor).
- **Add three production globals to the sandbox**: `globalThis.self`, `globalThis.navigator.userAgent`, `globalThis.reportError` (host-bridged). All three are MCA requirements. **BREAKING**: guest code that previously relied on these being absent would now observe them.
- **Add one host-bridge method**: `__reportError`, installed at sandbox construction via the `methods` parameter. Test-time override via per-run `extraMethods`.
- **Amend `SECURITY.md §2`**: soften the absolute-NEVER wording to "NEVER without extending the allowlist in the same PR". Add allowlist entries for the four new surfaces.
- **Update `CLAUDE.md` Security Invariants line** in lockstep.
- **Update `RESERVED_BUILTIN_GLOBALS`** in `packages/sandbox/src/index.ts` to match the new allowlist.
- **Add a lean flat-map `spec.ts`** classifying every WPT test pattern as `pass` or `skip` (with reason). Uses specificity-based pattern matching (`skip > pass` severity tiebreak).

## Capabilities

### New Capabilities

- `wpt-compliance-harness`: Test-time infrastructure for running the WinterCG MCA-applicable WPT subset against the QuickJS sandbox. Covers the vendor script, manifest contract, spec.ts classifier, testharness adapter, top-level-await runner, watchdog-based infinite-loop safety, and drift detection. Test-only — no production sandbox surface lives in this capability.

### Modified Capabilities

- `sandbox`: Adds three MCA-mandated globals (`globalThis.self`, `globalThis.navigator`, `globalThis.reportError`) and one host-bridge method (`__reportError`). Expands `RESERVED_BUILTIN_GLOBALS`. Tightens §2 allowlist wording so the allowlist is explicitly authoritative.

## Impact

- **`packages/sandbox/src/globals.ts`**: new constants for the three shims + wiring of `__reportError` bridge.
- **`packages/sandbox/src/worker.ts`**: installs the shims at VM init.
- **`packages/sandbox/src/index.ts`**: `RESERVED_BUILTIN_GLOBALS` gains four entries.
- **`packages/sandbox/test/wpt/`** (new): spec.ts, vendor/ (regenerated), harness/ (preamble, match, composer, testharness adapter, watchdog, limitedAll), wpt.test.ts.
- **`scripts/wpt-refresh.ts`** (new): clones WPT, resolves META, emits manifest.json.
- **`SECURITY.md`**: §2 wording amendment + four allowlist entries.
- **`CLAUDE.md`**: Security Invariants line updated.
- **`package.json`** (root + `packages/sandbox`): new `test:wpt` + `test:wpt:refresh` scripts.
- **Runtime effect on production**: negligible. Three new globals with null capability (self is identity, navigator is a frozen static string, reportError forwards write-only to host logger). One bridge with risk class equivalent to `console.log`.
- **No new dependencies** this round. `web-streams-polyfill`, `urlpattern-polyfill`, `pako`, etc. are deferred to follow-up rounds; the harness infrastructure surfaces them as the next worklist but does not land them.
- **No CI integration** this round. Runs locally via `pnpm test:wpt`; CI gating deferred.
