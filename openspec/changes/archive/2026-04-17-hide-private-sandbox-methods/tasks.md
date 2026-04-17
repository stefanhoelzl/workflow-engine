## 1. Sandbox package — capture-and-delete shims

- [x] 1.1 Rewrite `FETCH_SHIM` in `packages/sandbox/src/globals.ts` as an IIFE that captures `globalThis.__hostFetch` into a closure-local `_hostFetch`, installs the guest-facing `fetch` via `Object.defineProperty({writable: false, configurable: false})` using the captured reference, then `delete globalThis.__hostFetch` at the end of the IIFE
- [x] 1.2 Rewrite `REPORT_ERROR_SHIM` in `packages/sandbox/src/globals.ts` as an IIFE that captures `globalThis.__reportError` into a closure-local `_report`, installs `globalThis.reportError` using the captured reference (guarded by `try/catch` so a `_report === undefined` case is a silent no-op), then `delete globalThis.__reportError` at the end of the IIFE
- [x] 1.3 In `packages/sandbox/src/index.ts` remove `__hostFetch` and `__emitEvent` from `RESERVED_BUILTIN_GLOBALS`. Leave `fetch`, `reportError`, `console`, `performance`, `crypto`, timer names, `self`, `navigator`, and the WASM extension globals in the reserved set

## 2. Runtime package — dispatcher shim + name-binder cleanup

- [x] 2.1 Rewrite `ACTION_DISPATCHER_SOURCE` in `packages/runtime/src/workflow-registry.ts` as an IIFE that: captures `globalThis.__hostCallAction` and `globalThis.__emitEvent` into closure-locals; defines a `dispatch(name, input, handler, outputSchema)` function that uses only the captured references (no global reads inside the body); installs `globalThis.__dispatchAction` via `Object.defineProperty(globalThis, "__dispatchAction", { value: dispatch, writable: false, configurable: false })`; then deletes `globalThis.__hostCallAction` and `globalThis.__emitEvent`
- [x] 2.2 Extend `buildActionNameBinder` in `packages/runtime/src/workflow-registry.ts` so the emitted source, after calling `__setActionName(exportName)` on each action callable, follows with `delete __wfe_exports__[name].__setActionName`. Verify the emitted source handles the "aliased export was rejected at build time" case without attempting re-binding

## 3. Sandbox tests — reframe direct-call tests

