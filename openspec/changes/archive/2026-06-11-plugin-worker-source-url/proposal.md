# Proposal: plugin-worker-source-url

## Why

Plugin worker modules are imported inside the sandbox worker thread via `data:text/javascript;base64,<entire bundle>` dynamic import, so each module's identity — its script name in V8 stack traces — is its own multi-hundred-KB source blob. Every stack frame from host-side plugin code (fetch, mail, sql) repeats that blob, making stacks unreadable and inflating a ~30-byte error into a multi-MB payload. Detected on staging: ~280 failing cron invocations/day serialized ~516 MB/day of error payloads into the EventStore, growing `events.duckdb` to 1.8 GiB over one retention day and OOM-ing the `/invocations` dashboard. Any tenant workflow whose host-plugin call throws hits the same defect — this is platform hardening, not a demo issue.

## What Changes

- The worker-thread plugin loader appends a `//# sourceURL=sandbox-plugin:<name>` magic comment to `workerSource` before constructing the `data:` URL, so V8 names the module `sandbox-plugin:<name>` in stack traces. Frames become `at doFetch (sandbox-plugin:fetch:1361:18)` — function name and line:col preserved, no base64 blob.
- New spec requirement: stack frames originating in a plugin's worker module identify the plugin by its virtual name and never contain the `data:text/javascript` blob — including as observed in recorded `system.error` / `action.error` event payloads (regression guard for the staging incident).
- The `data:` import mechanism itself is unchanged (still no filesystem resolution, no node_modules lookup); only the module's displayed source name changes. `import.meta.url` inside the bundle remains the `data:` URL (status quo, documented as a known limitation in design).

Out of scope (deliberately deferred): an EventStore per-field payload size cap (defense-in-depth against any oversized payload), and source-map-level frame translation to original TypeScript files.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sandbox-plugin`: the descriptor/loading requirement ("The worker loads it via `data:text/javascript;base64,<...>` dynamic import") gains the sourceURL append and a new module-identity requirement: worker-module stack frames SHALL carry `sandbox-plugin:<name>` and SHALL NOT contain `data:text/javascript`.
- `sandbox`: the two requirement texts describing plugin serialization/loading (descriptor serialization, Phase 0 plugin load) are updated to state that the loader appends the `//# sourceURL=sandbox-plugin:<name>` comment before the `data:` import.

## Impact

- **Code**: `packages/sandbox/src/worker-plugin-loader.ts` (`loadPluginFromSource`) — append the comment; doc-comment update. The build-time metadata import in `packages/sandbox/src/vite/sandbox-plugins.ts` is intentionally untouched (its errors never reach the EventStore).
- **Tests**: `packages/sandbox/src/worker-plugin-loader.test.ts` (frame identity assertions); a plugin-event test asserting emitted `system.error` payloads carry the virtual name and no `data:text/javascript` substring.
- **EventBus / manifest / SDK surface**: unchanged. No `workflows/src/demo.ts` update required (no authoring-surface change); the demo's intentional `fail`/`boom` failure path is guest-side and unaffected.
- **Security**: no new sandbox globals or guest-visible surface; the loader still evaluates the same inert string. The existing guest-facing stack-opacity contract (`actions` spec: bridge-collapsed stacks contain no `data:text/javascript`) is complemented, not altered.
- **Operations**: stored error rows for host-plugin failures drop from ~0.5–3.5 MB to KB-scale; existing fat rows age out via time-based retention on their own.
