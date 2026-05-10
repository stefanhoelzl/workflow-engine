# ui-foundation Specification

## Purpose
TBD - created by archiving change redesign-ui. Update Purpose after archive.
## Requirements
### Requirement: Theme detection via prefers-color-scheme

Every UI surface SHALL adapt its colour scheme to the user's `prefers-color-scheme` media query. Light and dark themes SHALL be the only themes; the runtime SHALL NOT expose a manual theme toggle, SHALL NOT persist a theme preference in any client-side storage, and SHALL NOT render a theme-selection UI.

#### Scenario: Dark-mode user gets dark theme

- **WHEN** any authenticated or anonymous UI surface is requested by a browser advertising `prefers-color-scheme: dark`
- **THEN** the rendered page SHALL use the dark-theme palette (dark surfaces, light text)

#### Scenario: Light-mode user gets light theme

- **WHEN** any UI surface is requested by a browser advertising `prefers-color-scheme: light`
- **THEN** the rendered page SHALL use the light-theme palette (light surfaces, dark text)

#### Scenario: No theme toggle UI is rendered

- **WHEN** any UI surface is rendered
- **THEN** the page SHALL NOT contain a theme-toggle control (button, switch, link, or form)
- **AND** the page SHALL NOT read or write a theme preference from `localStorage`, `sessionStorage`, or cookies

### Requirement: Reduced-motion respect

Every UI surface SHALL respect `prefers-reduced-motion: reduce`. Decorative transitions and animations SHALL be disabled when this preference is set. Indicators that carry meaning by motion (e.g. a pulse on a `running` status) MAY remain enabled when their meaning would be lost without motion; all other animations SHALL be suppressed.

#### Scenario: Hover transitions disabled under reduced-motion

- **GIVEN** a user with `prefers-reduced-motion: reduce` set
- **WHEN** they hover over an interactive element with a non-meaning-bearing transition (e.g. a button background fade)
- **THEN** the transition SHALL NOT animate

#### Scenario: Running-status pulse remains under reduced-motion

- **GIVEN** a user with `prefers-reduced-motion: reduce` set
- **WHEN** the dashboard lists a `running` invocation
- **THEN** the running-status indicator MAY continue to pulse to convey live state

### Requirement: CSP-clean rendering

Every UI surface SHALL render HTML that complies with the application's CSP. The rendered HTML SHALL NOT contain any inline `<style>` element, any inline `<script>` element with inline content (script tags pointing at same-origin `/static/*.js` are permitted; `<script type="application/json">` data is permitted), any attribute whose name matches `on[a-z]+`, any `style=` attribute, any `href=` or `src=` value beginning with `javascript:`, or any inline Alpine `x-data` object literal (Alpine components SHALL be pre-registered via `Alpine.data(...)` in `/static/*.js` modules).

#### Scenario: No inline styles on any rendered surface

- **WHEN** any authenticated, anonymous, or error UI surface is rendered
- **THEN** the response body SHALL NOT contain a `<style>` element
- **AND** SHALL NOT contain a `style=` attribute

#### Scenario: No inline scripts or event handlers

- **WHEN** any UI surface is rendered
- **THEN** the response body SHALL NOT contain a `<script>` element with inline content
- **AND** SHALL NOT contain any attribute whose name matches `on[a-z]+`
- **AND** SHALL NOT contain any `href` or `src` whose value begins with `javascript:`

#### Scenario: No inline Alpine component definitions

- **WHEN** any UI surface uses Alpine.js for interactivity
- **THEN** the rendered markup SHALL reference Alpine components by name via `x-data="<componentName>"` (string)
- **AND** SHALL NOT contain a free-form object literal in `x-data`

### Requirement: Keyboard focus visibility

Every interactive element on every UI surface SHALL render a visible focus indicator when focused via keyboard. The focus indicator SHALL be visible against both light and dark backgrounds.

#### Scenario: Tab navigation reveals focus

- **WHEN** a user navigates an authenticated UI surface using the keyboard (Tab / Shift+Tab)
- **THEN** the currently-focused interactive element (link, button, input, select, summary) SHALL render a visible focus indicator
- **AND** the indicator SHALL be visible regardless of the active theme

