## ADDED Requirements

### Requirement: Unauthenticated landing advertises the `/llms.txt` index

The runtime SHALL make the `/llms.txt` docs index discoverable to an agent that is handed only the bare domain and follows it. Because an agent handed the bare domain follows `/` → `/invocations` → `/login` (unauthenticated) and, on a wrong path, receives an error page, the unauthenticated landing surfaces — the login page (`auth` capability "Login page route") and the 404 / 5xx error pages (`ui-errors` capability) — SHALL each carry a machine-discoverable pointer to `/llms.txt`.

The pointer SHALL consist of BOTH:

1. A visually-hidden, in-DOM anchor in the page body: `<a class="sr-only" href="/llms.txt">…</a>`, where the anchor text is a directive sentence naming the `/llms.txt` path so an extracting model acts on it. The anchor SHALL be hidden via the clip-rect `sr-only` technique (off-screen, `1px`, `clip: rect(0,0,0,0)`) — NOT via `display:none`, the `hidden` attribute, or `aria-hidden="true"` — so it remains present in the DOM and survives HTML→text/markdown extraction while staying invisible to sighted users.
2. A `<link rel="alternate" type="text/markdown" href="/llms.txt">` element in `<head>` for convention-following crawlers.

Both elements SHALL be fixed constants that reflect no request input, and SHALL be CSP-clean (no inline script, no inline style, no `on*=` / `style=` attributes) per the `http-security` and `ui-foundation` requirements. Neither element SHALL alter the visible layout of the page.

This requirement does not change the `/llms.txt` route itself (owned by `http-server`); it only requires that the unauthenticated landing points at it.

#### Scenario: Login page carries the discovery pointer

- **WHEN** `GET /login` is requested with `Accept: text/html`
- **THEN** the response body SHALL contain an anchor with `href="/llms.txt"` carrying the `sr-only` class
- **AND** the response `<head>` SHALL contain `<link rel="alternate" type="text/markdown" href="/llms.txt">`

#### Scenario: 404 page carries the discovery pointer

- **WHEN** a `GET /nonexistent` request is made with `Accept: text/html`
- **THEN** the rendered 404 body SHALL contain an anchor with `href="/llms.txt"` carrying the `sr-only` class
- **AND** the response `<head>` SHALL contain `<link rel="alternate" type="text/markdown" href="/llms.txt">`

#### Scenario: 5xx page carries the discovery pointer

- **WHEN** an unhandled exception renders the styled 5xx page with `Accept: text/html`
- **THEN** the rendered 5xx body SHALL contain an anchor with `href="/llms.txt"` carrying the `sr-only` class
- **AND** the response `<head>` SHALL contain `<link rel="alternate" type="text/markdown" href="/llms.txt">`

#### Scenario: Pointer is hidden in the DOM, not removed from it

- **WHEN** any landing page carrying the pointer is rendered
- **THEN** the discovery anchor SHALL be hidden via the `sr-only` clip-rect technique
- **AND** the anchor SHALL NOT be hidden via `display:none`, the `hidden` attribute, or `aria-hidden="true"`

#### Scenario: Pointer is a fixed constant

- **WHEN** the pointer is rendered on any landing page across differing request headers, query strings, and paths
- **THEN** the anchor `href` and the head link target SHALL both be exactly `/llms.txt`
- **AND** neither SHALL echo any request input
