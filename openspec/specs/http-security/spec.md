### Requirement: Every HTTP response MUST carry baseline security headers

The runtime SHALL attach the following response headers to every response emitted by the Hono app, regardless of route, status code, or content type:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-origin`
- `Permissions-Policy` with every browser feature locked to the empty allow-list (`feature=()`), except `clipboard-write=(self)`
- `Content-Security-Policy` as defined in the CSP requirement below
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` — subject to the local-deployment gate defined in the HSTS requirement below

#### Scenario: Authenticated HTML route carries every header

- **WHEN** a client requests `/dashboard`
- **THEN** the response carries all eight headers listed above with their specified values

#### Scenario: Public webhook response carries every header

- **WHEN** an unauthenticated client posts to `/webhooks/<name>`
- **THEN** the response carries all eight headers (CSP included, even though the response body is JSON)

#### Scenario: API JSON response carries every header

- **WHEN** an authenticated client calls `/api/events`
- **THEN** the response carries all eight headers

#### Scenario: Static asset response carries every header

- **WHEN** a client requests `/static/workflow-engine.css`
- **THEN** the response carries all eight headers

#### Scenario: Liveness probe carries every header

- **WHEN** a client requests `/livez`
- **THEN** the response carries all eight headers

### Requirement: Content-Security-Policy MUST start from default-src 'none'

The `Content-Security-Policy` header SHALL have `default-src 'none'` as its baseline and grant only the following directives explicitly:

- `script-src 'self'`
- `style-src 'self'`
- `img-src 'self' data:`
- `connect-src 'self'`
- `form-action 'self'`
- `frame-ancestors 'none'`
- `base-uri 'none'`

The policy MUST NOT contain `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`, `'strict-dynamic'`, or any remote origin.

#### Scenario: CSP uses default-src 'none' baseline

- **WHEN** the `Content-Security-Policy` header is inspected on any response
- **THEN** it begins with the directive `default-src 'none'`

#### Scenario: CSP grants only same-origin sources

- **WHEN** the `Content-Security-Policy` header is inspected
- **THEN** every directive that names a source list resolves to `'self'`, `'none'`, or the literal scheme `data:` (permitted only in `img-src`)

#### Scenario: CSP forbids unsafe tokens

- **WHEN** the `Content-Security-Policy` header is inspected
- **THEN** it contains none of the substrings `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`, or `'strict-dynamic'`

#### Scenario: CSP forbids remote origins

- **WHEN** the `Content-Security-Policy` header is inspected
- **THEN** no directive references an `https:` URL, `http:` URL, or wildcard host

### Requirement: HSTS MUST be skipped when LOCAL_DEPLOYMENT=1

When the runtime process environment variable `LOCAL_DEPLOYMENT` has the exact string value `"1"`, the runtime SHALL NOT emit the `Strict-Transport-Security` response header on any response. In every other case the header SHALL be emitted with the value `max-age=31536000; includeSubDomains`.

#### Scenario: HSTS suppressed in local deployment

- **WHEN** the runtime starts with `process.env.LOCAL_DEPLOYMENT === "1"`
- **THEN** responses to `/dashboard`, `/livez`, `/api/*`, `/webhooks/*`, and `/static/*` do not carry a `Strict-Transport-Security` header

#### Scenario: HSTS emitted in production

- **WHEN** the runtime starts without `LOCAL_DEPLOYMENT` set
- **THEN** every response carries `Strict-Transport-Security: max-age=31536000; includeSubDomains`

#### Scenario: HSTS emitted when LOCAL_DEPLOYMENT has a non-"1" value

- **WHEN** the runtime starts with `process.env.LOCAL_DEPLOYMENT === "true"` or any value other than the literal string `"1"`
- **THEN** responses carry `Strict-Transport-Security: max-age=31536000; includeSubDomains`

### Requirement: Permissions-Policy MUST lock every feature except clipboard-write=(self)

The `Permissions-Policy` header SHALL set the following features to the empty allow-list `()`: `accelerometer`, `ambient-light-sensor`, `autoplay`, `battery`, `camera`, `display-capture`, `document-domain`, `encrypted-media`, `fullscreen`, `geolocation`, `gyroscope`, `hid`, `idle-detection`, `magnetometer`, `microphone`, `midi`, `payment`, `picture-in-picture`, `publickey-credentials-get`, `screen-wake-lock`, `serial`, `usb`, `web-share`, `xr-spatial-tracking`, `clipboard-read`. The feature `clipboard-write` SHALL be set to `(self)` so the dashboard's copy-event-id button continues to work.

