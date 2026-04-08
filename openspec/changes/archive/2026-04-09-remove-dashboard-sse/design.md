## Context

The dashboard currently uses SSE via `htmx-ext-sse` for live updates. An `SseConsumer` listens on the event bus, debounces changed correlation IDs, re-queries the event store, and pushes re-rendered HTML rows + stats as OOB swaps over the SSE stream. This mechanism is unreliable with htmx and adds unnecessary complexity. The dashboard will become static (load-on-demand via htmx GET requests, refresh via browser reload).

## Goals / Non-Goals

**Goals:**
- Remove all SSE infrastructure from the dashboard
- Simplify view rendering by removing OOB swap plumbing
- Remove `htmx-ext-sse` dependency

**Non-Goals:**
- Adding a manual refresh button or polling mechanism
- Changing the htmx-based on-demand loading (list, filters, pagination, timeline)
- Modifying Alpine.js client-side interactivity

## Decisions

**1. Delete `sse-consumer.ts` entirely rather than keeping it dormant**

The `SseConsumer` implements `BusConsumer` and runs on every event in the pipeline. Removing it eliminates unnecessary event bus processing. No other code depends on it.

**2. Remove `htmx-ext-sse` npm dependency**

With no SSE endpoint, the extension is dead code. Removing it from `package.json` shrinks the bundle and removes a dependency.

**3. Simplify `renderEntryRow` and `renderHeaderStats` signatures**

The `oob` parameter on `renderEntryRow` and `renderHeaderStats` exists solely for SSE push updates. With SSE removed, these functions always render in non-OOB mode. Remove the parameter and the dedup `x-init` logic.

**4. `dashboardMiddleware` no longer needs `SseConsumer`**

The middleware function signature changes from `(eventStore, sseConsumer)` to `(eventStore)`. The `/dashboard/events` route and `createSseResponse()` are removed. The `htmx-sse.js` static asset route is removed.

## Risks / Trade-offs

- [No live updates] → Acceptable. User explicitly chose browser reload as the refresh mechanism. The dashboard is a debugging/monitoring aid, not a real-time operations console.
- [OOB swap removal changes `renderEntryRow` export signature] → Only consumed internally by `middleware.ts` and within `list.ts`. No external API impact.
