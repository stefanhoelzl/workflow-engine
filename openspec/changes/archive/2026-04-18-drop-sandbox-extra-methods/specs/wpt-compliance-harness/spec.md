## MODIFIED Requirements

### Requirement: Harness never adds production sandbox surface

The WPT harness package SHALL pass `__wptReport` only via the construction-time `methods` argument of its own `sandbox(...)` call in `packages/sandbox/test/wpt/harness/runner.ts`. No production sandbox construction site SHALL pass `__wptReport` in `methods`. `__wptReport` SHALL NOT be installed on any production sandbox by any other mechanism.

#### Scenario: __wptReport absent in production

- **GIVEN** a production sandbox constructed via `sandbox(source, methods, options)` where `methods` does not contain `__wptReport`
- **WHEN** guest code attempts to call `__wptReport(...)`
- **THEN** a `ReferenceError` SHALL be thrown

#### Scenario: __wptReport available only during WPT runs

- **GIVEN** a WPT test run initiated by `sandbox(source, { __wptReport }, opts)` followed by `sb.run("__wptEntry", {}, runOpts)`
- **WHEN** guest code calls `__wptReport(name, status, message)`
- **THEN** the host-side implementation registered via construction-time `methods` SHALL receive the call
