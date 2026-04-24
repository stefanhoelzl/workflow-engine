# WPT Compliance Harness Specification

## Purpose

Test-time infrastructure for running the WinterCG Minimum Common API (MCA) applicable subset of Web Platform Tests (WPT) against the QuickJS sandbox. The harness covers the vendor script, manifest contract, `spec.ts` classifier, testharness adapter, top-level-await runner, watchdog-based infinite-loop safety, and drift detection. The harness is test-only — no production sandbox surface lives in this capability.
## Requirements
### Requirement: spec.ts source of truth

The change SHALL provide `packages/sandbox/test/wpt/spec.ts` as the single human-authored classification file. It SHALL export a constant named `spec` of type `Record<string, Expectation>` where `Expectation` is `{ expected: "pass" } | { expected: "skip"; reason: string }`. Keys SHALL be either glob patterns over WPT file paths (e.g., `"fetch/api/**"`, `"**/idlharness-*.any.js"`) or file-scoped subtest overrides using the syntax `"<file-path>:<subtest-name>"` where the subtest name starts at the first colon. Patterns SHALL NOT use a catchall other than `"**"` for unclassified-default behaviour.

#### Scenario: Flat map classifies every path

- **GIVEN** `spec.ts` exports `spec`
- **WHEN** the runner looks up a path
- **THEN** it SHALL find at least one matching pattern (the `"**"` catchall at minimum)

#### Scenario: Pattern severity ordering

- **GIVEN** two patterns of equal specificity both match the same path
- **AND** one has `expected: "skip"` and the other has `expected: "pass"`
- **WHEN** the runner resolves the match
- **THEN** the `skip` entry SHALL win

### Requirement: Specificity-based match resolution

The harness SHALL export a `findMostSpecific(spec, key)` function at `packages/sandbox/test/wpt/harness/match.ts`. Specificity SHALL be computed as: `subtestBoost + literalChars`, where `subtestBoost = 1_000_000` when the pattern contains a `:` (subtest-targeted) else `0`, and `literalChars` is the count of non-wildcard characters in the file-part (wildcard characters are `*` and `?`). When multiple patterns match, the highest specificity SHALL win. On tie, severity `skip > pass` SHALL break the tie.

#### Scenario: Subtest pattern wins over file pattern

- **GIVEN** `spec` contains `"fetch/api/basic/request-init.any.js"` with `{ expected: "pass" }`
- **AND** `spec` contains `"fetch/api/basic/request-init.any.js:signal abort"` with `{ expected: "skip", reason: "..." }`
- **WHEN** `findMostSpecific(spec, "fetch/api/basic/request-init.any.js:signal abort")` is called
- **THEN** the subtest entry SHALL be returned

#### Scenario: Longer literal prefix wins

- **GIVEN** `spec` contains `"fetch/api/**"` and `"fetch/api/cors/**"`
- **WHEN** `findMostSpecific(spec, "fetch/api/cors/foo.any.js")` is called
- **THEN** the `"fetch/api/cors/**"` entry SHALL be returned

#### Scenario: Severity tie-break

- **GIVEN** two equally-specific matching patterns, one skip and one pass
- **WHEN** `findMostSpecific` resolves
- **THEN** the skip entry SHALL be returned

### Requirement: Vendor refresh script

The `pnpm test:wpt:refresh` script SHALL operate against `packages/sandbox-stdlib/test/wpt/vendor/` (relocated from `packages/sandbox/test/wpt/vendor/`). The upstream WPT suite SHALL be downloaded and vendored under this path. Related paths (harness source, skip list, runner, manifest) SHALL follow the same relocation.

#### Scenario: Refresh populates stdlib test directory

- **GIVEN** the `pnpm test:wpt:refresh` script
- **WHEN** executed
- **THEN** the WPT vendored suite SHALL be placed under `packages/sandbox-stdlib/test/wpt/vendor/`
- **AND** no files SHALL be placed under `packages/sandbox/test/wpt/`

### Requirement: Manifest JSON shape

`vendor/manifest.json` SHALL be a JSON document with top-level fields `wptSha: string`, `vendoredAt: string` (ISO timestamp), and `tests: Record<string, ManifestEntry>`. A `ManifestEntry` SHALL be exactly one of: a runnable entry `{ scripts: string[]; timeout?: "long"; skippedSubtests?: Record<string, string> }`, or a structural-skip entry `{ skip: { reason: string } }`. The manifest SHALL NOT contain full subtest inventories.

#### Scenario: Runnable entry contains dependency list

- **GIVEN** a pass-classified WPT file with META `script=/common/utils.js`
- **WHEN** `manifest.json` is generated
- **THEN** its entry SHALL contain `"scripts": ["resources/testharness.js", "common/utils.js"]`

