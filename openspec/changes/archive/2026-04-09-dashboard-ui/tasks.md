## 1. Dependencies and Setup

- [x] 1.1 Add `alpinejs` and `htmx.org` as dependencies in `packages/runtime/package.json` and run `pnpm install`

## 2. Dashboard Middleware Shell

- [x] 2.1 Create `packages/runtime/src/dashboard/middleware.ts` with the `dashboardMiddleware` factory returning a `Middleware` with `match: "/dashboard/*"` and an internal Hono sub-app
- [x] 2.2 Add static asset routes: `GET /alpine.js` and `GET /htmx.js` serving raw-imported JS with immutable cache headers
- [x] 2.3 Add `GET /` route serving the HTML page shell with CSS (dark/light mode), script tags, HTMX attributes for list loading and SSE connection
- [x] 2.4 Wire `dashboardMiddleware(eventStore)` into `main.ts` alongside the existing `httpTriggerMiddleware`

## 3. Dashboard Query Module

- [x] 3.1 Create `packages/runtime/src/dashboard/queries.ts` with a shared "latest state per event" CTE builder using `ROW_NUMBER() OVER (PARTITION BY id ORDER BY createdAt DESC)`
- [x] 3.2 Implement `listCorrelations(query, { state?, type?, cursor? })` returning correlation summaries with aggregate state, initial event type, event count, last event time, sorted pending-first then by time desc, with cursor-based pagination
- [x] 3.3 Implement `getTimeline(query, correlationId)` returning all events (latest state per id) for a correlationId with full fields
- [x] 3.4 Implement `getDistinctEventTypes(query)` returning distinct root event types (where `parentEventId IS NULL`)
- [x] 3.5 Implement `getHeaderStats(query)` returning counts per aggregate state
- [x] 3.6 Write tests for all query functions using an in-memory EventStore with test data

## 4. List View

- [x] 4.1 Create `packages/runtime/src/dashboard/views/list.ts` with a function that renders entry row HTML fragments from correlation summary data (state dot, event type, count, time, badge, chevron)
- [x] 4.2 Add `GET /list` route to the dashboard sub-app that calls `listCorrelations`, renders entry rows, and includes the infinite scroll sentinel when more pages exist
- [x] 4.3 Add header stats rendering and filter bar (state buttons + event type dropdown) to the page shell
- [x] 4.4 Support `state`, `type`, and `cursor` query parameters on the list route for filtering and pagination

## 5. Timeline View

- [x] 5.1 Create `packages/runtime/src/dashboard/views/timeline.ts` with a tree layout algorithm: build tree from `parentEventId` links, assign evenly-spaced X positions, fan out branches on Y axis
- [x] 5.2 Implement SVG rendering: node circles (colored by state, hollow for skipped), labels (event type + action name), curved bezier edges between parent and child nodes
- [x] 5.3 Add Alpine.js `@mouseenter`/`@mouseleave` attributes on each SVG node `<g>` for tooltip positioning, embedding event data (type, state, action, time, payload, error) in the handler
- [x] 5.4 Add `GET /timeline/:correlationId` route to the dashboard sub-app that calls `getTimeline`, runs the layout algorithm, and returns the SVG fragment
- [x] 5.5 Write tests for the tree layout algorithm with linear chains, single branches, and multi-branch scenarios

## 6. SSE Live Updates

- [x] 6.1 Create `packages/runtime/src/dashboard/sse-consumer.ts` implementing `BusConsumer` that records changed correlationIds on `handle()` and debounces with a 1-second window
- [x] 6.2 Add client connection management: track connected SSE response streams, push to all on debounce flush, clean up on disconnect
- [x] 6.3 Implement fragment rendering on flush: re-render affected entry rows, header stats, open timelines, and filter dropdown as OOB swap fragments
- [x] 6.4 Add `GET /events` route to the dashboard sub-app that opens an SSE stream and registers the response with the SSE consumer
- [x] 6.5 Register the SSE consumer on the EventBus in `main.ts` (after EventStore in consumer order)
- [x] 6.6 Write tests for debounce behavior: single event, rapid events for same correlationId, multiple correlationIds in one window

## 7. Integration and Polish

- [x] 7.1 Add the tooltip portal `<div>` to the page shell with Alpine.js `x-data`, `x-show`, `x-transition`, and positioning bindings
- [ ] 7.2 Verify expand/collapse works: clicking an entry header fetches the timeline via HTMX and toggles visibility
- [ ] 7.3 Verify infinite scroll: sentinel triggers next page load, last page has no sentinel
- [ ] 7.4 Verify SSE updates: entry rows, header stats, and open timelines update live when events flow through the system
- [ ] 7.5 Verify dark/light mode: CSS custom properties switch correctly based on `prefers-color-scheme`
- [x] 7.6 Run `pnpm lint`, `pnpm check`, and `pnpm test` — all must pass