#### Scenario: Mouse click does not trigger focus ring

- **WHEN** a user clicks an interactive element with a pointer device
- **THEN** the focus indicator MAY be suppressed via `:focus-visible` to avoid a persistent ring on click-only interactions

### Requirement: Universal topbar

Every authenticated UI surface and every error page (404, 5xx) SHALL render the same topbar element. The topbar SHALL display the brand wordmark "Workflow Engine" coloured with the active accent token. User identity (username, email if available, and a sign-out control) SHALL render in the topbar if and only if the request resolved an authenticated session; otherwise the topbar SHALL render the wordmark alone.

The topbar SHALL NOT render different markup for different surface kinds. Surface-specific user-info suppression (forced-anonymous topbar on error pages) SHALL NOT exist; the topbar reads session state like any other page and degrades naturally when none is available.

The login page is explicitly exempt from this requirement. The login page is a self-contained auth card whose heading SHALL carry the brand wordmark "Workflow Engine" in the active accent token, replacing the topbar's branding role. The login page SHALL NOT render the topbar element.

#### Scenario: Authenticated surface shows user identity

- **GIVEN** a user with a valid session cookie
- **WHEN** any authenticated UI surface (e.g. `/invocations`, `/trigger`) is rendered
- **THEN** the topbar SHALL display the brand wordmark
- **AND** the topbar SHALL display the user's username and (if available) email address
- **AND** the topbar SHALL include a sign-out control

#### Scenario: Login page omits the topbar

- **WHEN** the login page is rendered
- **THEN** the response SHALL NOT contain the topbar element
- **AND** the auth card heading SHALL contain the brand wordmark "Workflow Engine"
- **AND** the brand wordmark SHALL be styled with the active accent token

#### Scenario: Anonymous error page shows wordmark only

- **WHEN** an error page (404 or 5xx) is rendered for a request without a valid session
- **THEN** the topbar SHALL display the brand wordmark
- **AND** the topbar SHALL NOT display any user identity

#### Scenario: Authenticated user hits an error page

- **GIVEN** a user with a valid session cookie
- **WHEN** they request a non-existent path and receive a 404
- **THEN** the topbar SHALL display the brand wordmark
- **AND** the topbar SHALL display the user's username (and email if available)

### Requirement: Asset delivery contract

The runtime SHALL serve UI assets at URL paths beginning with `/static/`. Responses for matched paths SHALL carry a `Content-Type` matching a content-type whitelist (CSS, JavaScript, HTML at minimum) and a `Cache-Control` header setting the response immutable for one year (`public, max-age=31536000, immutable`). Rendered UI surfaces SHALL reference scripts and stylesheets only from same-origin `/static/*` paths; no external origin SHALL be referenced for executable code or styling.

#### Scenario: Static CSS file served with correct headers

- **WHEN** a `GET /static/workflow-engine.css` request is made
- **THEN** the response body contains the CSS file content
- **AND** `Content-Type` is `text/css`
- **AND** `Cache-Control` is `public, max-age=31536000, immutable`

#### Scenario: Static JS file served with correct headers

- **WHEN** a `GET /static/<filename>.js` request is made for a JS file in the static directory
- **THEN** the response body contains the JavaScript content
- **AND** `Content-Type` is `application/javascript`
- **AND** `Cache-Control` is `public, max-age=31536000, immutable`

#### Scenario: Non-existent static file returns 404

- **WHEN** a `GET /static/nonexistent.js` request is made
- **THEN** the response status is `404`

#### Scenario: Rendered surfaces reference only same-origin scripts

- **WHEN** any UI surface is rendered
- **THEN** every `<script src="...">` SHALL have a `src` value that is either a relative path or begins with `/static/`
- **AND** every `<link rel="stylesheet">` SHALL have an `href` value that is either a relative path or begins with `/static/`

### Requirement: Cross-surface kind colour mapping

Top-level event prefixes (`trigger`, `action`, `system`) SHALL each have a distinct colour token used consistently across every surface that visualises kinds. The invocations list, the events log, the sidebar tree, and the flamegraph slices SHALL all derive kind colour from the same prefix-keyed palette. The runtime SHALL NOT use one palette for the invocations list and a different palette for the flamegraph.

