## MODIFIED Requirements

### Requirement: Isolation — no Node.js surface

The sandbox SHALL install no Node.js-specific globals. Node core modules (`fs`, `net`, `http`, `process`, etc.) SHALL NOT be reachable from guest code. The sandbox core SHALL install no plugin-style host descriptors on `globalThis` — every guest-visible global comes from one of two sources:

1. **VM-level extensions** loaded by `worker.ts` into the QuickJS runtime via `extensions: [base64Extension, cryptoExtension, encodingExtension, headersExtension, structuredCloneExtension, urlExtension]` (see "VM-level web-platform surface via quickjs-wasi extensions" requirement). These provide `atob`, `btoa`, `TextEncoder`, `TextDecoder`, `Headers`, `URL`, `URLSearchParams`, native `crypto.getRandomValues`, native `crypto.subtle`, and native `DOMException`.
2. **Plugin-installed globals** from `sandbox-stdlib` (web-platform, fetch, timers, console plugins) and from runtime plugins (action-dispatch installs `__sdk`; trigger and host-call-action install no guest functions; wasi-telemetry installs none). Each comes with an explicit `GuestFunctionDescription` or an in-source IIFE that runs at Phase 2.

#### Scenario: Node.js core modules unreachable

- **GIVEN** a sandbox post-init
- **WHEN** guest code evaluates `typeof require`, `typeof process`, `typeof Buffer`, `typeof global`
- **THEN** each SHALL be `"undefined"`

#### Scenario: Sandbox-core install set is documented

- **GIVEN** a production sandbox composition
- **WHEN** auditing every global installed before Phase 2 plugin source evaluation
- **THEN** the set SHALL equal the union of the VM-level extensions listed in the "VM-level web-platform surface via quickjs-wasi extensions" requirement