#### Scenario: Clipboard-write allowed for self

- **WHEN** the `Permissions-Policy` header is parsed
- **THEN** `clipboard-write` resolves to `(self)`

#### Scenario: All other listed features disabled

- **WHEN** the `Permissions-Policy` header is parsed
- **THEN** every other feature listed in this requirement resolves to `()`

### Requirement: UI responses MUST NOT require 'unsafe-inline' or 'unsafe-eval'

HTML rendered by the runtime (dashboard, trigger UI, error pages, sign-in page template) MUST NOT contain any of the following:

- inline `<script>` elements with executable content
- inline HTML event handler attributes (`onclick=`, `ontoggle=`, `onchange=`, `onload=`, `onsubmit=`, `onerror=`, `onfocus=`, `onblur=`, or any other `on*=` attribute)
- inline `<style>` elements
- inline `style="..."` attributes other than via Alpine `:style` object-form bindings
- Alpine `:style` bindings whose expression evaluates to a string (only object-form bindings are permitted, because Alpine sets object-form styles via `el.style.setProperty` which is CSP-safe, whereas string-form is set via `el.setAttribute('style', ...)` which is blocked by `style-src 'self'`)
- Alpine `x-data` attributes with inline object literals or method bodies; every Alpine component MUST be registered via `Alpine.data('<name>', () => ({ ... }))` and referenced by name

The Alpine build loaded by `/static/alpine.js` SHALL be `@alpinejs/csp`, not `alpinejs/dist/cdn.min.js`.

JSON data embedded in `<script type="application/json">` elements for later runtime parsing is permitted because the browser does not execute it.

#### Scenario: No inline script or handler attributes in rendered HTML

- **WHEN** the runtime renders any HTML response (`/dashboard`, `/dashboard/list`, `/dashboard/timeline/<id>`, `/trigger`, error page bodies)
- **THEN** the response body contains no `<script>` element with non-JSON content and no `on*=` attribute on any element

#### Scenario: No inline style blocks or style attributes in rendered HTML

- **WHEN** the runtime renders any HTML response
- **THEN** the response body contains no `<style>` element and no `style="..."` attribute

#### Scenario: Alpine components referenced by name

- **WHEN** the runtime renders any HTML response containing Alpine markup
- **THEN** every `x-data` attribute value is a bare identifier referring to a component registered via `Alpine.data(...)`

#### Scenario: Alpine :style bindings use object form

- **WHEN** the runtime renders any HTML response containing a `:style` binding
- **THEN** the binding expression evaluates to a JavaScript object, not a string

#### Scenario: CSP build of Alpine is served

- **WHEN** a client requests `/static/alpine.js`
- **THEN** the response body is the `@alpinejs/csp` build, distinguishable from the standard build by its published fingerprint

### Requirement: Security-header configuration MUST be unit and integration tested

The runtime SHALL include automated tests that exercise the secure-headers middleware. Unit tests SHALL assert each header's presence and value on a mocked request, and SHALL cover both the `LOCAL_DEPLOYMENT=1` and unset branches. Integration tests SHALL hit at least one route from each family (`/livez`, `/webhooks/*`, `/api/*`, `/dashboard`, `/trigger`, `/static/*`) against a running server and assert the full header set.

#### Scenario: Unit test asserts header presence and values

- **WHEN** the unit test suite runs
- **THEN** assertions exist for each header defined in the baseline requirement, the CSP requirement, the HSTS requirement, and the Permissions-Policy requirement

#### Scenario: Unit test covers LOCAL_DEPLOYMENT branch

- **WHEN** the unit test suite runs
- **THEN** at least one test sets `LOCAL_DEPLOYMENT=1` and asserts absence of the `Strict-Transport-Security` header, and at least one test leaves `LOCAL_DEPLOYMENT` unset and asserts its presence

#### Scenario: Integration test covers every route family

- **WHEN** the integration test suite runs
- **THEN** it hits at least one route matching `/livez`, `/webhooks/*`, `/api/*`, `/dashboard`, `/trigger`, and `/static/*` and asserts the full baseline header set on each response