- [x] 3.1 In `packages/sandbox/src/sandbox.test.ts`, delete the five tests that call `__emitEvent` directly from guest source (`__emitEvent is callable from guest and stamps action.* events`, `__emitEvent does NOT itself appear as a system.request`, `__emitEvent rejects non-action kinds`, and the two nested-action tests). Replace with equivalent tests that exercise the action-event pipeline via the dispatcher: construct a sandbox with `__hostCallAction`, append a minimal `ACTION_DISPATCHER_SOURCE`, invoke a test action, and assert the expected `action.*` events appear on the event stream
- [x] 3.2 In `packages/sandbox/src/sandbox.test.ts`, delete the `per-run extraMethods.__reportError overrides construction-time methods.__reportError` test. The override path is being removed from the spec
- [x] 3.3 In `packages/sandbox/src/sandbox.test.ts`, delete the `__reportError absent throws ReferenceError when called directly` test. Guest code can no longer reach `__reportError` regardless of whether a host bridge was provided
- [x] 3.4 In `packages/sandbox/src/sandbox.test.ts`, add a new test `underscore bridge names are not on globalThis after init` that constructs a sandbox with `__hostCallAction` + `__reportError` and asserts `typeof globalThis.__hostFetch === "undefined"`, `typeof globalThis.__emitEvent === "undefined"`, `typeof globalThis.__hostCallAction === "undefined"`, `typeof globalThis.__reportError === "undefined"` from guest code
- [x] 3.5 In `packages/sandbox/src/sandbox.test.ts`, add a new test `guest cannot overwrite bridge names to affect shims` that attempts `globalThis.__hostFetch = () => "pwned"` then calls `fetch("https://example.com")` via a test forwardFetch and asserts the forwarded call still reaches the test double (shim's captured reference is invariant)
- [x] 3.6 In `packages/sandbox/src/sandbox.test.ts`, add a new test `guest cannot overwrite reportError bridge` that attempts `globalThis.__reportError = () => "pwned"` then calls `reportError(new Error("x"))` and asserts the construction-time bridge still receives the serialized payload

## 4. Sandbox tests — host-call-action path

- [x] 4.1 In `packages/sandbox/src/host-call-action.test.ts`, rewrite the direct `__hostCallAction("notify", ...)` guest calls to exercise the same bridge via the SDK-flavored path: construct a sandbox with `__hostCallAction`, append an `ACTION_DISPATCHER_SOURCE` shim and a bundle stub that installs `__wfe_exports__.notify` as an action callable, invoke `sb.run("notify", input)`, and assert the host bridge received the call. Preserve coverage of: host-side validation failure propagation, `issues` field preservation, and `system.request` event naming via `methodEventNames: { __hostCallAction: "host.validateAction" }`

## 5. Runtime tests — dispatcher surface

- [x] 5.1 In `packages/runtime/src/workflow-registry.test.ts` and `packages/runtime/src/integration.test.ts`, confirm the hand-rolled test bundles that do `await globalThis.__dispatchAction(...)` continue to work (the dispatcher stays exposed). Add a test `__dispatchAction is non-writable and non-configurable after workflow load` that loads a workflow, enters the sandbox, attempts `globalThis.__dispatchAction = fakeDispatcher` (strict mode) and asserts a TypeError; attempts `delete globalThis.__dispatchAction` and asserts `false` / TypeError; confirms subsequent action calls still route through the original dispatcher
- [x] 5.2 Add a test `__hostCallAction and __emitEvent are not on globalThis after workflow load` that loads a real workflow and asserts both names are `undefined` from guest code's perspective

## 6. SECURITY.md — threat model alignment

- [x] 6.1 In `SECURITY.md` §2, rewrite the "Bridge surface inventory" subsection to describe the install → capture → delete lifecycle for `__hostFetch`, `__emitEvent`, `__hostCallAction`, and `__reportError`. Describe `__dispatchAction` as the sole `__*` global that remains guest-visible, installed via `Object.defineProperty` with `writable: false, configurable: false`
- [x] 6.2 In `SECURITY.md` §2 "Globals exposed inside the sandbox" paragraph, drop `__hostFetch`, `__emitEvent`, `__reportError`, and `__hostCallAction` from the enumerated list of guest-visible globals. Add a new sentence describing the post-init surface and the locked `__dispatchAction`
- [x] 6.3 In `SECURITY.md` §2 "Threats" table, add an accepted-residual entry (e.g., `R-S10`) describing the `__dispatchAction` audit-log-poisoning scenario: guest calling the live dispatcher with `(validName, realInput, fakeHandler, fakeSchema)` causes `action.*` events to misrepresent which handler ran; host-side input validation remains authoritative
- [x] 6.4 In `SECURITY.md` §2 "Rules for AI agents", add an invariant: "NEVER install a `__*`-prefixed host bridge without wrapping its consumer in a capture-and-delete shim that removes the bridge name from `globalThis` before workflow source can read it." Cross-reference the sandbox spec's post-init surface requirement

## 7. CLAUDE.md invariants

- [x] 7.1 In the "Security Invariants" section of `CLAUDE.md`, add: "NEVER add a `__*`-prefixed global to the sandbox without a capture-and-delete shim — guest code must not be able to read or overwrite raw host bridges (§2)". Keep phrasing consistent with the existing bullet style

## 8. Validation

- [x] 8.1 Run `pnpm lint` and confirm no new biome warnings in the touched files
- [x] 8.2 Run `pnpm check` and confirm no TypeScript errors
- [x] 8.3 Run `pnpm test` and confirm all unit + integration tests pass (including the new surface-hiding tests and the rewritten `__emitEvent` / `__hostCallAction` / `__reportError` tests) — 334/334 passing
- [x] 8.4 Run `pnpm exec openspec validate hide-private-sandbox-methods --strict` and confirm zero issues
- [x] 8.5 Manual sanity: covered by `packages/runtime/src/integration.test.ts` end-to-end test (trigger → action dispatch → host bridge → archive with `action.*` events) and by the new `workflow-registry.test.ts` tests verifying post-init surface invisibility + `__dispatchAction` lock. Live-runtime smoke with the cronitor workflow requires local kind/OAuth infrastructure; not re-executed in this apply session since `pnpm build` succeeded and the automated tests cover the same code path
