# sandbox-stdlib Specification

## Purpose
TBD - created by archiving change sandbox-plugin-architecture. Update Purpose after archive.
## Requirements
### Requirement: sandbox-stdlib package

The system SHALL provide a workspace package `@workflow-engine/sandbox-stdlib` at `packages/sandbox-stdlib`. The package SHALL ship TypeScript source directly (no build step), matching conventions of `@workflow-engine/sandbox`. The package SHALL depend on `@workflow-engine/sandbox` (for plugin types) and on `zod` + polyfill libraries as needed (event-target-shim, urlpattern-polyfill, web-streams-polyfill, fake-indexeddb, scheduler-polyfill, observable-polyfill, fflate).

#### Scenario: Package exists as a workspace member

- **GIVEN** the monorepo at `packages/`
- **WHEN** a developer runs `pnpm install`
- **THEN** `packages/sandbox-stdlib` SHALL be discovered as a workspace package
- **AND** its `package.json` SHALL declare `name: "@workflow-engine/sandbox-stdlib"`

#### Scenario: Runtime depends on sandbox-stdlib

- **GIVEN** `packages/runtime/package.json`
- **WHEN** inspecting the `dependencies` field
- **THEN** it SHALL declare `"@workflow-engine/sandbox-stdlib": "workspace:*"`

### Requirement: createWebPlatformPlugin factory

