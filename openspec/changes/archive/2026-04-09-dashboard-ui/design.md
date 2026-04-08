## Context

The workflow engine processes events through Trigger → Event → Action chains linked by `correlationId`. Events are persisted to a filesystem-backed queue and indexed in an in-memory DuckDB instance (`EventStore`) with full Kysely query support. The runtime serves HTTP triggers via Hono. There is currently no way to observe runtime state — operators must rely on structured logs.

The EventStore uses an append-only model: each state transition (pending → processing → done/failed/skipped) creates a new row. Querying "current state" requires selecting the latest row per event `id`.

A static HTML preview (`preview-dashboard.html`) has been created and validated as the design reference for layout, styling, and interaction patterns.

## Goals / Non-Goals

**Goals:**
- Provide real-time visibility into workflow executions (correlationIds) with state, event counts, and timestamps
- Allow drilling into individual executions to see the full event/action timeline as a visual graph
- Support filtering by state and event type, with infinite scroll pagination
- Deliver live updates via SSE without page refresh
- Ship as a built-in feature with zero additional deployment requirements

**Non-Goals:**
- No authentication/authorization — this is an internal operations dashboard
- No write operations — the dashboard is strictly read-only
- No action replay, retry, or manual intervention capabilities
- No historical analytics, aggregation, or charting
- No custom theming beyond automatic dark/light mode detection
- No interaction with the sandbox boundary — dashboard does not execute or inspect action code

## Decisions

### 1. Dashboard as Hono sub-app middleware

The dashboard is implemented as a Hono sub-app returned inside a standard `Middleware` object (`{ match, handler }`). Internally it has full Hono routing; externally it plugs into `createServer` like any other middleware.

```
dashboardMiddleware(eventStore, sseConsumer): Middleware
  match: "/dashboard/*"
  handler: sub-app with routes for page, fragments, SSE, static assets
```

**Why over separate server:** Single port, no CORS, simpler deployment, matches existing architecture.
**Why over extending createServer:** Zero changes to the server factory — the middleware interface is sufficient.

### 2. HTMX + Alpine.js + server-rendered HTML

The page shell is served at `GET /dashboard`. Dynamic content is loaded via HTMX fragment requests. Alpine.js handles the tooltip (positioning a portal element via `getBoundingClientRect`).

**Why over React/Svelte SPA:** No build step for frontend, no API layer to design, server-rendered fragments are the natural unit for HTMX. Alpine handles the one interaction (tooltips) that pure CSS cannot (scroll container clipping).

**Why Alpine over Hyperscript:** Alpine is stable (v3), uses standard JS expressions, has good editor support. Hyperscript is experimental (0.x) with an unfamiliar DSL.

### 3. JS assets via Vite `?raw` import

`alpinejs` and `htmx.org` are npm dependencies. Their minified files are imported as strings via Vite's `?raw` suffix and served at `/dashboard/alpine.js` and `/dashboard/htmx.js` with immutable cache headers.

```ts
import alpineJs from "alpinejs/dist/cdn.min.js?raw";
```

**Why over CDN:** Self-contained, no external network dependency. HTML is fully self-sufficient.
**Why over Vite bundle entrypoint:** These are pre-built libraries. Raw import avoids an unnecessary build step while still embedding them in the final bundle.
**Docker impact:** None — Vite inlines the strings into `dist/main.js` at build time.

### 4. Server-generated SVG for timelines

The timeline graph is rendered as SVG on the server when `GET /dashboard/timeline/:correlationId` is requested. The server builds the event tree from `parentEventId` links, computes layout (evenly spaced X, branching Y), and emits SVG markup with Alpine `@mouseenter`/`@mouseleave` attributes on each node.

```
Event tree → Layout algorithm → SVG string → HTMX fragment response
```

**Layout rules:**
- X-axis: evenly spaced (topology view, not time-proportional)
- Y-axis: root at center, branches fan out vertically from parent
- Container: `max-height: 50vh` with scroll, horizontal scroll on overflow
- Edges: cubic bezier SVG paths

**Why SVG over Canvas/D3:** Server-rendered, no client JS library, works with HTMX fragment swaps, CSS variables for theming, native hover events for Alpine tooltips.

### 5. SSE via new BusConsumer

A new `BusConsumer` implementation is registered on the EventBus. On each event, it records the affected `correlationId`. A 1-second debounce window batches changes, then the consumer renders updated HTML fragments and pushes them to all connected SSE clients via `hx-swap-oob`.

```
EventBus.emit(event)
  → ... existing consumers ...
  → SSEConsumer.handle(event)
      → collect correlationId
      → after 1s debounce: render fragments, push to clients
```

