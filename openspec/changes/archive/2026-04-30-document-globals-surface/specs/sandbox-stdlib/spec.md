## ADDED Requirements

### Requirement: System-bridge plugin globals are enumerated and locked

System-bridge plugins MUST install every guest-visible global via
`Object.defineProperty(globalThis, name, {writable: false, configurable:
false, value: <frozen>})` from the plugin's Phase-2 IIFE, where
`<frozen>` is the result of `Object.freeze(<inner>)`. The private dispatcher
descriptor (e.g. `$sql/do`, `$mail/send`) used to back the locked outer
SHALL be installed with `public !== true` so Phase 3
private-descriptor auto-deletion removes it after capture.

The current system-bridge plugins and their globals are:

- **`sql` plugin** contributes `__sql` (locked outer, frozen inner
  exposing `{execute}`); backed by the `$sql/do` private descriptor.
- **`mail` plugin** contributes `__mail` (locked outer, frozen inner
  exposing `{send}`); backed by the `$mail/send` private descriptor.

A new system-bridge plugin (e.g. for cache, queue, or storage)
contributed to `sandbox-stdlib` SHALL follow the same pattern AND MUST
extend `SECURITY.md` §2 "Globals surface (post-init guest-visible)" in
the same change.

#### Scenario: Tenant code attempts to reassign __sql.execute

- **WHEN** guest code runs `__sql.execute = () => "spoofed"`
- **THEN** the assignment SHALL throw `TypeError` (frozen inner)

#### Scenario: Tenant code attempts to redefine __sql

- **WHEN** guest code runs
  `Object.defineProperty(globalThis, "__sql", {value: {execute: () =>
  "spoofed"}})`
- **THEN** the call SHALL throw `TypeError` (locked outer descriptor)

#### Scenario: Phase 3 deletes the private dispatcher

- **WHEN** plugin Phase-2 IIFE completes and Phase 3 runs
- **THEN** `globalThis["$sql/do"]` SHALL be `undefined`
- **AND** `__sql.execute(...)` SHALL still succeed (the function was
  captured into the IIFE's closure before Phase 3 deleted the global
  binding)

#### Scenario: New system-bridge plugin lands without §2 update

- **WHEN** a contributor lands a `cache` plugin that installs
  `__cache` on `globalThis`
- **AND** does not update `SECURITY.md` §2
- **THEN** the enumeration test in
  `packages/runtime/src/globals-surface.test.ts` SHALL fail and block
  the merge
