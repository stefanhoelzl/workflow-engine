## MODIFIED Requirements

### Requirement: createWebPlatformPlugin factory

The sandbox-stdlib package SHALL export a `createWebPlatformPlugin(): Plugin` factory. The returned plugin's source file SHALL export a `guest(): void` function bundled into `PluginDescriptor.guestSource` by the `?sandbox-plugin` vite transform. The `guest()` function SHALL install WebIDL polyfills as writable/configurable globals: `EventTarget`, `Event`, `ErrorEvent`, `AbortController`, `AbortSignal`, `URLPattern`, `CompressionStream`, `DecompressionStream`, `scheduler`, `TaskController`, `TaskSignal`, `Observable`, `Subscriber`, `ReadableStream`, `WritableStream`, `TransformStream`, `indexedDB`, `performance.mark`, `performance.measure`, `performance.getEntries`, `queueMicrotask` (wrapped to route uncaught exceptions through `reportError`), `reportError` (dispatches cancelable ErrorEvent, forwards to a captured-and-deleted `__reportErrorHost` private guest function if not preventDefault'd). The plugin SHALL register `__reportErrorHost` as a private guest function descriptor (`public` unset) whose handler emits a leaf event with kind `uncaught-error`. The polyfill `guest()` SHALL capture `__reportErrorHost` into an IIFE closure; the sandbox SHALL auto-delete the global after phase-2 evaluation. The plugin SHALL set `navigator.userAgent = "WorkflowEngine"` (no version suffix).

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

#### Scenario: navigator.userAgent has no version suffix

- **GIVEN** a sandbox with `createWebPlatformPlugin()` composed
- **WHEN** guest code evaluates `navigator.userAgent`
- **THEN** the value SHALL be exactly `"WorkflowEngine"`

### Requirement: Bundled polyfill source via rollup

The web-platform plugin's `guestSource` SHALL be produced by the `?sandbox-plugin` vite transform's guest pass, which rollup-bundles the `guest()` function exported from the plugin source file plus its transitive imports into a single IIFE. Cross-file module imports between polyfill installer files (e.g., `installStreams` → `installBlob`) SHALL resolve at build time. The `fetch-blob` dependency SHALL be installed with a `pnpm patch` that removes its module-level top-level-await block (the block is dead code in the sandbox because `ReadableStream` is installed by the streams installer before `fetch-blob` loads).

#### Scenario: Polyfill bundle is a single IIFE

- **GIVEN** the shipped sandbox-stdlib package
- **WHEN** inspecting the resolved `createWebPlatformPlugin()` plugin descriptor's `guestSource`
- **THEN** the string SHALL be a single IIFE that invokes the `guest()` function at its end

#### Scenario: Cross-installer imports resolve

- **GIVEN** installer file A imports a helper from installer file B
- **WHEN** the guest-pass bundle is built
- **THEN** the resulting IIFE SHALL have the cross-file dependency resolved inline with no `require`/`import` statements remaining

#### Scenario: fetch-blob TLA block is absent from the installed module

- **GIVEN** the pnpm-patched `fetch-blob` package in `node_modules`
- **WHEN** inspecting the patched `index.js`
- **THEN** the `if (!globalThis.ReadableStream) { await import(...) }` top-level-await block SHALL be absent

## REMOVED Requirements

### Requirement: sandboxPolyfills vite plugin and virtual:sandbox-polyfills module

**Reason**: Replaced by the unified `?sandbox-plugin` vite transform, which produces the web-platform plugin's guest IIFE as `descriptor.guestSource` instead of as a runtime-imported virtual module wired into `config.bundleSource`.

**Migration**: Consumer `vite.config.ts` and `vitest.config.ts` files that previously registered `sandboxPolyfills()` SHALL drop that registration; the unified `sandboxPlugins()` transform now handles both worker and guest bundling. Consumers that previously imported `SANDBOX_POLYFILLS` from `virtual:sandbox-polyfills` and passed it as `webPlatformConfig.bundleSource` SHALL remove that code; the web-platform plugin now ships its guest source via its own file's `guest()` export. `virtual.d.ts` ambient declarations for `virtual:sandbox-polyfills` are deleted.
