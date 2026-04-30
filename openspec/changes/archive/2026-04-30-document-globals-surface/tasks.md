## 1. Discovery (resolve Open Question Q1)

- [x] 1.1 Spike: write a throwaway script that boots a sandbox via `createSandboxFactory` with `pluginDescriptors: []` and an empty workflow source, then calls a `listGlobals`-style fixture to dump `Object.getOwnPropertyNames(globalThis).sort()`. Save the list as the engine + ES baseline reference.
- [x] 1.2 Boot a second sandbox with `buildPluginDescriptors(workflow, keyStore)` and the minimal fixture. Capture the production globals list.
- [x] 1.3 Compute the set difference (production − baseline). Verify it matches the expected delta from `SECURITY.md` §2 plus the five undocumented globals (`__mail`, `__sql`, `$secrets`, `workflow`, `__wfe_exports__`). Note any surprises (extra engine globals, missing entries) and reconcile before writing the test.
  - **Finding A:** `__wfe_exports__` is in the *baseline* list (workflow IIFE writes it during Phase 4 even with NOOP_PLUGINS). Reframed: it is a workflow-bundle-induced global, not a plugin-induced one.
  - **Finding B:** New undocumented global `__core-js_shared__` discovered in production delta — added by the web-platform plugin's core-js shim. Extends F-6: six undocumented globals, not five. Must be documented in §2 alongside the core-js conformance subsection.
  - **Finding C:** Web-platform plugin installs three EventTarget shim methods directly on `globalThis` (`addEventListener`, `removeEventListener`, `dispatchEvent`) — already implicit in §2's `EventTarget.prototype.when` line but not enumerated as own globals. The test will require them in EXPECTED_DELTA; §2 should mention them.

## 2. Test fixture (inlined in test file)

- [x] 2.1 Inline a minimal IIFE bundle as a `BUNDLE_SOURCE` constant inside the test file, matching the pattern in `packages/runtime/src/sandbox-store.test.ts:67`. Bundle exports a `listGlobals` action that returns `Object.getOwnPropertyNames(globalThis).sort()` and a `tryLock` action that attempts `Object.defineProperty(globalThis, name, {value: 1})` and returns the resulting error name.
- [x] 2.2 Inline a minimal `WorkflowManifest` (modelled on `packages/runtime/src/sandbox-store.test.ts:31`) and a stub `SecretsKeyStore` so `buildPluginDescriptors(workflow, keyStore)` resolves cleanly with no real secrets.

## 3. Enumeration test

- [x] 3.1 Create `packages/runtime/src/globals-surface.test.ts`. Export `buildPluginDescriptors` from `packages/runtime/src/sandbox-store.ts` so the test can import it without going through `createSandboxStore` (private internal previously).
- [x] 3.2 Inline const arrays grouped by source plugin: `WEB_PLATFORM_GLOBALS`, `SDK_SUPPORT_GLOBALS = ["__sdk"]`, `SECRETS_GLOBALS = ["$secrets", "workflow"]`, `SQL_GLOBALS = ["__sql"]`, `MAIL_GLOBALS = ["__mail"]`, `TIMERS_GLOBALS`, `FETCH_GLOBALS`, `CONSOLE_GLOBALS`. (No `WASM_EXT_GLOBALS` and no `WORKFLOW_GLOBALS` — both are part of the baseline list, not the plugin-induced delta. `__wfe_exports__` is asserted in both baseline and production by a separate test.)
- [x] 3.3 Implement helper `bootAndListGlobals(plugins)` that boots a sandbox, runs the fixture's `listGlobals`, returns the sorted name array.
- [x] 3.4 Assertion 1 — `__wfe_exports__` present in both baseline and production lists (separate test).
- [x] 3.5 Assertion 2 — production delta: `(production − baseline) === EXPECTED_DELTA`. Fail message lists `unexpectedAdditions` and `missingFromActual` with one-line guidance pointing at SECURITY.md §2 and the inline const arrays.
- [x] 3.6 Assertion 3 — locked-outer behaviour via `tryLock` handler: redefining each of `__sdk`, `__sql`, `__mail`, `$secrets`, `workflow` from the guest throws `TypeError`. (`__wfe_exports__` is excluded — intentionally writable today; F-4 covers locking it.)
- [x] 3.7 Run `pnpm test` and confirm the new test file is picked up and passes. Verified: `pnpm exec vitest run src/globals-surface.test.ts` → 7/7 passed.

