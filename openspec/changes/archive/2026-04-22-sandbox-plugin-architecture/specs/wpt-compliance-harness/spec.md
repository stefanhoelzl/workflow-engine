## MODIFIED Requirements

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

### Requirement: Vitest runner — top-level await

The WPT vitest runner SHALL be located at `packages/sandbox-stdlib/test/wpt/runner.ts` (moved from `packages/sandbox/test/wpt/runner.ts`). The runner SHALL import `createWptHarnessPlugin` from the local test utilities and compose a sandbox with plugins: `createWasiPlugin()` (inert), `createWebPlatformPlugin()`, `createFetchPlugin({ fetch: noNetworkFetch })` (mock), `createTimersPlugin()`, `createConsolePlugin()`, and `createWptHarnessPlugin({ collect })`. The runner SHALL invoke WPT tests via `sandbox.run()` and collect results via the `collect` callback.

The runner SHALL NOT use the `methods` / `onEvent` / `fetch` factory options on `sandbox()` — the new API is plugin-based (already reflected in the sandbox capability).

#### Scenario: Runner composes sandbox-stdlib plugins

- **GIVEN** the WPT runner at `packages/sandbox-stdlib/test/wpt/runner.ts`
- **WHEN** invoked by vitest
- **THEN** it SHALL import plugin factories from `@workflow-engine/sandbox-stdlib` and from its co-located test utilities
- **AND** compose a sandbox with exactly the plugins listed above
- **AND** run WPT tests via `sandbox.run()`, collecting results via the WPT harness plugin's `collect` callback

### Requirement: Vendor refresh script

The `pnpm test:wpt:refresh` script SHALL operate against `packages/sandbox-stdlib/test/wpt/vendor/` (relocated from `packages/sandbox/test/wpt/vendor/`). The upstream WPT suite SHALL be downloaded and vendored under this path. Related paths (harness source, skip list, runner, manifest) SHALL follow the same relocation.

#### Scenario: Refresh populates stdlib test directory

- **GIVEN** the `pnpm test:wpt:refresh` script
- **WHEN** executed
- **THEN** the WPT vendored suite SHALL be placed under `packages/sandbox-stdlib/test/wpt/vendor/`
- **AND** no files SHALL be placed under `packages/sandbox/test/wpt/`
