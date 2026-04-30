## Why

`SECURITY.md` §2 "Globals surface (post-init guest-visible)" omits five
guest-visible globals that the production plugin set installs today:
`__mail`, `__sql`, `$secrets`, `workflow`, and `__wfe_exports__`. This
directly violates CLAUDE.md's invariant *"NEVER add a guest-visible
global to the QuickJS sandbox without extending §2's 'Globals surface'
list in the same PR."* The drift accumulated because each new plugin
landed without a §2 update, and the rule is currently enforced only by
reviewer attention. We need to (1) close the doc gap and (2) make the
invariant mechanically checkable so it cannot drift again.

## What Changes

- Extend `SECURITY.md` §2 "Globals surface (post-init guest-visible)" to
  list `__mail` (mail plugin), `__sql` (sql plugin), `$secrets` and
  `workflow` (secrets plugin), and `__wfe_exports__` (workflow IIFE
  namespace), each documented with the source plugin/origin and the
  locked-outer/frozen-inner descriptor pattern that protects them.
- Add umbrella threat **S15** to §2's threat table covering guest
  tampering with any locked guest-visible global (mirrors S11 / `__sdk`).
- Add rule **R-14 "Globals are enumerated"** under §2 "Rules for AI
  agents": every own property of `globalThis` present after the post-
  init snapshot — minus the ES standard library and the quickjs-wasi
  engine baseline — MUST appear in §2, and the new enumeration test
  MUST pass.
- Reconcile §2's "Boot sequence (phases 0-5)" prose with the actual
  phase numbering in `packages/sandbox/src/worker.ts` (Phases 0, 1, 1a,
  1b, 1c, 2, 3, 4 + post-eval lock + snapshot).
- Add a new enumeration test
  `packages/runtime/src/globals-surface.test.ts` that asserts the
  *delta* between a baseline-no-plugins sandbox and a production-plugin
  sandbox is exactly the §2-documented set, encoded as inline const
  arrays grouped by source plugin. Fails on additions and removals.
- Document `__wfe_exports__` as it exists today (writable, configurable,
  populated by the workflow IIFE). The structural fix to lock its
  descriptor + freeze its inner (sister finding F-4) is **out of
  scope** and stays a separate change — F-4 has no committed source we
  could read, so we will not synthesize its resolution here.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `sandbox`: adds normative requirement R-14 (every post-init globalThis
  own property must be enumerated in SECURITY.md §2 and covered by the
  enumeration test) and reconciles the documented boot-sequence phases
  with the worker implementation.
- `sandbox-stdlib`: adds per-plugin enumeration of the global each
  system-bridge plugin contributes (`__sql` from sql, `__mail` from
  mail) plus the locked-outer/frozen-inner descriptor pattern as a
  normative shape for any future system-bridge plugin.

## Impact

- **`SECURITY.md`** — §2 expanded with five new globals bullets, one new
  threat (S15), one new rule (R-14), and a phase-numbering reconciliation.
  No other sections change.
- **`packages/runtime/src/globals-surface.test.ts`** — new test file.
  Imports `buildPluginDescriptors` from `sandbox-store.ts` and the
  sandbox factory; boots two sandboxes (baseline + production), calls
  a fixture handler that returns `Object.getOwnPropertyNames(globalThis)`,
  asserts the delta equals the documented set.
- IIFE bundle source for the test fixture is inlined as a `BUNDLE_SOURCE`
  constant inside the test file, matching the pattern used in
  `packages/runtime/src/sandbox-store.test.ts`.
- **`openspec/specs/sandbox/spec.md`** — appended R-14 requirement +
  phase-numbering reconciliation note.
- **`openspec/specs/sandbox-stdlib/spec.md`** — appended per-plugin
  global-enumeration subsections.
- **No production code changes.** Sandbox runtime, plugin runtime, and
  workflow execution behavior are unchanged. The test runs under
  existing `pnpm test` (Vitest unit/integration suite) — no new CI
  surface.
- **No tenant-visible changes.** No SDK surface, no manifest format, no
  HTTP route, no persistence schema modification.
