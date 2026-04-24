# WPT Compliance Harness Specification

## Purpose

Test-time infrastructure for running the WinterCG Minimum Common API (MCA) applicable subset of Web Platform Tests (WPT) against the QuickJS sandbox. The harness covers the vendor script, manifest contract, `skip.ts` classifier, testharness adapter, top-level-await runner, watchdog-based infinite-loop safety, and drift detection. The harness is test-only — no production sandbox surface lives in this capability.
## Requirements
### Requirement: skip.ts source of truth

The change SHALL provide `packages/sandbox-stdlib/test/wpt/skip.ts` as the single human-authored classification file. It SHALL export a constant of type `Record<string, string>` where the value is a human-readable skip reason. Pass is implicit: any applicable vendored file (per the manifest) that is not matched by a `skip.ts` entry is expected to pass. Keys SHALL be either exact WPT file paths, glob patterns over WPT file paths (e.g., `"fetch/api/**"`, `"**/idlharness-*.any.js"`), or file-scoped subtest overrides using the syntax `"<file-path>:<subtest-name>"` where the subtest name starts at the first colon. The map intentionally has no pass entries — a glob skip swallows every file underneath, so narrowing requires expanding the glob into per-file entries first.

#### Scenario: Unmatched path runs as expected-pass

- **GIVEN** `skip.ts` exports the skip map
- **WHEN** the runner looks up a path that no entry matches
- **THEN** `findReason` SHALL return `null`
- **AND** the file SHALL be registered as a runnable test expected to pass

#### Scenario: Subtest override lives alongside file-level entries

- **GIVEN** `skip.ts` contains `"WebCryptoAPI/foo.any.js:specific subtest": "needs wasm-ext XYZ feature"`
- **WHEN** the runner resolves the subtest
- **THEN** that subtest SHALL be registered as `it.skip` with the given reason
- **AND** the remaining subtests of the same file SHALL still execute

### Requirement: Most-specific match resolution

The harness SHALL export a `findReason(skip, key)` function at `packages/sandbox-stdlib/test/wpt/harness/match.ts`. Lookup SHALL be most-specific wins: an exact literal-key match SHALL be preferred, and in its absence the first matching glob entry SHALL be returned. Glob patterns SHALL support `*` (matches any run of non-slash characters) and `**` (matches any run including slashes). Subtest-qualified patterns (`"<file>:<subtest>"`) SHALL only match a key that carries a subtest segment, and the subtest name SHALL be matched literally (no glob). Callers that need the declared-subtest inventory for a given file SHALL use `declaredSubtestSkips(skip, path)`; drift detection between declared and observed subtests SHALL use `findMissingSubtestSkips(declared, observed)`.

#### Scenario: Exact key wins over glob

- **GIVEN** `skip` contains `"fetch/api/basic/request-init.any.js": "pinned"` and `"fetch/api/**": "broad"`
- **WHEN** `findReason(skip, "fetch/api/basic/request-init.any.js")` is called
- **THEN** it SHALL return `"pinned"`

#### Scenario: Subtest pattern requires subtest segment

- **GIVEN** `skip` contains `"fetch/api/basic/request-init.any.js:signal abort": "needs AbortSignal wiring"`
- **WHEN** `findReason(skip, "fetch/api/basic/request-init.any.js")` is called with the file-only key
- **THEN** the subtest pattern SHALL NOT match
- **AND** `findReason(skip, "fetch/api/basic/request-init.any.js:signal abort")` SHALL return `"needs AbortSignal wiring"`

#### Scenario: Glob fallback matches transitive paths

- **GIVEN** `skip` contains `"fetch/api/**": "needs Request polyfill"`
- **WHEN** `findReason(skip, "fetch/api/cors/foo.any.js")` is called
- **THEN** it SHALL return `"needs Request polyfill"`

### Requirement: Vendor refresh script

The `pnpm test:wpt:refresh` script SHALL operate against `packages/sandbox-stdlib/test/wpt/vendor/`. The upstream WPT suite SHALL be downloaded and vendored under this path. Related paths (harness source, skip list, runner, manifest) SHALL live under `packages/sandbox-stdlib/test/wpt/`.

#### Scenario: Refresh populates stdlib test directory

