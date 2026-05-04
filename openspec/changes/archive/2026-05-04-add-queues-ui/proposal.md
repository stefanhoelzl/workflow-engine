## Why

Workflow authors can declare per-workflow durable FIFO queues via `defineQueue`, but the UI offers no way to inspect what those queues currently hold. Today the only ways to see queue state are SSH into the server and `cat` the NDJSON file, or write a one-shot debugging trigger that calls `get()` (which destructively dequeues). Operators and authors need a read-only inspection surface to debug stuck consumers, verify producers, and confirm queue contents after re-uploads — without leaking the file format to guest code or introducing a destructive UI action.

## What Changes

- Add a new top-level UI surface at `/queue` mirroring the scope hierarchy of `/trigger` (`/queue`, `/queue/:owner`, `/queue/:owner/:repo`, `/queue/:owner/:repo/:workflow`). Authenticated, `requireOwnerMember()`-gated, 404 on non-membership.
- Add a third in-page tab labelled **"Queues"** to the shared tab strip (`Invocations | Trigger | Queues`). Tab visibility is universal across the authenticated UI; existing tabs are not renamed.
- Render one collapsed card per *declared* queue under the current scope, showing an adaptive title (full `owner/repo/workflow/queue` breadcrumb at root scope; queue name only at workflow scope) and the current item count. Workflows with no `defineQueue` declarations are not listed.
- On card expand, lazily fetch a server-rendered HTML fragment of the first 50 items from `GET /queue/:owner/:repo/:workflow/:queue/items?offset=0`. A "Load more" button appends the next 50 items via the same endpoint with `?offset=50`, etc. Refresh is page reload; no auto-polling.
- Items render in FIFO order (oldest first — i.e. next to be dequeued first), as raw queue payloads. No per-item position label, timestamp, or schema badge.
- Add a new shared Alpine component `wfe-json-tree` rendering interactive collapsible JSON, fully expanded by default, CSP-clean (no inline scripts/styles), bound via `data-*` hooks. Used inline by the new queue items fragment and by the existing `result-dialog.js` (trigger results + flamegraph action req/resp), which migrates from `<pre>+JSON.stringify` to embed the new component.
- Carve out the host-side read path in the `queues` capability: scope the existing "no inspection or peek operations" invariant to the *guest* surface, and add an explicit requirement that the runtime MAY read queue files for host-side inspection (read-only, tolerates partial trailing line from concurrent `put`, never blocks `put`/`get`).
- The runtime route handler reads NDJSON files directly (no new sandbox host-call, no new SDK surface), composing paths via the same helpers used by the existing queue file lifecycle code.

## Capabilities

### New Capabilities
- `queues-ui`: HTTP routes, authentication contract, page composition (cards + lazy items fragment), and pagination semantics for the read-only queue inspection UI at `/queue`.

### Modified Capabilities
- `queues`: scope the "no inspection or peek operations" invariant to the guest surface and add a "host-side read-only inspection" requirement (covering partial-trailing-line tolerance and non-blocking concurrent `put`/`get`).
- `shared-layout`: extend the in-page tab strip's enumeration to include the new `Queues` tab pointing at `/queue`.
- `ui-foundation`: add a "shared interactive JSON-tree component" requirement (collapsible, fully-expanded default, CSP-clean, keyboard accessible) that backs both the queue items renderer and the migrated `result-dialog.js`.
- `trigger-ui`: update the trigger result dialog requirement to render JSON via the shared tree component instead of `<pre>+JSON.stringify`.

## Impact

- **New code**:
  - `packages/runtime/src/ui/queue/middleware.tsx`, `packages/runtime/src/ui/queue/page.tsx`, `packages/runtime/src/ui/queue/items-fragment.tsx`, `packages/runtime/src/ui/queue/queue-read.ts` (NDJSON reader with line-by-line tolerant parse).
  - `packages/runtime/src/ui/static/json-tree.js` (Alpine component) and accompanying CSS in `workflow-engine.css`.
- **Modified code**:
  - `packages/runtime/src/ui/tabs.tsx` (append `Queues` tab entry).
  - `packages/runtime/src/ui/static/result-dialog.js` (migrate JSON rendering to `wfe-json-tree`).
  - `packages/runtime/src/ui/layout.tsx` (load `json-tree.js` script).
  - `packages/runtime/src/main.ts` and the HTTP wiring (mount the new `/queue` middleware).
- **Specs**: one new (`queues-ui`), four modified (`queues`, `shared-layout`, `ui-foundation`, `trigger-ui`).
- **Security**: same auth contract as `/trigger` (`sessionMiddleware` + `requireOwnerMember()`, fail-closed 404 on non-membership). No new sandbox surface; no new SDK API; no `'unsafe-*'` CSP directives. The host-side queue read is non-mutating and respects the existing single-writer file lifecycle (rename-based atomic swap on `get`, append-only `put`).
- **No infrastructure or deploy-path changes**.
- **Verification**: dev probes against `pnpm dev` (curl the new routes for empty/populated/cross-owner/non-member cases; expand a card in the browser and confirm JSON-tree renders + load-more appends). No cluster smoke required (no edge/auth/infra surface touched).
