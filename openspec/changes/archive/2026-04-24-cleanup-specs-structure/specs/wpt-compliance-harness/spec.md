## ADDED Requirements

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
