## ADDED Requirements

### Requirement: createServer accepts middleware and returns a Hono app

`createServer` SHALL be a factory function that accepts zero or more Hono middleware functions and returns a configured Hono application. It SHALL have no knowledge of triggers or any specific domain concept.

#### Scenario: Server with middleware
- **WHEN** `createServer(middlewareA, middlewareB)` is called
- **THEN** the returned Hono app SHALL have both middleware mounted in order

#### Scenario: Server with no middleware
- **WHEN** `createServer()` is called with no arguments
- **THEN** the returned Hono app SHALL be a valid Hono application

### Requirement: Unmatched routes return 404

The server SHALL return a `404` response for requests that do not match any middleware or route.

#### Scenario: Request to unknown path
- **WHEN** a `GET /nonexistent` request is received
- **AND** no middleware handles the request
- **THEN** the server SHALL return a `404` response