#### Scenario: Invocations view and flamegraph use the same trigger colour

- **GIVEN** an invocation whose `trigger.request` is rendered both as a row in the invocations list and as a slice in the flamegraph
- **WHEN** both surfaces are rendered
- **THEN** the trigger-prefix colour applied to the row indicator SHALL match the colour applied to the flamegraph slice

#### Scenario: Adding a new event prefix requires a new colour

- **WHEN** a future change introduces a new top-level event prefix outside `trigger` / `action` / `system`
- **THEN** the change SHALL extend the prefix-keyed colour palette with a distinct entry
- **AND** every kind-rendering surface SHALL pick up the new colour automatically by reading from the same palette

### Requirement: Cross-surface status semantics

Invocation status SHALL use a single vocabulary across every surface that surfaces invocation state: `pending`, `running`, `succeeded`, `failed`. A `failed` invocation associated with a `system.exhaustion` event SHALL additionally surface an exhaustion dimension indicator (`cpu`, `memory`, `output`, or `pending`) alongside the failed status.

#### Scenario: Status vocabulary is consistent

- **WHEN** an invocation appears on the invocations list and (if expanded) in the flamegraph header
- **THEN** the status label rendered in both places SHALL be drawn from the same vocabulary set (`pending` / `running` / `succeeded` / `failed`)

#### Scenario: Exhaustion pill alongside failed status

- **GIVEN** a failed invocation associated with a `system.exhaustion` event whose `dim` is `cpu`
- **WHEN** the row is rendered
- **THEN** the row SHALL display the `failed` status indicator
- **AND** the row SHALL display an `exhaustion` indicator labelled `CPU` adjacent to the status

### Requirement: Icon rendering invariants

UI iconography SHALL be rendered as inline SVG with strokes that inherit `currentColor`. UI surfaces SHALL NOT depend on external icon-font dependencies, bitmap sprites, or platform emoji rendering for any user-meaningful indicator. SVG icons SHALL set `fill="none"` (unless filled icons are intentional) and SHALL NOT hardcode `stroke=` or `fill=` colour values that would prevent the icon from following the active theme.

#### Scenario: Trigger-kind icons are platform-stable

- **WHEN** a trigger-kind icon is rendered (cron clock, http globe, manual pointer, imap mail)
- **THEN** the rendered HTML SHALL contain an inline `<svg>` element
- **AND** the response body SHALL NOT contain emoji code points (U+1F300–U+1FAFF, U+23F0, U+25CF, U+1F310, U+1F464, U+1F4E8) inside any element with class `trigger-kind-icon`

#### Scenario: Icons follow theme colour

- **WHEN** an icon is rendered inside an element styled by a kind or status colour token
- **THEN** the SVG strokes SHALL inherit the parent's `currentColor`
- **AND** the SVG SHALL NOT carry an explicit `stroke=` attribute that overrides the inherited colour

### Requirement: Distinct visual indicator per event prefix

Each top-level event prefix (`trigger`, `action`, `system`) SHALL have a distinct visual indicator (icon glyph) used consistently across every surface that visualises events. The same indicator SHALL appear on event log lines, sidebar tree leaves where applicable, dashboard row gutters, and any other future surface that surfaces event prefixes.

#### Scenario: Event-log line shows prefix indicator

- **WHEN** the dashboard event log renders a line whose event kind begins with `trigger.`
- **THEN** the line SHALL display the trigger-prefix indicator at the leftmost gutter
- **AND** the indicator SHALL match the indicator used elsewhere (e.g. flamegraph slice marker) for `trigger.*` events

### Requirement: Distinct visual indicator per trigger kind

Each trigger kind (`cron`, `http`, `manual`, `imap`, plus any future kind) SHALL have a distinct visual indicator used consistently wherever the kind is surfaced. The same indicator SHALL appear on sidebar tree trigger leaves, dashboard invocation row gutters, flamegraph headers, and trigger cards.

#### Scenario: Sidebar trigger leaf shows kind indicator

- **WHEN** the sidebar tree renders a trigger leaf whose kind is `cron`
- **THEN** the leaf SHALL display the cron-kind indicator
- **AND** the same indicator SHALL appear on dashboard row gutters and trigger cards for the same kind