#### Scenario: Structural skip carries reason

- **GIVEN** a WPT file whose transitive deps reference `{{host}}`
- **WHEN** `manifest.json` is generated
- **THEN** its entry SHALL be `{ "skip": { "reason": "contains {{host}} network dependency" } }`
- **AND** no `scripts` field SHALL be present

### Requirement: Vitest runner — top-level await

The WPT vitest runner SHALL be located at `packages/sandbox-stdlib/test/wpt/runner.ts` (moved from `packages/sandbox/test/wpt/runner.ts`). The runner SHALL import `createWptHarnessPlugin` from the local test utilities and compose a sandbox with plugins: `createWasiPlugin()` (inert), `createWebPlatformPlugin()`, `createFetchPlugin({ fetch: noNetworkFetch })` (mock), `createTimersPlugin()`, `createConsolePlugin()`, and `createWptHarnessPlugin({ collect })`. The runner SHALL invoke WPT tests via `sandbox.run()` and collect results via the `collect` callback.

The runner SHALL NOT use the `methods` / `onEvent` / `fetch` factory options on `sandbox()` — the new API is plugin-based (already reflected in the sandbox capability).

#### Scenario: Runner composes sandbox-stdlib plugins

- **GIVEN** the WPT runner at `packages/sandbox-stdlib/test/wpt/runner.ts`
- **WHEN** invoked by vitest
- **THEN** it SHALL import plugin factories from `@workflow-engine/sandbox-stdlib` and from its co-located test utilities
- **AND** compose a sandbox with exactly the plugins listed above
- **AND** run WPT tests via `sandbox.run()`, collecting results via the WPT harness plugin's `collect` callback

### Requirement: Per-subtest vitest registration

For each runnable file whose execution succeeded, the runner SHALL register one `describe(path)` block and, inside it, one `it(subtestName)` per observed subtest. A subtest SHALL be registered as `it.skip` iff (a) the `file:subtest` pattern in `spec.ts` resolves to `expected: "skip"`, OR (b) the manifest entry's `skippedSubtests` object contains the subtest name. Otherwise the subtest SHALL be registered as `it(...)` with an assertion that the observed status equals `"PASS"`.

#### Scenario: Pass subtest becomes passing it()

- **GIVEN** `runWpt` returns a subtest `{ name: "basic roundtrip", status: "PASS" }` for file `encoding/api-basics.any.js`
- **WHEN** the runner registers tests
- **THEN** `it("basic roundtrip")` SHALL be created inside `describe("encoding/api-basics.any.js")`
- **AND** the test body SHALL assert status === "PASS"

#### Scenario: Declared skip becomes it.skip

- **GIVEN** manifest entry has `skippedSubtests: { "JWK export RSA-OAEP": "needs wasm-ext" }`
- **WHEN** the runner registers tests
- **THEN** `it.skip("JWK export RSA-OAEP", …, { reason: "needs wasm-ext" })` SHALL be created

### Requirement: File-level skip registration

For each entry whose manifest says `skip: { reason }` OR whose spec.ts classification resolves to `expected: "skip"`, the runner SHALL register `describe.skip(path, …, { reason })`. The reason SHALL be visible in the vitest report.

#### Scenario: Structural skip reason surfaces

- **GIVEN** a manifest entry `"fetch/api/basic/stream-response.any.js": { "skip": { "reason": "contains {{host}} network dependency" } }`
- **WHEN** vitest renders the suite
- **THEN** the entry SHALL appear as skipped with the reason "contains {{host}} network dependency"

#### Scenario: Spec skip reason surfaces

- **GIVEN** `spec.ts` contains `"dom/abort/**": { expected: "skip", reason: "needs AbortController polyfill" }`
- **AND** manifest has a runnable entry for `dom/abort/abort-signal-any.any.js`
- **WHEN** vitest renders the suite
- **THEN** the file SHALL appear as skipped with reason "needs AbortController polyfill"

### Requirement: External watchdog for sandbox execution

The harness SHALL enforce a per-test execution deadline via a host-side `setTimeout` watchdog that calls `sandbox.dispose()` on expiry. The deadline SHALL be 10 seconds for normal tests and 45 seconds for tests whose manifest entry has `timeout: "long"`. Every `runWpt` invocation SHALL wrap its sandbox lifecycle in `try { … } finally { clearTimeout(watchdog); if (sb) sb.dispose(); }` so that both the timeout-kill path and the normal-completion path release the worker thread.

#### Scenario: Infinite-loop guest is force-killed

