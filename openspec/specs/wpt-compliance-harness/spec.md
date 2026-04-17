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

The change SHALL provide `scripts/wpt-refresh.ts` invokable via `pnpm test:wpt:refresh [--sha <commit>] [--strict]`. The script SHALL clone `web-platform-tests/wpt` to a temporary directory (using the provided `--sha` or the latest `main`), walk the entire tree, enumerate files matching `*.any.js`, `*.any.https.js`, `*.worker.js`, `*.worker.https.js`, and process each applicable file. A file is applicable iff its META `global=` directive includes `worker`, `dedicatedworker`, `sharedworker`, `serviceworker`, or `shadowrealm`, OR `global=` is absent. Inapplicable files SHALL NOT appear in the manifest. For each applicable file, the script SHALL parse META, BFS-walk `script=` references, apply `.sub.js` template substitution with fixed placeholder values, classify via `spec.ts`, copy pass-classified files plus transitive dependencies to `packages/sandbox/test/wpt/vendor/`, and write `vendor/manifest.json`.

#### Scenario: Refresh creates vendor directory

- **GIVEN** a checkout with no `vendor/` directory
- **WHEN** a developer runs `pnpm test:wpt:refresh`
- **THEN** `packages/sandbox/test/wpt/vendor/` SHALL contain `manifest.json`, `resources/testharness.js`, and the transitive closure of pass-classified files

#### Scenario: Non-worker-scope file excluded

- **GIVEN** a WPT file with `// META: global=window`
- **WHEN** the refresh script processes it
- **THEN** the file SHALL NOT appear in `manifest.json` at all

#### Scenario: Pinned commit via --sha

- **GIVEN** a command `pnpm test:wpt:refresh --sha abc123`
- **WHEN** the script runs
- **THEN** it SHALL clone the upstream repo at commit `abc123`
- **AND** `manifest.json` SHALL record `"wptSha": "abc123..."`

#### Scenario: Strict mode fails on missing spec-referenced subtests

- **GIVEN** `spec.ts` declares a skip for `"file.any.js:subtest X"`
- **AND** the upstream file at `file.any.js` no longer contains any subtest named `"subtest X"` (e.g., file was removed, or static parse heuristic flags it)
- **WHEN** a developer runs `pnpm test:wpt:refresh --strict`
- **THEN** the script SHALL exit with non-zero status

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

The harness SHALL provide `packages/sandbox/test/wpt/wpt.test.ts` that uses the top-level-await pattern. It SHALL import the manifest and `spec.ts` synchronously, partition entries into runnable vs skipped, `await limitedAll(tasks, CONCURRENCY)` where `CONCURRENCY = max(4, os.availableParallelism() * 2)` overridable via the `WPT_CONCURRENCY` environment variable, then synchronously register `describe` and `it` nodes from observed results. The runner SHALL NOT use `async describe` callbacks or `beforeAll`-based dynamic test generation.

#### Scenario: Concurrency default scales with cores

- **GIVEN** a 8-core machine with `os.availableParallelism() === 8` and no `WPT_CONCURRENCY` env var
- **WHEN** the runner starts
- **THEN** the concurrency limit SHALL be 16

#### Scenario: Concurrency env override

- **GIVEN** `WPT_CONCURRENCY=4` in the environment
- **WHEN** the runner starts
- **THEN** the concurrency limit SHALL be 4

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

The WPT harness package SHALL NOT register any host method, global, or bridge on the sandbox except via per-run `extraMethods` to `sandbox.run()`. Specifically, `__wptReport` SHALL only be installed per-run at test time. No production sandbox consumer SHALL have access to `__wptReport`.

#### Scenario: __wptReport absent in production

- **GIVEN** a production sandbox constructed without `extraMethods` containing `__wptReport`
- **WHEN** guest code attempts to call `__wptReport(...)`
- **THEN** a `ReferenceError` SHALL be thrown

#### Scenario: __wptReport available only during WPT runs

- **GIVEN** a WPT test run via `sandbox.run("__wptEntry", {}, { extraMethods: { __wptReport } })`
- **WHEN** guest code calls `__wptReport(name, status, message)`
- **THEN** the host-side implementation provided via extraMethods SHALL receive the call

### Requirement: Test commands

The root `package.json` SHALL provide two scripts: `test:wpt` that invokes the WPT vitest suite, and `test:wpt:refresh` that invokes `scripts/wpt-refresh.ts`. The existing `test` script SHALL NOT include the WPT suite — `pnpm test` and `pnpm test:wpt` SHALL be independent.

#### Scenario: test:wpt command runs the suite

- **WHEN** a developer runs `pnpm test:wpt`
- **THEN** the WPT vitest suite SHALL execute and exit with zero on pass, non-zero on any real failure

#### Scenario: test command does not include WPT

- **WHEN** a developer runs `pnpm test`
- **THEN** only unit tests matching the existing discovery pattern SHALL run
- **AND** the WPT suite SHALL NOT execute