### Requirement: Upload kind icon registered in the trigger-kind registry

The cross-surface trigger-kind icon registry SHALL include an `upload` kind whose glyph is an upload-arrow shape and whose colour token is the active accent token (distinct from the `trigger` / `action` / `system` prefix palette). The `upload` kind is consumed by the invocations list to render the leading icon for synthetic `system.upload` rows.

The accent treatment SHALL be applied via a CSS rule selecting the `upload` variant of the trigger-kind icon container (e.g. `.trigger-kind-icon--upload`), so the colour follows the active theme's accent token rather than `currentColor` of the surrounding row.

#### Scenario: Synthetic upload row leading icon uses accent colour

- **GIVEN** an invocation row for a synthetic `system.upload` event
- **WHEN** the invocations list is rendered
- **THEN** the row's leading icon SHALL render the upload-arrow glyph
- **AND** the rendered icon's resolved colour SHALL be the active theme's accent colour (matching `var(--accent)`)
- **AND** the colour SHALL NOT match the `trigger` / `action` / `system` prefix palette

#### Scenario: Upload kind icon is registered alongside other kinds

- **WHEN** the trigger-kind registry is consulted for the kind string `"upload"`
- **THEN** the registry SHALL return a glyph component
- **AND** the glyph SHALL render as inline SVG following the icon-rendering invariants


### Requirement: Shared interactive JSON-tree component

Every UI surface that renders a JSON value to the user SHALL do so via a single shared interactive JSON-tree component, registered as an Alpine component in a same-origin `/static/*.js` module. UI surfaces SHALL NOT render JSON values via inline `<pre>` blocks containing the textual output of `JSON.stringify(value, null, 2)`.

The component SHALL satisfy the following invariants:

- **Default expansion**: when first rendered, every node in the tree SHALL be expanded. Nested objects, arrays, and scalar values SHALL all be visible without further user interaction.
- **Interactive collapse**: each node representing a non-empty object or array SHALL be individually collapsible and re-expandable by user activation (mouse click on a disclosure control or keyboard activation).
- **CSP-clean rendering**: the component SHALL register via `Alpine.data(...)` in a `/static/*.js` module and SHALL be bound through `data-*` attributes and Alpine directives that do not violate the existing CSP-clean rendering requirement (no inline `<script>` content, no inline `<style>`, no `on*=` handlers, no `style=` attributes, no inline `x-data` object literals).
- **Keyboard accessible**: the disclosure control on each collapsible node SHALL be reachable by keyboard tab navigation and SHALL be activatable by `Enter` or `Space`. The focus indicator SHALL conform to the existing keyboard-focus requirement.
- **Dark/light theme respect**: the component's visual treatment SHALL adapt to the user's `prefers-color-scheme` per the existing theme requirement; it SHALL NOT define theme-specific colours outside the established palette.
- **Reduced-motion respect**: any expand/collapse transition SHALL be suppressed when `prefers-reduced-motion: reduce` is set.
- **Copy-to-clipboard control**: every mount of the component SHALL render a copy-to-clipboard control as a child of the tree's root element. Activation of the control (mouse click or keyboard activation) SHALL write `JSON.stringify(value, null, 2)` of the *source value passed into the component* — not the rendered DOM text and not the tree's currently-visible (collapsed-aware) representation — to the system clipboard via `navigator.clipboard.writeText`. The control SHALL signal success by swapping its icon to a confirmation glyph and announcing "Copied" through a sibling `role="status"` `aria-live="polite"` region for assistive tech, then SHALL revert its icon and clear the announcement after a short delay (~2 seconds). The control SHALL be implemented via `addEventListener` on a button created by `document.createElement`; it SHALL NOT introduce inline event handlers, inline scripts, inline styles, or any binding that violates the CSP-clean rendering invariant. Empty containers (`{}`, `[]`) and primitive root values SHALL each carry the control.

The component SHALL be the single rendering path for all JSON values shown in the authenticated UI, including but not limited to: trigger-fire result payloads (existing trigger result dialog), action request/response payloads (existing flamegraph), and queue items (new `/queue` surface).

#### Scenario: Component renders fully expanded by default

