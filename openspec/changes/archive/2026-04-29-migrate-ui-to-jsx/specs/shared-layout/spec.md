## MODIFIED Requirements

### Requirement: Shared layout API

The system SHALL provide a `<Layout>` JSX component (in `packages/runtime/src/ui/layout.tsx`) that returns a complete HTML document with a top bar, navigation sidebar, and content area. The component SHALL accept the following props: `title`, `activePath`, `user`, `email`, an optional `sidebarTree` slot carrying a pre-rendered sidebar JSX subtree for the current request, and `children` carrying the page-specific content.

When `sidebarTree` is supplied, the sidebar SHALL render that subtree verbatim inside the sidebar container. When it is absent (e.g. the login page), the sidebar SHALL render only the top-level nav-link list (Dashboard / Trigger).

The component SHALL be a synchronous function. Async data fetches required to build the sidebar or page content SHALL be performed in route handlers before invoking `c.html(<Layout/>...)`; the component itself SHALL NOT receive `Promise`-typed props.

The `<Layout>` component SHALL emit `<!DOCTYPE html>` ahead of `<html>` so browsers render the page in standards mode.

#### Scenario: Layout accepts the sidebarTree slot

- **GIVEN** `<Layout title="..." activePath="..." user="..." email="..." sidebarTree={tree}>...</Layout>` is rendered with a non-empty `sidebarTree`
- **THEN** the output SHALL embed the supplied subtree inside the sidebar container
- **AND** the output SHALL NOT include a separate nav-link list above the tree

#### Scenario: Layout emits DOCTYPE

- **WHEN** any `<Layout/>` is rendered
- **THEN** the response body SHALL begin with `<!DOCTYPE html>` followed by `<html lang="en">`

### Requirement: Shared script tags

The layout SHALL include `<script>` tags referencing client-side JavaScript files served from the static middleware at `/static/` paths. The full script set is emitted unconditionally on every page rendered by `<Layout>`; there is no per-surface `head` slot for surface-specific script injection.

The emitted scripts SHALL include at minimum: `/static/alpine.js` (deferred), `/static/htmx.js`, `/static/result-dialog.js` (deferred), `/static/local-time.js` (deferred), `/static/flamegraph.js` (deferred), and `/static/trigger-forms.js` (deferred).

#### Scenario: Scripts included on every page

- **WHEN** any `<Layout/>` is rendered
- **THEN** the HTML SHALL include `<script defer src="/static/alpine.js">` and `<script src="/static/htmx.js">`
- **AND** the HTML SHALL include `<script defer src="/static/flamegraph.js">` and `<script defer src="/static/trigger-forms.js">` regardless of which surface is rendering

#### Scenario: No per-surface head injection

- **GIVEN** the dashboard surface and the trigger surface render via the same `<Layout/>` component
- **THEN** both surfaces SHALL emit the identical `<script>` tag set
- **AND** there SHALL NOT be a `head` prop on `<Layout/>` for surface-specific tag injection
