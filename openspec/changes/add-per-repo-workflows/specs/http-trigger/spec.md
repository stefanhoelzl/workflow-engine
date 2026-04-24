## MODIFIED Requirements

### Requirement: HTTP middleware delegates to executor

The HTTP trigger backend SHALL mount a Hono middleware at `/webhooks/:owner/:repo/*` that matches incoming requests against the registered HTTP trigger index for that `(owner, repo)` and delegates matched requests to the trigger's `fire` callback.

On path mismatch (no registered trigger for the requested `(owner, repo, method, subPath)`), the middleware SHALL respond `404 Not Found` with body `{"error":"Not Found"}`. Unknown `(owner, repo)` pairs SHALL respond identically to "no matching trigger" — the response SHALL NOT distinguish "owner/repo exists but no trigger matches" from "owner/repo does not exist" (enumeration prevention).

`:owner` and `:repo` path parameters SHALL be validated against their respective regexes before any trigger lookup. Values outside the regex SHALL respond `404 Not Found` with the same body, indistinguishable from the not-found case.

The webhook route SHALL NOT require authentication — public ingress is intentional per SECURITY.md §3. The backend SHALL NOT read `X-Auth-Request-*` headers on the webhook path.

#### Scenario: Matched trigger is fired with scope

- **GIVEN** `(acme, foo)` has registered an HTTP trigger on `POST /orders`
- **WHEN** an external caller posts to `/webhooks/acme/foo/orders`
- **THEN** the middleware SHALL invoke the trigger's `fire` callback with the parsed input
- **AND** the invocation SHALL be scoped to `(acme, foo)`

#### Scenario: Unknown repo returns 404 identical to unmatched path

- **WHEN** a request arrives at `/webhooks/acme/never-existed/orders`
- **THEN** the middleware SHALL respond `404 Not Found`
- **AND** the body SHALL be `{"error":"Not Found"}`
- **AND** the response SHALL be byte-identical to a response for a registered repo without matching trigger

#### Scenario: Invalid owner regex returns 404

- **WHEN** a request arrives at `/webhooks/..%2F..%2Fetc/foo/orders`
- **THEN** the middleware SHALL respond `404 Not Found`
- **AND** the handler SHALL NOT be invoked

### Requirement: Trigger URL is derived from export name

The HTTP trigger URL SHALL be derived from the export name of the trigger definition inside the workflow module. For an export `userSignup` declared as `httpTrigger({method: "POST"}, async (ctx) => ...)`, the resulting webhook URL segment under `(owner, repo)` SHALL be `/webhooks/<owner>/<repo>/<workflow-name>/userSignup`.

The `<workflow-name>` segment SHALL match the workflow name declared in the manifest (typically derived from the source file basename). The `<trigger-name>` segment SHALL match the trigger's export name exactly.

Two different `(owner, repo)` pairs MAY have triggers with the same `<workflow-name>/<trigger-name>` URL suffix; the `(owner, repo)` segments disambiguate them.

#### Scenario: URL shape

- **GIVEN** `(acme, foo)` registering workflow `onboarding` with HTTP trigger `userSignup` on POST
- **WHEN** the trigger is queried for its public URL
- **THEN** the URL SHALL be `/webhooks/acme/foo/onboarding/userSignup`

#### Scenario: Same trigger name across repos produces distinct URLs

- **GIVEN** both `(acme, foo)` and `(acme, bar)` register a workflow `onboarding` with HTTP trigger `userSignup`
- **WHEN** both triggers are registered
- **THEN** their URLs SHALL be `/webhooks/acme/foo/onboarding/userSignup` and `/webhooks/acme/bar/onboarding/userSignup` respectively
- **AND** posting to either URL SHALL fire only the matching trigger

### Requirement: Public ingress security context

The `/webhooks/*` path prefix SHALL be public ingress — no authentication middleware SHALL be mounted on it. This aligns with SECURITY.md §3: "NEVER add authentication to `/webhooks/*` — public ingress is intentional."

Webhook handlers SHALL NOT read any session cookie, forward-auth header (`X-Auth-Request-*`), or Bearer token from the request. Any identification or authorization of the external caller SHALL be performed by the workflow handler code itself (e.g. verifying an HMAC signature in the body), not by the runtime middleware.

The `(owner, repo)` segments in the URL are identification only — they are not authorization. An attacker who knows a registered `(owner, repo, workflow, trigger)` URL can POST to it; defending that endpoint is the workflow author's responsibility.

#### Scenario: No auth middleware on webhook path

- **GIVEN** the runtime's middleware chain
- **WHEN** a request hits `/webhooks/acme/foo/workflow/trigger`
- **THEN** no `sessionMw`, no `bearerUserMw`, no `requireOwnerMember` SHALL be applied
- **AND** the request SHALL reach the webhook handler regardless of cookie/header presence