- **GIVEN** the `pnpm test:wpt:refresh` script
- **WHEN** executed
- **THEN** the WPT vendored suite SHALL be placed under `packages/sandbox-stdlib/test/wpt/vendor/`

### Requirement: Manifest JSON shape

`vendor/manifest.json` SHALL be a JSON document with top-level fields `wptSha: string`, `vendoredAt: string` (ISO timestamp), and `tests: Record<string, ManifestEntry>`. A `ManifestEntry` SHALL be exactly one of: a runnable entry `{ scripts: string[]; timeout?: "long" }`, or a structural-skip entry `{ skip: { reason: string } }`. Structural skips are reserved for files whose transitive deps reference unresolvable template placeholders such as `{{host}}` / `{{ports}}`; spec-level skips (polyfill gaps, intentionally-unsupported features) live in `skip.ts` and are applied at runtime. The manifest SHALL NOT contain any subtest inventory — subtest names are observed at runtime.

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

The WPT vitest runner SHALL be located at `packages/sandbox-stdlib/test/wpt/harness/runner.ts`. The runner SHALL compose a sandbox with plugins: the `wasi-plugin` (inert), `web-platform` plugin (imported from `@workflow-engine/sandbox-stdlib`), `fetch` plugin (mock / no-network), `timers` plugin, `console` plugin, and a test-only `WPT_HARNESS_PLUGIN` descriptor that registers `__wptReport`. The runner SHALL invoke WPT tests via `sandbox.run()` and collect results via the sandbox's `onEvent` listener filtering for the `wpt.report` event kind emitted by the harness plugin.

The runner SHALL NOT use the `methods` / `onEvent` / `fetch` factory options on `sandbox()` — the new API is plugin-based (already reflected in the sandbox capability).

#### Scenario: Runner composes sandbox-stdlib plugins

- **GIVEN** the WPT runner at `packages/sandbox-stdlib/test/wpt/harness/runner.ts`
- **WHEN** invoked by vitest
- **THEN** it SHALL import `sandbox` plus plugin sources from `@workflow-engine/sandbox` and `@workflow-engine/sandbox-stdlib`
- **AND** compose a sandbox with the plugin set listed above
- **AND** run WPT tests via `sandbox.run()`, collecting `wpt.report` events via `sb.onEvent(...)`

### Requirement: Per-subtest vitest registration

For each runnable file whose execution succeeded, the runner SHALL register one `describe(path)` block and, inside it, one `it(subtestName)` per observed subtest. A subtest SHALL be registered as `it.skip` iff the `file:subtest` key resolves via `findReason(skip, "<file>:<subtest>")` to a non-null reason. Otherwise the subtest SHALL be registered as `it(...)` with an assertion that the observed status equals `"PASS"`.

#### Scenario: Pass subtest becomes passing it()

- **GIVEN** `runWpt` returns a subtest `{ name: "basic roundtrip", status: "PASS" }` for file `encoding/api-basics.any.js`
- **WHEN** the runner registers tests
- **THEN** `it("basic roundtrip")` SHALL be created inside `describe("encoding/api-basics.any.js")`
- **AND** the test body SHALL assert status === "PASS"

#### Scenario: Declared skip becomes it.skip

- **GIVEN** `skip.ts` contains `"WebCryptoAPI/foo.any.js:JWK export RSA-OAEP": "needs wasm-ext"`
- **AND** the observed subtest list for the file includes `"JWK export RSA-OAEP"`
- **WHEN** the runner registers tests
- **THEN** an `it.skip` entry SHALL be created for that subtest with the recorded reason

### Requirement: File-level skip registration

For each entry whose manifest says `skip: { reason }` OR whose `skip.ts` lookup via `findReason(skip, path)` returns a non-null reason, the runner SHALL register `describe(path)` containing a single `it.skip` whose label carries the skip reason. The reason SHALL be visible in the vitest report.

#### Scenario: Structural skip reason surfaces

- **GIVEN** a manifest entry `"fetch/api/basic/stream-response.any.js": { "skip": { "reason": "contains {{host}} network dependency" } }`
- **WHEN** vitest renders the suite
- **THEN** the entry SHALL appear as skipped with the reason "contains {{host}} network dependency"

#### Scenario: skip.ts skip reason surfaces

