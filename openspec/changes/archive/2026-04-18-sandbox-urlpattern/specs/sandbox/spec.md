## ADDED Requirements

### Requirement: Safe globals — URLPattern

The sandbox SHALL expose `globalThis.URLPattern` as a WHATWG URLPattern implementation, provided by the `urlpattern-polyfill` npm package (exact version pinned in `packages/sandbox/package.json`) and compiled into the sandbox polyfill IIFE via the `sandboxPolyfills()` Vite plugin. No host-bridge method is used; all pattern state lives in the QuickJS heap. This global is required by the WinterCG Minimum Common API.

The polyfill's own `index.js` self-installs the class on `globalThis` behind a feature-detect guard (`if (!globalThis.URLPattern) globalThis.URLPattern = URLPattern;`) when the `virtual:sandbox-polyfills` IIFE runs. Adding `URLPattern` to `RESERVED_BUILTIN_GLOBALS` in `packages/sandbox/src/index.ts` SHALL make the name collide at sandbox-construction time if a host passes `extraMethods: { URLPattern: … }`, matching every other shim-installed global.

#### Scenario: URLPattern is a constructible function

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `typeof URLPattern`
- **THEN** the result SHALL be `"function"`
- **AND** `new URLPattern("/foo") instanceof URLPattern` SHALL evaluate to `true`

#### Scenario: URLPattern.exec returns named groups for a matching URL

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new URLPattern({ pathname: "/users/:id" }).exec({ pathname: "/users/42" })`
- **THEN** the result SHALL be a match object whose `pathname.groups.id === "42"`

#### Scenario: URLPattern.test returns false for a non-matching URL

- **GIVEN** a sandbox
- **WHEN** guest code evaluates `new URLPattern({ pathname: "/users/:id" }).test({ pathname: "/posts/42" })`
- **THEN** the result SHALL be `false`

#### Scenario: Host extraMethods cannot shadow URLPattern

- **GIVEN** a sandbox factory invoked with `extraMethods: { URLPattern: someHostFn }`
- **WHEN** sandbox construction runs the reserved-globals collision check
- **THEN** construction SHALL throw with a message naming `URLPattern` as a reserved global

## MODIFIED Requirements

### Requirement: Isolation — no Node.js surface

The sandbox SHALL provide a hard isolation boundary. Guest code SHALL have no access to `process`, `require`, `global` (as a Node.js object), filesystem APIs, child_process, or any Node.js built-ins.

The sandbox SHALL expose only the following globals to guest code after initialization completes: the host methods registered via `methods` / `extraMethods` (each installed on `globalThis` for the duration of its scope, subject to the capture-and-delete rules in the `__hostFetch bridge`, `__reportError host bridge`, `__emitEvent init-time bridge`, and `__hostCallAction bridge global` requirements), the built-in host-bridged globals that remain guest-visible (`console`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`), the guest-side shims (`fetch`, `reportError`, `self`, `navigator`, `URLPattern`), the globals provided by WASM extensions (`URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `structuredClone`, `Headers`, `crypto`, `performance`), and the locked runtime-appended dispatcher global (`__dispatchAction`). The names `__hostFetch`, `__emitEvent`, `__hostCallAction`, and `__reportError` SHALL NOT be present on `globalThis` by the time workflow source evaluation begins, or at any later point in the sandbox's lifetime, unless a per-run `extraMethod` deliberately reinstalls one of these names for the duration of that run (honored as the host's explicit choice, independent of the sandbox's default hiding).

Any addition to this allowlist SHALL be made in the same change proposal that amends `/SECURITY.md §2`, with a written rationale and threat assessment per surface added.

#### Scenario: Node.js globals absent

- **GIVEN** a sandbox
- **WHEN** guest code references `process`, `require`, or `fs`
- **THEN** a `ReferenceError` SHALL be thrown inside QuickJS

#### Scenario: WASM extension globals available

- **GIVEN** a sandbox
- **WHEN** guest code references `URL`, `TextEncoder`, `Headers`, `crypto`, `atob`, `structuredClone`
- **THEN** each SHALL be a defined global provided by the WASM extensions

#### Scenario: MCA shim globals available

- **GIVEN** a sandbox
- **WHEN** guest code references `self`, `navigator.userAgent`, `reportError`, `URLPattern`
- **THEN** each SHALL be a defined global provided by the sandbox init sequence

#### Scenario: Underscore-prefixed bridge names absent post-init

- **GIVEN** a sandbox whose initialization has completed (workflow source evaluated, runtime-appended dispatcher shim evaluated)
- **WHEN** guest code evaluates `typeof globalThis.__hostFetch`, `typeof globalThis.__emitEvent`, `typeof globalThis.__hostCallAction`, and `typeof globalThis.__reportError`
- **THEN** each expression SHALL evaluate to `"undefined"`
- **AND** guest attempts to reinstall any of these names via plain assignment (e.g., `globalThis.__hostFetch = myFn`) SHALL NOT affect the behavior of the corresponding shim (the shim's captured reference from init time is invariant)
