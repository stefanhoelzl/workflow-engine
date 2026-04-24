## MODIFIED Requirements

### Requirement: Event list page

The system SHALL serve an HTML page at `GET /trigger/` listing all defined workflow events by name, rendered with authenticated user identity. Identity SHALL come from the authenticated session (`sessionMw` on `/trigger/*` reads the sealed `session` cookie, unseals it, and sets `c.set("user", UserContext)`). The page SHALL read `c.get("user")` and render the user's display name + email in the shared layout.

The page SHALL NOT read `X-Auth-Request-*` headers — those were stripped by Traefik's `strip-auth-headers` middleware before arrival and are ignored by both the bearer middleware (API) and the session middleware (UI). The `replace-oauth2-proxy` change replaced forward-auth header identity with in-app session identity; this requirement's scenario was updated accordingly.

#### Scenario: Page lists all events with user identity

- **WHEN** a browser requests `GET /trigger/` with a valid sealed `session` cookie whose payload identifies `{ name: "stefan", mail: "stefan@example.com" }`
- **THEN** the response is an HTML document rendered via the shared layout
- **AND** the layout SHALL display `stefan` and `stefan@example.com` in the top-bar user block
- **AND** each event from the JSON Schema map SHALL be listed as a `<details>` element with the event name as the `<summary>`

#### Scenario: JSON Schema embedded per event

- **WHEN** the page is rendered
- **THEN** each `<details>` block contains a `<script type="application/json">` element with the event's JSON Schema
- **THEN** the schema has been processed by `prepareSchema` which promotes `example` values to `default` and labels `anyOf` variants with type titles

#### Scenario: Forged X-Auth-Request-* headers ignored

- **GIVEN** a request to `GET /trigger/` with a valid session cookie for `{ name: "alice" }` AND forged headers `X-Auth-Request-User: attacker`, `X-Auth-Request-Email: attacker@evil.test`
- **WHEN** the page is rendered
- **THEN** the top-bar user block SHALL display `alice` (from the session cookie)
- **AND** SHALL NOT display `attacker` or `attacker@evil.test`