- **GIVEN** `skip.ts` contains `"dom/abort/**": "needs AbortController polyfill"`
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

For each runnable file, the runner SHALL verify that every subtest-qualified key declared in `skip.ts` for that file (obtained via `declaredSubtestSkips(skip, path)`) was present in the observed subtest results. For any declared skip whose name was not observed (computed via `findMissingSubtestSkips(declared, observed)`), the runner SHALL register a synthetic failing `it()` whose error message identifies the declared subtest and suggests an upstream rename.

#### Scenario: Declared skip for missing subtest is surfaced

- **GIVEN** `skip.ts` contains `"WebCryptoAPI/foo.any.js:JWK export RSA-OAEP": "…"`
- **AND** `runWpt` returns results for `WebCryptoAPI/foo.any.js` that do NOT include any subtest named `"JWK export RSA-OAEP"`
- **WHEN** the runner registers tests
- **THEN** a synthetic failing `it()` SHALL be registered for the missing subtest
- **AND** its error message SHALL mention `"JWK export RSA-OAEP"` and the word "renamed" or equivalent

### Requirement: Harness never adds production sandbox surface

The WPT harness SHALL NOT install guest-callable surface that production sandboxes don't have — except via the test-only `WPT_HARNESS_PLUGIN` descriptor registered exclusively in WPT test compositions. The harness plugin installs a `__wptReport(name, status, message)` guest function descriptor whose `log.event` is `"wpt.report"`; every call emits one event that the host picks up on `sb.onEvent`.

Production sandbox compositions SHALL NOT include `WPT_HARNESS_PLUGIN`.

#### Scenario: Production sandboxes have no __wptReport

- **GIVEN** any production runtime sandbox composition (no WPT harness plugin)
- **WHEN** guest code evaluates `typeof __wptReport`
- **THEN** the result SHALL be `"undefined"`

#### Scenario: Test sandbox with WPT harness plugin

- **GIVEN** a WPT test sandbox composed with `WPT_HARNESS_PLUGIN`
- **WHEN** the WPT preamble runs and reports a subtest result
- **THEN** the guest call `__wptReport(name, status, message)` SHALL emit a `wpt.report` event whose `input` is `[name, status, message]`
- **AND** the host `sb.onEvent` listener SHALL receive that event on the main thread and accumulate it as a `SubtestResult`

### Requirement: Test commands

The root `package.json` SHALL provide two scripts: `test:wpt` that invokes the WPT vitest suite, and `test:wpt:refresh` that invokes `scripts/wpt-refresh.ts`. The existing `test` script SHALL NOT include the WPT suite — `pnpm test` and `pnpm test:wpt` SHALL be independent.

#### Scenario: test:wpt command runs the suite

- **WHEN** a developer runs `pnpm test:wpt`
- **THEN** the WPT vitest suite SHALL execute and exit with zero on pass, non-zero on any real failure

#### Scenario: test command does not include WPT

- **WHEN** a developer runs `pnpm test`
- **THEN** only unit tests matching the existing discovery pattern SHALL run
- **AND** the WPT suite SHALL NOT execute

### Requirement: WPT_HARNESS_PLUGIN descriptor

The harness source at `packages/sandbox-stdlib/test/wpt/harness/runner.ts` SHALL define an inline `WPT_HARNESS_PLUGIN: PluginDescriptor` whose worker source registers a guest function descriptor named `__wptReport` taking `(string, string, string)` and returning `void`. The descriptor's `log.event` SHALL be `"wpt.report"` so every invocation emits a leaf event on the event bus. The host SHALL subscribe via `sb.onEvent`, filter for `event.kind === "wpt.report"`, and accumulate the input tuple as a `SubtestResult`. `WPT_HARNESS_PLUGIN` SHALL only appear in the WPT runner composition — production sandbox composition SHALL never include it.

#### Scenario: Harness reports WPT results via __wptReport

- **GIVEN** a WPT test running in a sandbox composed with `WPT_HARNESS_PLUGIN`
- **WHEN** guest code calls `__wptReport("test name", "PASS", "")`
- **THEN** a `wpt.report` event SHALL be emitted with `input = ["test name", "PASS", ""]`
- **AND** the runner's `onEvent` listener SHALL push a matching `SubtestResult` on the main thread

