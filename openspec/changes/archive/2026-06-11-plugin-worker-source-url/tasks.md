# Tasks: plugin-worker-source-url

## 1. Implementation

- [x] 1.1 In `packages/sandbox/src/worker-plugin-loader.ts` `loadPluginFromSource()`, append `\n//# sourceURL=sandbox-plugin:${descriptor.name}` to `descriptor.workerSource` before base64-encoding into the `data:` import URL; update the file's doc comment to describe the virtual module name.

## 2. Tests

- [x] 2.1 `packages/sandbox/src/worker-plugin-loader.test.ts`: load a descriptor whose worker function throws; assert the error's `stack` contains `sandbox-plugin:<name>` frames with `:<line>:<col>` and does NOT contain `data:text/javascript` (spec scenario "Worker-module throw carries the virtual name").
- [x] 2.2 Same test file: a `workerSource` whose final line is a `//` line comment still loads and produces `sandbox-plugin:<name>`-named frames (spec scenario "Bundle ending in a line comment still gets the virtual name").
- [x] 2.3 Security/regression test at the event boundary (in `packages/sandbox/src/plugin-runtime.test.ts` or via `test-harness.ts`, wherever emitted events are already asserted): drive a `ctx.request`-wrapped host call whose worker module throws; assert the emitted `system.error` event's `error.stack` contains `sandbox-plugin:<name>` and the JSON-serialized `error` payload does NOT contain `data:text/javascript` (spec scenario "Emitted error event payload is blob-free").
- [x] 2.4 Confirm the existing guest-facing stack-opacity tests (actions spec: bridge-collapsed stacks contain no `/var/`, `node_modules`, `data:text/javascript`) still pass unchanged.

## 3. Validation

- [x] 3.1 `pnpm validate` passes.
- [x] 3.2 `pnpm test:e2e` passes locally (change touches the plugin host-call loading path).

## 4. Dev probe (against `pnpm dev`)

- [x] 4.1 Start backgrounded `pnpm dev --random-port --kill`; wait for the `[READY] Dev server listening on http://localhost:<port>` marker and parse the port (recipes: `docs/dev-probes.md`). *(port 37939)*
- [x] 4.2 Fire a demo trigger that exercises a host-side plugin failure. *(Fired `GET /webhooks/local-user/demo-repo/demo/ping` → `runDemo`; network was up so fetch succeeded, but `querySql`'s deliberate SQL syntax error throws host-side from the sql plugin's worker module — the same event class as staging's `executeSql` errors.)*
- [x] 4.3 Inspect the stored events: host-plugin error payloads carry frames matching `sandbox-plugin:sql:<line>:<col>` (e.g. `at throwStructured (sandbox-plugin:sql:4406:9)`), the entire run output contains ZERO `data:text/javascript` occurrences, and the serialized `error` payload is ~330 bytes (vs ~0.5 MB for this event class on staging). Verified via committed-row insert logs (13 `event-store.commit-ok`); read-only DuckLake attach was blocked by the un-checkpointed WAL.
- [x] 4.4 Fire the `fail` manual trigger (`POST /trigger/local-user/demo-repo/demo/fail`) and confirm the intentional `boom` path still records its `action.error` / `trigger.error` pair — confirmed, with clean guest-side frames (`demo.js:<line>`, `<plugin:action-dispatch>`).
- [x] 4.5 Kill the dev-server process tree. *(TaskStop; port probe confirms dead.)*