- **GIVEN** a value `{"a": 1, "b": {"c": [2, 3]}}`
- **WHEN** the component renders the value for the first time
- **THEN** the keys `a`, `b`, and `c` SHALL all be visible without user interaction
- **AND** the array elements `2` and `3` SHALL all be visible without user interaction

#### Scenario: Collapse hides nested children

- **GIVEN** the component has rendered `{"a": 1, "b": {"c": [2, 3]}}` fully expanded
- **WHEN** the user activates the disclosure control next to key `b`
- **THEN** the elements `c`, `2`, and `3` SHALL no longer be visible
- **AND** key `a` and key `b` SHALL still be visible
- **AND** the component SHALL signal `b` as collapsed via an ARIA or `aria-expanded` attribute

#### Scenario: No inline-script or inline-style violations

- **WHEN** any page renders a JSON value through the component
- **THEN** the rendered HTML SHALL NOT contain a `<script>` element with inline content
- **AND** the rendered HTML SHALL NOT contain any `style=` attribute
- **AND** the rendered HTML SHALL NOT contain an `x-data="{...}"` object-literal binding
- **AND** the component SHALL register via `Alpine.data(...)` in a `/static/*.js` module loaded by `<script src="/static/...">`

#### Scenario: Keyboard activation toggles disclosure

- **WHEN** the user tabs focus to a disclosure control on a collapsible node
- **AND** the user presses `Enter` or `Space`
- **THEN** the node SHALL toggle between expanded and collapsed states
- **AND** focus SHALL remain on the disclosure control

#### Scenario: Component used uniformly across surfaces

- **WHEN** the trigger-fire result dialog renders a payload
- **THEN** the payload SHALL be rendered via the shared JSON-tree component, not via `<pre>` + `JSON.stringify`
- **WHEN** the queue items fragment renders an item
- **THEN** the item SHALL be rendered via the shared JSON-tree component
- **WHEN** the flamegraph displays an action's request or response payload
- **THEN** the payload SHALL be rendered via the shared JSON-tree component

#### Scenario: Copy-to-clipboard control writes the source value

- **GIVEN** the component has rendered the value `{"orderId": 42, "items": [{"sku": "X"}]}`
- **WHEN** the user activates the copy-to-clipboard control on the rendered tree
- **THEN** `navigator.clipboard.writeText` SHALL have been called exactly once
- **AND** the argument SHALL equal `JSON.stringify({"orderId": 42, "items": [{"sku": "X"}]}, null, 2)`

#### Scenario: Copy ignores collapsed state

- **GIVEN** the component has rendered `{"a": 1, "b": {"c": 2}}` and the user has collapsed key `b`
- **WHEN** the user activates the copy-to-clipboard control
- **THEN** the clipboard payload SHALL contain `"c": 2` (the source value, not the visible representation)

#### Scenario: Copy success announces and reverts

- **GIVEN** a rendered tree whose copy-to-clipboard control is in its idle state
- **WHEN** the user activates the control and the clipboard write resolves successfully
- **THEN** the control SHALL display a confirmation icon
- **AND** a sibling `role="status"` `aria-live="polite"` region SHALL contain the text "Copied"
- **AND** after a short delay (~2 seconds) the control SHALL revert to its idle icon
- **AND** the live region's text content SHALL be cleared

#### Scenario: Primitive and empty roots still carry the control

- **GIVEN** the component is asked to render the primitive value `null`
- **WHEN** the component renders the value
- **THEN** the rendered tree root SHALL still contain the copy-to-clipboard control
- **AND** activating it SHALL write the literal text `null` to the clipboard

- **GIVEN** the component is asked to render the empty object `{}`
- **WHEN** the component renders the value
- **THEN** the rendered tree root SHALL still contain the copy-to-clipboard control
- **AND** activating it SHALL write the literal text `{}` to the clipboard

#### Scenario: Copy control does not violate CSP

- **WHEN** any page renders a JSON value through the component
- **THEN** the copy-to-clipboard control SHALL NOT carry an inline `on*=` handler, an inline `style=` attribute, or be wired through an inline `<script>`
- **AND** the control's click behavior SHALL be installed via `addEventListener` from the same `/static/*.js` module that defines the component