- **GIVEN** a hypothetical WPT file whose guest code enters an infinite loop
- **WHEN** 10 seconds elapse without `sb.run()` resolving
- **THEN** the watchdog SHALL call `sb.dispose()`
- **AND** `sb.dispose()` SHALL reject the pending run promise AND terminate the Node Worker thread
- **AND** the test SHALL be reported as failed (not hung)

#### Scenario: Long-test timeout honored

- **GIVEN** a manifest entry with `"timeout": "long"`
- **WHEN** the test takes 30 seconds to complete normally
- **THEN** the watchdog SHALL NOT fire
- **AND** the test SHALL complete with observed subtest results

### Requirement: Drift detection via declared-skip-never-observed

For each runnable file, the runner SHALL verify that every name in the manifest entry's `skippedSubtests` object was present in the observed subtest results. For any declared skip whose name was not observed, the runner SHALL register a synthetic failing `it()` whose error message identifies the declared subtest and suggests upstream rename.

#### Scenario: Declared skip for missing subtest is surfaced

- **GIVEN** manifest entry has `skippedSubtests: { "JWK export RSA-OAEP": "…" }`
- **AND** `runWpt` returns results that do NOT include any subtest named `"JWK export RSA-OAEP"`
- **WHEN** the runner registers tests
- **THEN** a synthetic failing `it()` SHALL be registered for the missing subtest
- **AND** its error message SHALL mention `"JWK export RSA-OAEP"` and the word "renamed" or equivalent

### Requirement: Harness never adds production sandbox surface

The WPT harness SHALL NOT install guest-callable surface that production sandboxes don't have — except via the test-only `createWptHarnessPlugin({ collect })` registered exclusively in WPT test compositions. The harness plugin installs the `__wptReport` descriptor as a private guest function; the WPT harness source captures `__wptReport` into an IIFE closure and the sandbox auto-deletes the global after phase 2.

Production sandbox compositions SHALL NOT include `createWptHarnessPlugin`.

#### Scenario: Production sandboxes have no __wptReport

- **GIVEN** any production runtime sandbox composition (no WPT harness plugin)
- **WHEN** guest code evaluates `typeof __wptReport`
- **THEN** the result SHALL be `"undefined"`

#### Scenario: Test sandbox with WPT harness plugin

- **GIVEN** a WPT test sandbox composed with `createWptHarnessPlugin({ collect })`
- **WHEN** the WPT preamble runs and reports a test result
- **THEN** the harness's captured `__wptReport` reference SHALL invoke the plugin's host-side descriptor handler
- **AND** `collect` SHALL receive `{ name, status, message? }` on the main thread

### Requirement: Test commands

The root `package.json` SHALL provide two scripts: `test:wpt` that invokes the WPT vitest suite, and `test:wpt:refresh` that invokes `scripts/wpt-refresh.ts`. The existing `test` script SHALL NOT include the WPT suite — `pnpm test` and `pnpm test:wpt` SHALL be independent.

#### Scenario: test:wpt command runs the suite

- **WHEN** a developer runs `pnpm test:wpt`
- **THEN** the WPT vitest suite SHALL execute and exit with zero on pass, non-zero on any real failure

#### Scenario: test command does not include WPT

- **WHEN** a developer runs `pnpm test`
- **THEN** only unit tests matching the existing discovery pattern SHALL run
- **AND** the WPT suite SHALL NOT execute

### Requirement: createWptHarnessPlugin factory

The sandbox-stdlib package's test utilities SHALL export a `createWptHarnessPlugin(opts: { collect: (result: { name: string; status: string; message?: string }) => void }): Plugin` factory. The plugin SHALL register a private guest function descriptor `__wptReport` whose handler invokes `opts.collect` with each reported WPT result. The `public` field SHALL be unset (default `false`) — the sandbox auto-deletes `__wptReport` from `globalThis` after Phase 2 UNLESS the WPT harness source captures it into an IIFE closure first.

#### Scenario: Harness reports WPT results via __wptReport

- **GIVEN** a WPT test running in a sandbox composed with `createWptHarnessPlugin({ collect: cb })`
- **WHEN** the test's assertion fires `__wptReport("test name", "PASS")`
- **THEN** `cb` SHALL be invoked on the main thread with `{ name: "test name", status: "PASS" }`

#### Scenario: __wptReport is private by default

- **GIVEN** a sandbox composed with `createWptHarnessPlugin({ collect: cb })`
- **WHEN** after Phase-2 source evaluation completes
- **AND** the WPT harness source captures `__wptReport` into its IIFE closure
- **THEN** `globalThis.__wptReport` SHALL be deleted at Phase 3
- **AND** test source (Phase 4) SHALL only invoke `__wptReport` via the captured reference inside the harness IIFE

