## ADDED Requirements

> **Style implementation reference:** the values that satisfy the requirements
> below (exact hex values, type scale, density, motion durations, the green
> allowlist enumeration, kind/prefix icon tables, component recipes) are
> documented in `docs/ui-guidelines.md`. This spec describes the contracts;
> the doc describes the current implementation that satisfies them.

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

Every UI surface — authenticated pages, the login page, and error pages — SHALL render the same topbar element. The topbar SHALL display the brand wordmark "Workflow Engine" coloured with the active accent token. User identity (username, email if available, and a sign-out control) SHALL render in the topbar if and only if the request resolved an authenticated session; otherwise the topbar SHALL render the wordmark alone.

The topbar SHALL NOT render different markup for different surface kinds. Surface-specific user-info suppression (forced-anonymous topbar on error pages) SHALL NOT exist; the topbar reads session state like any other page and degrades naturally when none is available.

#### Scenario: Authenticated surface shows user identity

- **GIVEN** a user with a valid session cookie
- **WHEN** any authenticated UI surface (e.g. `/dashboard`, `/trigger`) is rendered
- **THEN** the topbar SHALL display the brand wordmark
- **AND** the topbar SHALL display the user's username and (if available) email address
- **AND** the topbar SHALL include a sign-out control

#### Scenario: Login page shows wordmark only

- **WHEN** the login page is rendered (no session by definition)
- **THEN** the topbar SHALL display the brand wordmark
- **AND** the topbar SHALL NOT display any user identity or sign-out control

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

Top-level event prefixes (`trigger`, `action`, `system`) SHALL each have a distinct colour token used consistently across every surface that visualises kinds. The dashboard invocation list, the events log, the sidebar tree, and the flamegraph slices SHALL all derive kind colour from the same prefix-keyed palette. The runtime SHALL NOT use one palette for the dashboard list and a different palette for the flamegraph.

#### Scenario: Dashboard and flamegraph use the same trigger colour

- **GIVEN** an invocation whose `trigger.request` is rendered both as a row in the dashboard list and as a slice in the flamegraph
- **WHEN** both surfaces are rendered
- **THEN** the trigger-prefix colour applied to the row indicator SHALL match the colour applied to the flamegraph slice

#### Scenario: Adding a new event prefix requires a new colour

- **WHEN** a future change introduces a new top-level event prefix outside `trigger` / `action` / `system`
- **THEN** the change SHALL extend the prefix-keyed colour palette with a distinct entry
- **AND** every kind-rendering surface SHALL pick up the new colour automatically by reading from the same palette

### Requirement: Cross-surface status semantics

Invocation status SHALL use a single vocabulary across every surface that surfaces invocation state: `pending`, `running`, `succeeded`, `failed`. A `failed` invocation associated with a `system.exhaustion` event SHALL additionally surface an exhaustion dimension indicator (`cpu`, `memory`, `output`, or `pending`) alongside the failed status.

#### Scenario: Status vocabulary is consistent

- **WHEN** an invocation appears on the dashboard list and (if expanded) in the flamegraph header
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
