## Why

There is no way to manually trigger workflow events for testing or debugging. The only entry point is the webhook HTTP triggers, which require crafting raw HTTP requests with correctly shaped JSON payloads. A web UI that lists all defined events with auto-generated forms from their Zod schemas would make it trivial to fire events manually.

## What Changes

- Add a new `/trigger` endpoint serving an HTML page that lists all defined workflow events
- Each event is expandable and shows a form auto-generated from its JSON Schema (derived from the Zod schema via `z.toJSONSchema()`)
- Form submission emits events directly onto the event bus via `EventSource.create()`
- Add a shared layout with a navigation sidebar used by both the dashboard and trigger UI
- Refactor the existing dashboard to use the shared layout
- Add `jedison` as a dependency for client-side JSON Schema form rendering
- Convert Zod schemas to JSON Schema eagerly at registration time in `main.ts`

## Capabilities

### New Capabilities
- `trigger-ui`: Web UI at `/trigger` for manually triggering workflow events via auto-generated forms
- `shared-layout`: Shared HTML layout with navigation sidebar reused across dashboard and trigger UI

### Modified Capabilities
- `dashboard-middleware`: Refactor to use the shared layout instead of owning the full HTML shell

## Impact

- **New middleware**: `triggerMiddleware` added to the HTTP server alongside existing middleware
- **Dashboard refactor**: `renderPage()` extracted into shared layout; dashboard-specific content separated from the HTML shell
- **Dependencies**: `jedison` npm package added to `packages/runtime`
- **Registration**: `registerWorkflows()` in `main.ts` gains a new return value (`allJsonSchemas`) for pre-computed JSON Schemas
- **Static assets**: Jedison JS vendored and served from `/trigger/jedison.js`
- No changes to the QueueStore interface, manifest format, or sandbox boundary