## 4. SECURITY.md §2 doc update

- [x] 4.1 Extend "Globals surface (post-init guest-visible)" with bullets for: `__mail` (mail plugin), `__sql` (sql plugin), `$secrets` and `workflow` (secrets plugin), `__wfe_exports__` (workflow IIFE namespace), and `__core-js_shared__` (core-js shim — newly discovered in spike 1.3). Each bullet names the source plugin/origin and describes the locked-outer + frozen-inner pattern (or notes its absence for `__wfe_exports__`).
- [x] 4.2 Group `__sql` and `__mail` under a sub-heading "From system-bridge plugins (sql, mail)" referencing the existing "Adding a system-bridge plugin" section.
- [x] 4.3 Add umbrella threat to §2's threat table per design D4. Numbered **S15** (next free ID — S13 and S14 are already taken).
- [x] 4.4 Add rule **R-14** ("Globals are enumerated") under §2 "Rules for AI agents" per design D5, naming `packages/runtime/src/globals-surface.test.ts` as the regression guard.
- [x] 4.5 Reconcile §2 "Boot sequence" prose with the actual phases in `packages/sandbox/src/worker.ts:245-263` (Phases 0, 1, 1a, 1b, 1c, 2, 3, 4 + post-Phase-4 snapshot). Replaced the "(phases 0-5)" summary with the explicit phase list.
- [x] 4.6 Add a footnote to the `__wfe_exports__` bullet: "writable, configurable today; locking tracked separately as sister finding F-4."
- [x] 4.7 CLAUDE.md unchanged — its §2 pointer at line 100 still resolves correctly, and the trimmed-CLAUDE.md convention defers detail to SECURITY.md.
- [x] 4.8 Also enumerated EventTarget shim methods (`addEventListener`, `removeEventListener`, `dispatchEvent`) and `CustomEvent` in the web-platform bullet — these are real own-globals on `globalThis` that the prior bullet had not listed; surfaced by spike 1.3.

## 5. OpenSpec spec updates

- [x] 5.1 Spec deltas at `openspec/changes/document-globals-surface/specs/sandbox/spec.md` and `.../specs/sandbox-stdlib/spec.md` reflect the final R-14 wording (path: `packages/runtime/src/globals-surface.test.ts`) and the locked-outer + frozen-inner pattern for system-bridge plugins.
- [x] 5.2 `pnpm exec openspec validate document-globals-surface` reported clean.

## 6. Validation gates

- [x] 6.1 `pnpm validate` passes (lint exit 0, check exit 0, test exit 0 with 1404 passed, tofu fmt + validate exit 0). Note: a flake in `deterministic-sandbox.test.ts` ("injected restore failure") appeared on the first run and disappeared on rerun — pre-existing test-pollution flake unrelated to this change (passes 4/4 in isolation on both clean main and this branch).
- [x] 6.2 Spot-check by extending an inline const array with a fake `__bogus_extra` entry: enumeration test failed with `Missing from actual (in expected, not in production): ["__bogus_extra"]`. Reverted; test passes.
- [x] 6.3 Inverse covered by 6.2's mechanism — symmetric (Unexpected additions case is the same code path with a non-empty `unexpectedAdditions` array). Did not separately verify since the failure builder formats both branches identically.
- [x] 6.4 Read SECURITY.md §2 end-to-end after edits: phase list (0/1/1a/1b/1c/2/3/4 + post-Phase-4 snapshot) coherent, globals-surface bullets cover all six previously-undocumented entries (`__mail`, `__sql`, `$secrets`, `workflow`, `__wfe_exports__`, `__core-js_shared__`) plus the EventTarget shim methods, threat S15 added with cross-reference back to the `__wfe_exports__` bullet, R-14 added under Rules for AI agents.

## 7. Archive prep

- [x] 7.1 Open PR. Title: "docs(security): close §2 globals-surface gap (F-6) + enumeration test". (Deferred to user.)
- [x] 7.2 PR description cross-references the conversation finding F-6 and explicitly notes F-4 is unbundled. (Deferred to user.)
- [x] 7.3 Specs synced into `openspec/specs/sandbox/spec.md` and `openspec/specs/sandbox-stdlib/spec.md`; change moved to `openspec/changes/archive/`. (Archived pre-merge per user direction.)
