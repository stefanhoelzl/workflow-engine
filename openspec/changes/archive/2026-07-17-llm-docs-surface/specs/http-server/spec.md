## ADDED Requirements

### Requirement: Public /llms.txt index route

The server SHALL serve `GET /llms.txt` as a public, unauthenticated route returning a static text document (the LLM docs index; content defined by the `llm-docs` capability) with status `200` and a textual content type (`text/plain` or `text/markdown`). The handler SHALL return a fixed constant and SHALL NOT read request headers, query, body, or any owner/repo path parameter. The route SHALL be mounted so that it is reachable — it is neither the exact root path `/` (so the root redirect does not apply) nor under `/static/*` — and SHALL be registered ahead of the 404 catch-all.

#### Scenario: llms.txt is served

- **WHEN** a `GET /llms.txt` request is received
- **THEN** the response status SHALL be `200`
- **AND** the `Content-Type` SHALL be a textual type (`text/plain` or `text/markdown`)
- **AND** the body SHALL be the static LLM docs index

#### Scenario: llms.txt requires no authentication

- **WHEN** a `GET /llms.txt` request is received with no session cookie and no API credential
- **THEN** the response status SHALL be `200` and SHALL NOT redirect to `/login`

#### Scenario: llms.txt is not shadowed by the root redirect or static middleware

- **GIVEN** the root redirect matches the exact path `/` only and the static middleware is mounted at `/static/*`
- **WHEN** a `GET /llms.txt` request is received
- **THEN** the `/llms.txt` handler SHALL fire
- **AND** the response SHALL NOT be a `302` redirect to `/invocations`

#### Scenario: llms.txt precedes the 404 catch-all

- **WHEN** a `GET /llms.txt` request is received
- **THEN** the response SHALL NOT be the shared 404 not-found body
