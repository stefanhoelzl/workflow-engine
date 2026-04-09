## Context

The workflow engine serves a dashboard UI at `/dashboard` using Hono, HTMX, and Alpine.js (server-rendered HTML). Events enter the system through HTTP triggers at `/webhooks/*`, validated against Zod schemas and emitted via `EventSource`. There is currently no way to manually fire events without crafting raw HTTP requests.

The recent `EventSource` refactor unified event creation and emission behind a single interface: `source.create(type, payload, sourceName)`. This provides a clean entry point for the trigger UI.

## Goals / Non-Goals

**Goals:**
- Provide a web UI for manually triggering any defined workflow event
- Auto-generate forms from Zod event schemas using JSON Schema
- Reuse the existing CSS variable theming system for consistent light/dark mode
- Introduce a shared layout with sidebar navigation for both dashboard and trigger UI

**Non-Goals:**
- Authentication or access control for the trigger UI
- Persisting form state or submission history
- Editing or replaying existing events
- No new API surface is exposed to sandboxed actions

## Decisions

### 1. Jedison for client-side form rendering

**Choice:** Use the `jedison` library to render forms from JSON Schema on the client side.

**Alternatives considered:**
- **Server-side HTML generation** — Walk the JSON Schema and emit `<input>`/`<select>` elements server-side. Zero client JS but limited: no nested objects, no client-side validation, manual work for each Zod type.
- **@json-editor/json-editor** — Mature (4,900 stars), but does not support JSON Schema Draft 2020-12 (which `z.toJSONSchema()` outputs). Requires a `$defs` → `definitions` compatibility shim. In maintenance mode; its own maintainer recommends Jedison as successor.
- **@jsfe/form** — Lightweight Web Component, but uses Shadow DOM which breaks HTMX event handling and CSS styling from the outside.

**Rationale:** Jedison natively supports Draft 2020-12, has zero dependencies, a clean `getValue()` API, no Shadow DOM, and a barebones theme suitable for custom CSS. ~198 KB minified, vendored from `node_modules` (same pattern as Alpine.js and HTMX).

### 2. Eager JSON Schema conversion at registration time

**Choice:** Convert Zod schemas to JSON Schema via `z.toJSONSchema()` once during `registerWorkflows()` in `main.ts`. The trigger middleware receives `Record<string, object>` (plain JSON Schema objects).

**Alternatives considered:**
- **Pass `z.ZodType` to trigger middleware** — Would require widening the `allEvents` type from `{ parse }` to `z.ZodType`, leaking Zod into modules that don't need it.
- **Lazy conversion per request** — Unnecessary overhead; schemas don't change at runtime.

**Rationale:** Clean separation. The trigger middleware never imports Zod. JSON Schemas are computed once and embedded directly into the HTML response.

### 3. Direct `EventSource.create()` for submission

**Choice:** The POST handler calls `source.create(eventType, body, "trigger-ui")` directly.

**Alternatives considered:**
- **Route through HTTP trigger machinery** — Would require fabricating a fake `HttpTriggerResolved` definition. The trigger UI is conceptually a different event source, not an HTTP webhook.
- **New `ContextFactory.manual()` method** — Over-abstraction; `ContextFactory` was already removed in the recent refactor.

**Rationale:** Follows the same pattern as `httpTriggerMiddleware` (which calls `source.create(eventType, body, triggerName)`). The `sourceType: "trigger"` and `sourceName: "trigger-ui"` fields on the resulting `RuntimeEvent` identify the origin.

### 4. Lazy Jedison initialization on `<details>` toggle

**Choice:** Embed JSON Schema as `<script type="application/json">` inside each `<details>` block. Initialize the Jedison instance on the first `toggle` event. Cache the instance for subsequent toggles.

**Rationale:** Avoids creating N Jedison instances on page load. Only the expanded event pays the initialization cost. Native `<details>` provides expand/collapse with zero JavaScript.

### 5. `htmx.ajax()` for form submission

**Choice:** A global `submitEvent(el, type)` function calls `htmx.ajax('POST', ...)` with the JSON body from `jedison.getValue()`.

**Alternatives considered:**
- **`hx-post` with `htmx:configRequest` listener** — Would require a global event listener with logic to find the matching Jedison instance per button.
- **Plain `fetch()`** — Loses HTMX swap transitions and loading state indicators.

**Rationale:** Explicit wiring from button → Jedison instance → HTMX POST. No global listeners. HTMX still handles the response swap (HTML fragment banner).

### 6. Shared layout with full sidebar

**Choice:** Extract a `renderLayout(title, content)` function producing the HTML shell with a ~200px sidebar (icon + text labels for navigation). Both dashboard and trigger UI use this layout.

**Rationale:** The dashboard currently owns the full HTML shell (CSS variables, scripts, body structure). Adding a second page requires extracting the shared parts. A sidebar provides persistent navigation between pages.

## Risks / Trade-offs

- **Jedison maturity (49 stars, solo maintainer)** → Acceptable for internal tooling. The library is actively maintained (last release: April 2026) and has zero dependencies. If abandoned, the interface is simple enough to replace.
- **Bundle size (~198 KB minified for Jedison)** → Served with immutable cache headers. Loaded only on the trigger page, not the dashboard.
- **Dashboard refactor scope** → Extracting the shared layout touches `renderPage()` and the dashboard middleware. Risk of visual regression. Mitigated by the CSS variable system being self-contained.
- **No HTMX `json-enc` extension** → The extension encodes native form fields, not Jedison's internal state. Using `htmx.ajax()` directly is more appropriate but means the submit button isn't declarative `hx-post`.

```
  GET /trigger                         POST /trigger/:eventType
       │                                    │
       ▼                                    ▼
  allJsonSchemas                       req.body (JSON from
  Record<string, object>               jedison.getValue())
       │                                    │
       │  embedded in HTML as               │  source.create(type, body, "trigger-ui")
       │  <script type=                     │
       │   "application/json">              ├── success
       ▼                                    │   → <div class="banner success">
  Jedison renders form                  │      Event emitted</div>
  (lazy, on <details> open)             │
                                        └── PayloadValidationError
                                            → <div class="banner error">
                                               Field x: required</div>
```
