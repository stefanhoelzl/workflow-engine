## ADDED Requirements

### Requirement: Globals are enumerated (R-14)

The sandbox SHALL enumerate every own property of `globalThis` present
after the post-init snapshot that is not part of the ES standard
library or the quickjs-wasi engine baseline in `SECURITY.md` §2
"Globals surface (post-init guest-visible)". The enumeration test
located at `packages/runtime/src/globals-surface.test.ts` MUST pass
under the production plugin descriptor set returned by
`buildPluginDescriptors` in `packages/runtime/src/sandbox-store.ts`.

A change that adds, renames, or removes a guest-visible global on
`globalThis` (whether installed by a plugin's Phase-2 IIFE, by the
workflow IIFE namespace, or by any future mechanism) MUST update both
SECURITY.md §2 and the enumeration test in the same change.

#### Scenario: Plugin adds a new locked global without updating §2

- **WHEN** a contributor lands a plugin that calls
  `Object.defineProperty(globalThis, "__newSurface", {...})` from its
  Phase-2 IIFE
- **AND** does not extend the inline const arrays in
  `packages/runtime/src/globals-surface.test.ts`
- **THEN** `pnpm test` SHALL fail with a diff between the actual
  post-init globals delta and the expected delta naming
  `__newSurface` as an unexpected addition

#### Scenario: Plugin removes a previously documented global

- **WHEN** a contributor removes a plugin that previously installed
  `__legacy` on `globalThis`
- **AND** does not remove `__legacy` from the inline const arrays
- **THEN** `pnpm test` SHALL fail with a diff naming `__legacy` as a
  missing expected entry

#### Scenario: Engine-supplied globals do not require §2 entries

- **WHEN** the test boots a sandbox with `pluginDescriptors: []` and an
  empty workflow source
- **THEN** all `Object.getOwnPropertyNames(globalThis)` results from
  that boot are treated as the baseline and SHALL NOT count toward the
  R-14 enumeration requirement

### Requirement: Boot sequence prose matches worker implementation

`SECURITY.md` §2 "Boot sequence" prose SHALL describe the same phases
that `packages/sandbox/src/worker.ts` implements. The phases are:

- Phase 0 — module load
- Phase 1 — WASM instantiate (`QuickJS.create`, bridge setup, stack
  limit applied)
- Phase 1a — `plugin.worker(ctx, deps, config)` for each descriptor
- Phase 1b — install WASI hooks collected during Phase 1a
- Phase 1c — install plugin guest-function descriptors on `globalThis`
- Phase 2 — plugin source eval (each plugin's Phase-2 IIFE) in
  topological order
- Phase 3 — private-descriptor auto-deletion
  (`delete globalThis[name]` for each guest function with
  `public !== true`)
- Phase 4 — user source eval (workflow IIFE bundle)

The post-Phase-4 `vm.snapshot()` captures the steady state from which
every `handleRun` restores; documented globals MUST reflect what is
present at that snapshot point.

#### Scenario: Doc and code phases agree

- **WHEN** a reader cross-references `SECURITY.md` §2's "Boot sequence"
  against `packages/sandbox/src/worker.ts:245-263`
- **THEN** the named phases SHALL match one-for-one (0, 1, 1a, 1b, 1c,
  2, 3, 4)

#### Scenario: New phase added in code requires doc update

- **WHEN** a future change inserts a new phase between Phase 4 and the
  snapshot (for example, a post-eval lock step)
- **THEN** `SECURITY.md` §2's "Boot sequence" SHALL be updated in the
  same change to enumerate the new phase
