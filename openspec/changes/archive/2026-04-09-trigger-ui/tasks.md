## 1. Dependencies and Registration

- [x] 1.1 Add `jedison` to `packages/runtime/package.json` and install
- [x] 1.2 Add `z.toJSONSchema()` conversion in `registerWorkflows()` in `main.ts`, returning `allJsonSchemas: Record<string, object>` alongside `allEvents`

## 2. Shared Layout

- [x] 2.1 Create `packages/runtime/src/views/layout.ts` with `renderLayout(title, content)` function containing the HTML shell, CSS variables, sidebar navigation, and script tags
- [x] 2.2 Refactor `packages/runtime/src/dashboard/views/page.ts` to use `renderLayout()` instead of owning the full HTML shell
- [x] 2.3 Update `packages/runtime/src/dashboard/middleware.ts` to pass dashboard-specific content to the shared layout

## 3. Trigger Middleware

- [x] 3.1 Create `packages/runtime/src/trigger/middleware.ts` with `triggerMiddleware(allJsonSchemas, source)` factory returning a `Middleware` object matching `/trigger/*`
- [x] 3.2 Implement `GET /trigger/` route rendering the event list page with `<details>` blocks, embedded JSON Schemas, and Jedison form containers
- [x] 3.3 Implement `GET /trigger/jedison.js` route serving vendored Jedison JS with immutable cache headers
- [x] 3.4 Implement `POST /trigger/:eventType` route calling `source.create()` and returning success/error HTML fragment banners
- [x] 3.5 Add inline `<script>` with `initForm(el)` for lazy Jedison initialization on `<details>` toggle and `submitEvent(el, type)` for `htmx.ajax()` submission

## 4. Styling

- [x] 4.1 Add CSS for Jedison base theme overrides targeting `input`, `select`, `textarea`, `label`, `fieldset` using shared CSS variables
- [x] 4.2 Add CSS for success/error banners using `--green-bg`/`--green-border` and `--red-bg`/`--red-border` variables

## 5. Wiring

- [x] 5.1 Wire `triggerMiddleware(allJsonSchemas, source)` into `createServer()` in `main.ts`

## 6. Verification

- [x] 6.1 Run `pnpm lint`, `pnpm check`, and `pnpm test` to ensure all checks pass