The sandbox-stdlib package SHALL export a `createWebPlatformPlugin(): Plugin` factory. The returned plugin SHALL provide a `source` blob that installs WebIDL polyfills as writable/configurable globals: `EventTarget`, `Event`, `ErrorEvent`, `AbortController`, `AbortSignal`, `URLPattern`, `CompressionStream`, `DecompressionStream`, `scheduler`, `TaskController`, `TaskSignal`, `Observable`, `Subscriber`, `ReadableStream`, `WritableStream`, `TransformStream`, `indexedDB`, `performance.mark`, `performance.measure`, `performance.getEntries`, `queueMicrotask` (wrapped to route uncaught exceptions through `reportError`), `reportError` (dispatches cancelable ErrorEvent, forwards to a captured-and-deleted `__reportErrorHost` private guest function if not preventDefault'd). The plugin SHALL register `__reportErrorHost` as a private guest function descriptor (`public` unset) whose handler emits a leaf event with kind `uncaught-error`. The polyfill source SHALL capture `__reportErrorHost` into an IIFE closure; the sandbox SHALL auto-delete the global after phase-2 evaluation.

#### Scenario: WebIDL globals installed and writable

- **GIVEN** a sandbox composed with only `createWebPlatformPlugin()`
- **WHEN** guest code evaluates `Object.getOwnPropertyDescriptor(globalThis, "EventTarget")`
- **THEN** the descriptor SHALL have `writable: true` and `configurable: true`

#### Scenario: Microtask exception routes through reportError

- **GIVEN** a guest that calls `queueMicrotask(() => { throw new Error("boom") })`
- **WHEN** the microtask fires
- **THEN** `reportError` SHALL be invoked with the thrown error
- **AND** an `uncaught-error` leaf event SHALL be emitted if the dispatched `ErrorEvent` was not default-prevented

#### Scenario: __reportErrorHost is not guest-visible

- **GIVEN** a sandbox with `createWebPlatformPlugin()` composed
- **WHEN** user source (phase 4) evaluates `typeof globalThis.__reportErrorHost`
- **THEN** the result SHALL be `"undefined"`

### Requirement: createFetchPlugin factory

The sandbox-stdlib package SHALL export a `createFetchPlugin(opts?: { fetch?: FetchImpl }): Plugin` factory. When `opts.fetch` is omitted, the plugin SHALL close over the `hardenedFetch` export from the same package. The plugin SHALL declare `dependsOn: ["web-platform"]`. The plugin SHALL register a private guest function `$fetch/do` whose handler invokes the bound fetch implementation and returns the serialized response. The plugin's `source` blob SHALL install a WHATWG-compliant `globalThis.fetch` that captures `$fetch/do` and marshals `Request`/`Response` to/from the host. The descriptor SHALL declare `log: { request: "fetch" }` so each fetch call produces `fetch.request`/`fetch.response` or `fetch.error`.

#### Scenario: Production fetch uses hardenedFetch by default

- **GIVEN** `createFetchPlugin()` called with no arguments
- **WHEN** guest code calls `await fetch("https://public.example.com/")`
- **THEN** the host-side handler SHALL invoke `hardenedFetch` (DNS validation, IANA blocklist, redirect re-check, 30s timeout)
- **AND** the request SHALL fail closed if any hardening check rejects

#### Scenario: Test fetch override

- **GIVEN** `createFetchPlugin({ fetch: mockFetch })` with `mockFetch` a test double
- **WHEN** guest code calls `await fetch("https://any/")`
- **THEN** `mockFetch` SHALL be invoked instead of `hardenedFetch`

#### Scenario: Fetch call produces request/response events

- **GIVEN** guest code awaits `fetch("https://public.example.com/")` and the request succeeds
- **WHEN** the call resolves
- **THEN** a `fetch.request` event SHALL be emitted with `createsFrame: true`
- **AND** a `fetch.response` event SHALL be emitted with `closesFrame: true`
- **AND** the response event's `ref` SHALL point to the request event's `seq`

### Requirement: hardenedFetch export

The sandbox-stdlib package SHALL export `hardenedFetch` as a named constant — a fetch implementation that performs IANA special-use blocklist checks on the resolved IP for every DNS resolution, rejects `data:` URLs with an error, re-validates redirect targets (manual follow, limit 5), strips `Authorization` on cross-origin redirects, enforces a 30s wall-clock timeout, and fails closed with a sanitized error on any check failure.

#### Scenario: hardenedFetch rejects IANA special-use CIDR

- **GIVEN** a hostname resolving to an IANA private range (e.g., `10.0.0.1`)
- **WHEN** `hardenedFetch(url)` is called
- **THEN** the promise SHALL reject with a sanitized error before any socket is opened
- **AND** the error message SHALL NOT leak the resolved IP address

#### Scenario: hardenedFetch enforces 30s timeout

- **GIVEN** an upstream that never responds
- **WHEN** `hardenedFetch(url)` is called
- **THEN** the promise SHALL reject no later than 30 seconds after the call

### Requirement: createTimersPlugin factory

The sandbox-stdlib package SHALL export a `createTimersPlugin(): Plugin` factory. The plugin SHALL register public descriptors for `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`. The `setTimeout` / `setInterval` descriptors SHALL declare `log: { event: "timer.set" }` emitting a leaf at scheduling time. The `clearTimeout` / `clearInterval` descriptors SHALL declare `log: { event: "timer.clear" }`. When a scheduled timer fires on the host, the plugin SHALL wrap the guest callback execution in `ctx.request("timer", name, { input: { timerId } }, () => callable())`, producing `timer.request`/`timer.response`/`timer.error` events around the callback. The plugin SHALL implement `onRunFinished` to clear any host timers still live at run end, using the same code path that handles guest-initiated `clearTimeout`.

#### Scenario: setTimeout emits timer.set leaf

- **GIVEN** guest code calls `setTimeout(cb, 100)`
- **WHEN** the call returns
- **THEN** a leaf event with kind `timer.set` SHALL have been emitted
- **AND** the event `input` SHALL include `{ delay: 100, timerId: <id> }`

#### Scenario: Timer callback wraps with timer.request/response

- **GIVEN** a setTimeout whose callback returns normally
- **WHEN** the timer fires
- **THEN** `timer.request` (createsFrame) SHALL be emitted
- **AND** the captured callable SHALL be invoked
- **AND** `timer.response` (closesFrame) SHALL be emitted with the response's `ref` equal to `timer.request.seq`

#### Scenario: Unfired timer cleared at run end

- **GIVEN** a setTimeout with 30s delay scheduled inside a 1s run
- **WHEN** the run completes
- **THEN** the plugin's `onRunFinished` SHALL invoke the same cleanup as guest-called `clearTimeout`
- **AND** a `timer.clear` leaf event SHALL be emitted for the still-live timer
- **AND** the host-side `setTimeout` SHALL be cleared before the next run starts against the same sandbox

### Requirement: createConsolePlugin factory

The sandbox-stdlib package SHALL export a `createConsolePlugin(): Plugin` factory. The plugin SHALL install `globalThis.console` as an object containing methods `log`, `info`, `warn`, `error`, `debug`. Each method call SHALL emit a leaf event of kind `console.log` / `console.info` / `console.warn` / `console.error` / `console.debug` respectively, with `input` carrying the argument list. The console globals SHALL be writable/configurable per WebIDL.

#### Scenario: console.log emits console.log leaf

- **GIVEN** guest code calls `console.log("hello", { x: 1 })`
- **WHEN** the call returns
- **THEN** a leaf event with kind `console.log` and `input: ["hello", { x: 1 }]` SHALL be emitted

### Requirement: Bundled polyfill source via rollup

The web-platform plugin's `source` blob SHALL be produced by a rollup build inside `packages/sandbox-stdlib/src/web-platform/source/` that bundles all polyfill files into a single IIFE. Cross-file module imports between polyfill files (e.g., `EventTarget` → `ErrorEvent`) SHALL resolve at build time. The build SHALL emit a single string embedded into the plugin factory.

#### Scenario: Polyfill bundle is a single IIFE

- **GIVEN** the shipped sandbox-stdlib package
- **WHEN** inspecting `createWebPlatformPlugin().worker(ctx).source`
- **THEN** the source SHALL be a single string enclosed in one outer IIFE

#### Scenario: Cross-file imports resolve

- **GIVEN** source file A imports a private symbol from file B
- **WHEN** the bundle is built
- **THEN** the resulting IIFE SHALL have the cross-file dependency resolved inline with no `require`/`import` statements remaining

