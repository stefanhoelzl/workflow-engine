## Why

The workflow engine processes events but provides no visibility into what's happening at runtime. Operators have no way to see which workflow executions are in progress, which have failed, or to inspect the event chain for debugging. A built-in dashboard eliminates the need for external monitoring tools and gives immediate observability out of the box.

## What Changes

- Add a real-time web dashboard served from the existing Hono server at `/dashboard`
- Add server-rendered HTML with HTMX for interactivity, Alpine.js for tooltips, and server-generated SVG for timeline visualization
- Add a new SSE `BusConsumer` on the EventBus to push live updates to connected dashboard clients
- Add query capabilities against the existing EventStore (DuckDB) to power dashboard views
- Add `htmx.org` and `alpinejs` as runtime dependencies, bundled via Vite `?raw` imports (no external CDN)
- Dark/light mode auto-detection via CSS `prefers-color-scheme`

## Capabilities

### New Capabilities
- `dashboard-middleware`: Hono sub-app middleware serving the dashboard UI, static assets, HTML fragments, and SSE endpoint
- `dashboard-list-view`: Server-rendered list of workflow executions (correlationIds) with aggregate state, filtering, sorting, and infinite scroll
- `dashboard-timeline`: Server-generated SVG timeline graph showing the event/action tree for a single correlationId
- `dashboard-sse`: SSE-based live update system using a new BusConsumer that debounces changes and pushes OOB HTML fragments

### Modified Capabilities
- `event-store`: Needs query patterns for correlation summaries, event-by-correlationId, and distinct event types (existing Kysely query interface is sufficient, no interface change needed)
- `event-bus`: Needs the new SSE BusConsumer registered alongside existing consumers

## Impact

- **New routes**: `/dashboard`, `/dashboard/list`, `/dashboard/timeline/:correlationId`, `/dashboard/events`, `/dashboard/alpine.js`, `/dashboard/htmx.js`
- **New dependencies**: `alpinejs`, `htmx.org` in `packages/runtime/package.json`
- **Modified files**: `main.ts` (wire dashboard middleware and SSE consumer into init)
- **EventBus consumers**: New SSE consumer added to the consumer chain
- **No breaking changes**: All existing webhook/trigger functionality unchanged
- **No Dockerfile changes**: Vite `?raw` imports inline JS assets into the bundle
- **No sandbox impact**: Dashboard is read-only, does not interact with the action execution boundary