**Fragments pushed per update:**
- Updated entry rows (changed state/count/time)
- Updated header stats (pending/failed/done counts)
- Updated open timelines (if a correlationId with an expanded timeline changed)
- Updated filter dropdown (if a new initial event type appeared)

**Why separate BusConsumer over extending EventStore:** Keeps EventStore focused on indexing/querying. The SSE consumer has different concerns (connection management, debouncing, HTML rendering).

**Why OOB push over notify-then-fetch:** Single round-trip. The server already has the data and the rendering logic — sending pre-rendered HTML avoids a fetch cascade from the client.

### 6. Append-only query pattern

All dashboard queries need the "latest state per event" subquery:

```sql
WITH latest AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY id ORDER BY createdAt DESC
  ) AS rn FROM events
)
SELECT ... FROM latest WHERE rn = 1
```

This CTE is shared across list, timeline, stats, and filter queries. It will be encapsulated in a dashboard-specific query module that consumes `eventStore.query`.

### 7. Aggregate state derivation

Per-correlationId state is derived from the set of current event states:

```
any pending/processing  →  PENDING (yellow)
else any failed         →  FAILED  (red)
else                    →  DONE    (green)
```

Skipped events are treated as completed (do not affect aggregate state negatively).

## Sequence: Page Load

```
Browser                    Hono Server                EventStore
  │                            │                          │
  │  GET /dashboard            │                          │
  │───────────────────────────▶│                          │
  │  ◀── HTML shell + CSS +    │                          │
  │      <script src=alpine>   │                          │
  │      <script src=htmx>     │                          │
  │      hx-get="/dashboard/list" hx-trigger="load"       │
  │      sse-connect="/dashboard/events"                   │
  │                            │                          │
  │  GET /dashboard/list       │                          │
  │───────────────────────────▶│  query: correlations     │
  │                            │─────────────────────────▶│
  │                            │  ◀── rows                │
  │  ◀── HTML fragment (rows)  │                          │
  │                            │                          │
  │  GET /dashboard/events     │                          │
  │───────────────────────────▶│  (SSE connection held)   │
  │  ◀── SSE stream open       │                          │
```

## Sequence: Expand Timeline

```
Browser                    Hono Server                EventStore
  │                            │                          │
  │  click entry row           │                          │
  │  GET /dashboard/timeline/  │                          │
  │      corr_abc123           │                          │
  │───────────────────────────▶│  query: events by corrId │
  │                            │─────────────────────────▶│
  │                            │  ◀── events[]            │
  │                            │                          │
  │                            │  build tree, compute     │
  │                            │  layout, render SVG      │
  │                            │                          │
  │  ◀── SVG fragment          │                          │
  │  (HTMX swaps into DOM)     │                          │
```

## Sequence: Live Update via SSE

```
Scheduler                  EventBus                  SSEConsumer        Browser
  │                            │                          │                │
  │  action completes          │                          │                │
  │  emit(event, state=done)   │                          │                │
  │───────────────────────────▶│                          │                │
  │                            │  handle(event)           │                │
  │                            │─────────────────────────▶│                │
  │                            │                          │  collect corrId│
  │                            │                          │  ...1s debounce│
  │                            │                          │                │
  │                            │                          │  render frags  │
  │                            │                          │  push SSE      │
  │                            │                          │───────────────▶│
  │                            │                          │  OOB swap      │
  │                            │                          │  (entry row +  │
  │                            │                          │   header stats)│
```

## Risks / Trade-offs

**[DuckDB query performance on large datasets]** → The append-only model means the `events` table grows with every state transition. The `ROW_NUMBER()` window function scans all rows. → Mitigation: DuckDB is columnar and handles analytical queries well. For very large datasets, periodic compaction (keeping only latest state per event) could be added later.

**[SSE connection management]** → Each open browser tab holds an SSE connection. Many tabs = many connections. → Mitigation: Acceptable for an internal dashboard. Hono/Node handles thousands of idle connections efficiently. Add a connection limit if needed later.

**[SVG rendering cost for large event trees]** → A correlationId with hundreds of events produces a large SVG. → Mitigation: Timeline loads all events at once (unlikely to have thousands per correlationId). The 50vh container with scrollbars handles visual overflow.

**[Alpine.js in SVG]** → Alpine event handlers on SVG `<g>` elements is less commonly tested than on HTML. → Mitigation: Validated in the preview prototype. `@mouseenter`/`@mouseleave` work on SVG group elements in all modern browsers.

**[OOB swap complexity]** → Pushing multiple OOB fragments in a single SSE message requires careful ID matching. → Mitigation: Each fragment has a deterministic ID (`entry-{correlationId}`, `header-stats`, etc.). HTMX OOB is well-documented for this pattern.
