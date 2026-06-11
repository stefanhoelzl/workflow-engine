# sandbox-plugin delta: plugin-worker-source-url

## ADDED Requirements

### Requirement: Plugin worker module identity in stack traces

A plugin's worker module SHALL be identified in V8 stack traces by the virtual name `sandbox-plugin:<name>` (where `<name>` is the descriptor's `name` field), not by its `data:` import URL. The loader SHALL achieve this by appending `\n//# sourceURL=sandbox-plugin:<name>` to `descriptor.workerSource` before constructing the `data:text/javascript;base64,<...>` import URL. Stack frames originating in plugin worker code SHALL therefore render as `at <fn> (sandbox-plugin:<name>:<line>:<col>)`, preserving function names and bundle-relative line/column.

Serialized error payloads derived from such stacks — the `error` field of emitted `.error` lifecycle events (the log auto-wrap's `<descriptorName>.error`, and the stdlib plugins' `system.error` / `action.error`) — SHALL NOT contain the substring `data:text/javascript`.

#### Scenario: Worker-module throw carries the virtual name

- **GIVEN** a plugin descriptor named `fetch` whose loaded worker code throws an `Error`
- **WHEN** the error's `stack` is inspected host-side
- **THEN** frames from the worker module SHALL match `sandbox-plugin:fetch:<line>:<col>`
- **AND** the stack SHALL NOT contain `data:text/javascript`

#### Scenario: Emitted error event payload is blob-free

- **GIVEN** a plugin whose lifecycle-wrapped host-side work (a guest-function handler under the log auto-wrap, or work wrapped in `ctx.request`) throws from inside its worker module
- **WHEN** the resulting `.error` lifecycle event is emitted
- **THEN** the event's `error.stack` SHALL contain `sandbox-plugin:<name>` frames
- **AND** the serialized `error` payload SHALL NOT contain `data:text/javascript`

#### Scenario: Bundle ending in a line comment still gets the virtual name

- **GIVEN** a `workerSource` whose final line is a `//` line comment
- **WHEN** the loader appends the sourceURL comment and imports the module
- **THEN** the appended `//# sourceURL` SHALL occupy its own final line
- **AND** a throw from the module SHALL render frames named `sandbox-plugin:<name>`

## MODIFIED Requirements

### Requirement: JSON-serializable plugin descriptor

The sandbox SHALL transfer plugin descriptors from the main thread to the worker via `postMessage`. Each descriptor SHALL be JSON-serializable with this shape: `{ name: string, workerSource: string, guestSource?: string, dependsOn?: readonly string[], config?: unknown }`.

- `workerSource` is a pre-bundled ESM source string whose default export is the plugin's `worker(ctx, deps, config)` function. The worker loads it via `data:text/javascript;base64,<...>` dynamic import after appending `\n//# sourceURL=sandbox-plugin:<name>`, so the module's stack-trace script name is `sandbox-plugin:<name>` rather than the `data:` URL (see "Plugin worker module identity in stack traces").
- `guestSource` is OPTIONAL: a pre-bundled IIFE source string evaluated as a top-level script inside the guest VM in Phase 2. Emitted by the `?sandbox-plugin` vite transform when the plugin file exports a `guest` function; omitted otherwise.
- Both strings are produced at build time by the `?sandbox-plugin` vite transform.
- `config` is JSON-serializable data. Functions, closures, class instances, and non-serializable values in `config` SHALL cause construction to fail.

#### Scenario: Function in config fails

- **GIVEN** a plugin factory passed config `{ logger: () => {} }`
- **WHEN** the plugin descriptor is serialized for the worker
- **THEN** sandbox construction SHALL throw with an error naming the offending config path

#### Scenario: Descriptor without guestSource

- **GIVEN** a plugin file that exports `worker` but no `guest`
- **WHEN** the `?sandbox-plugin` vite transform resolves the plugin's import
- **THEN** the emitted descriptor SHALL have a `workerSource` string
- **AND** the descriptor SHALL omit the `guestSource` field

#### Scenario: Descriptor with guestSource

- **GIVEN** a plugin file that exports both `worker` and `guest`
- **WHEN** the `?sandbox-plugin` vite transform resolves the plugin's import
- **THEN** the emitted descriptor SHALL have both a `workerSource` and a `guestSource` string
- **AND** evaluating `guestSource` as a top-level script SHALL invoke the `guest` function
