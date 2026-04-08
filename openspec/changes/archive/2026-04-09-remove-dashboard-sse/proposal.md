## Why

SSE-based live updates on the dashboard are unreliable with htmx. The complexity of the SSE consumer, OOB swap plumbing, and debounced push updates is not justified given the reliability issues. A static, load-on-demand dashboard is simpler and sufficient.

## What Changes

- **Remove SSE live-update pipeline**: Delete `sse-consumer.ts` and its test, remove the `/dashboard/events` SSE endpoint, and stop serving `htmx-ext-sse`.
- **Remove OOB swap plumbing**: Strip `hx-swap-oob` parameters from `renderEntryRow` and `renderHeaderStats`, remove dedup `x-init` logic from row rendering.
- **Remove SSE consumer from event bus**: Unregister `SseConsumer` as a bus consumer in `main.ts`, remove all related imports and wiring.
- **Simplify page shell**: Remove `#sse-container` div, `htmx-ext-sse` script tag, and the `htmx:oobAfterSwap` re-init script from `page.ts`.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

(none — this is a removal of internal implementation, no spec-level behavior changes)

## Impact

- **Code**: `sse-consumer.ts`, `sse-consumer.test.ts` deleted. `middleware.ts`, `views/page.ts`, `views/list.ts`, `main.ts` simplified.
- **Dependencies**: `htmx-ext-sse` npm package can be removed from `package.json`.
- **APIs**: `GET /dashboard/events` endpoint removed.
- **Runtime**: One fewer bus consumer in the event pipeline.
