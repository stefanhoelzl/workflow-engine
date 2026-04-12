### Requirement: GitHub token authentication middleware

The runtime SHALL provide a Hono middleware that authenticates requests on `/api/*` routes using a GitHub token. The middleware SHALL extract the token from the `Authorization: Bearer <token>` header, call `GET https://api.github.com/user` with the token, and compare the response `login` field against the configured allow-list of GitHub usernames (`githubAuth.users`, an array of logins).

The middleware SHALL operate in one of three modes selected by configuration (`githubAuth.mode`):

- **`restricted`** — the middleware validates the Bearer token and requires the returned `login` to be a member of `githubAuth.users`.
- **`disabled`** — the middleware responds `401 Unauthorized` to every request regardless of headers. This is the mode when no allow-list is configured; it is fail-closed.
- **`open`** — the middleware is not installed; every request reaches the handler unauthenticated. This mode is reserved for local development and is opted into by the explicit sentinel (see `runtime-config`).

All negative outcomes (missing header, malformed header, GitHub rejection, network error, login not on the allow-list, mode `disabled`) SHALL return `401 Unauthorized` with body `{ "error": "Unauthorized" }`. The status code and body SHALL NOT distinguish between failure causes, to prevent enumeration of the allow-list by holders of valid GitHub tokens.

#### Scenario: Valid token, user on allow-list (restricted mode)

- **WHEN** a request to `/api/workflows` includes `Authorization: Bearer <valid-token>`, `githubAuth.mode` is `restricted`, and the token's `login` is a member of `githubAuth.users`
- **THEN** the middleware SHALL allow the request to proceed to the handler

#### Scenario: Missing Authorization header (restricted mode)

- **WHEN** a request to `/api/workflows` has no `Authorization` header and `githubAuth.mode` is `restricted`
- **THEN** the middleware SHALL respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`

#### Scenario: Invalid token (restricted mode)

- **WHEN** a request to `/api/workflows` includes `Authorization: Bearer <invalid-token>`, `githubAuth.mode` is `restricted`, and the GitHub API returns an error
- **THEN** the middleware SHALL respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`

#### Scenario: Valid token, login not on allow-list (restricted mode)

- **WHEN** a request includes a valid GitHub token, `githubAuth.mode` is `restricted`, and the returned `login` is not a member of `githubAuth.users`
- **THEN** the middleware SHALL respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`
- **AND** the response SHALL be indistinguishable from the responses for missing/invalid tokens

#### Scenario: GitHub API unavailable (restricted mode)

- **WHEN** a request includes a token, `githubAuth.mode` is `restricted`, and the call to `api.github.com` fails due to network error
- **THEN** the middleware SHALL respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`

#### Scenario: Disabled mode rejects every request

- **WHEN** any request reaches `/api/*` and `githubAuth.mode` is `disabled`
- **THEN** the middleware SHALL respond with `401 Unauthorized` and body `{ "error": "Unauthorized" }`
- **AND** no outbound call to `api.github.com` SHALL be made

#### Scenario: Open mode allows every request

- **WHEN** any request reaches `/api/*` and `githubAuth.mode` is `open`
- **THEN** the middleware SHALL NOT be installed
- **AND** the request SHALL proceed to the handler without authentication

### Requirement: Multi-user allow-list membership

The allow-list (`githubAuth.users`) SHALL be an array of GitHub login strings. Membership SHALL be determined by exact case-sensitive string equality between the login returned by `GET https://api.github.com/user` and any element of the array.

#### Scenario: Multiple users on allow-list

- **WHEN** `githubAuth.users` is `["alice", "bob"]` and a request presents a valid token whose `login` is `"bob"`
- **THEN** the middleware SHALL allow the request

#### Scenario: Case-sensitive matching

- **WHEN** `githubAuth.users` is `["Alice"]` and a request presents a valid token whose `login` is `"alice"`
- **THEN** the middleware SHALL respond with `401 Unauthorized`

### Requirement: Startup logging of auth mode

The runtime SHALL emit a log record during initialization that records the effective `githubAuth.mode`. When the mode is `disabled` or `open`, the record SHALL be at level `warn`; when the mode is `restricted`, it MAY be at level `info`.

#### Scenario: Disabled mode warns on startup

- **WHEN** the runtime starts with `githubAuth.mode === "disabled"`
- **THEN** the runtime SHALL emit a `warn`-level log record identifying the disabled mode

#### Scenario: Open mode warns on startup

- **WHEN** the runtime starts with `githubAuth.mode === "open"`
- **THEN** the runtime SHALL emit a `warn`-level log record identifying the open mode

### Requirement: Security context

The implementation SHALL conform to the threat model documented at
`/SECURITY.md §4 Authentication`, which enumerates the trust level,
entry points, threats, current mitigations, residual risks, and rules
governing this capability. This capability owns the API trust chain:
Bearer-token validation against GitHub and the `GITHUB_USER` allowlist
check.

Changes to this capability that introduce new threats, weaken or remove
a documented mitigation, alter the API trust chain (for example by
changing the token-validation call, the caching behavior, or the
allowlist semantics), or conflict with the rules listed in
`/SECURITY.md §4` MUST update `/SECURITY.md §4` in the same change
proposal.

#### Scenario: Change alters behaviors covered by the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change affects a threat, mitigation, residual risk, or
  rule enumerated in `/SECURITY.md §4`
- **THEN** the proposal SHALL include the corresponding updates to
  `/SECURITY.md §4`
- **AND** the updates SHALL be reviewed before the change is archived

#### Scenario: Change is orthogonal to the threat model

- **GIVEN** a change proposal that modifies this capability
- **WHEN** the change does not affect any item enumerated in
  `/SECURITY.md §4`
- **THEN** no update to `/SECURITY.md §4` is required
- **AND** the proposal SHALL note that threat-model alignment was
  checked
