# HTTP Server Specification

## Purpose

Generic HTTP server foundation for the runtime. Accepts middleware and serves as the base for all platform HTTP endpoints.

## Requirements

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

### Requirement: Server port is configurable via PORT environment variable

The runtime SHALL read the `PORT` environment variable to determine the HTTP server listen port. If `PORT` is not set, it SHALL default to `8080`.

#### Scenario: PORT env var is set
- **WHEN** the runtime starts with `PORT=9090`
- **THEN** the HTTP server SHALL listen on port 9090

#### Scenario: PORT env var is not set
- **WHEN** the runtime starts without a `PORT` environment variable
- **THEN** the HTTP server SHALL listen on port 8080

#### Scenario: Startup log includes the port
- **WHEN** the runtime starts
- **THEN** it SHALL log `Runtime listening on port <port>` with the actual port number
