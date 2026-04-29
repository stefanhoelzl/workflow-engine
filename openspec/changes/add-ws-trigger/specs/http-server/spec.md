## MODIFIED Requirements

### Requirement: createServer accepts middleware and returns a Hono app

`createServer` SHALL be replaced by two functions:
- `createApp(...middlewares)` SHALL accept zero or more Hono middleware functions and return a configured Hono application. It SHALL have no knowledge of triggers or any specific domain concept.
- `createServer(port, opts, middlewares, upgradeProviders?)` SHALL create the app via `createApp` and return a `Service` (with `start(): Promise<void>` and `stop(): Promise<void>`). The optional `upgradeProviders` parameter SHALL accept an array of values satisfying the `UpgradeProvider` interface (defined in the `triggers` capability). When omitted or empty, the function's behavior SHALL be byte-for-byte identical to the prior signature.

After `serve({fetch, port})` returns the underlying `http.Server`, `createServer` SHALL register one `'upgrade'` event listener per upgrade provider. Each listener SHALL invoke `provider.upgradeHandler(req, socket, head)` exactly once per matching upgrade event. If the provider declares a `pingInterval`, `createServer` SHALL be the consumer that wires the corresponding heartbeat interval (delegated to the provider's own implementation; `services/server.ts` does not own per-socket state).

The health middleware SHALL continue to be passed to `createServer` alongside the existing middlewares.

#### Scenario: createApp with middleware
- **WHEN** `createApp(middlewareA, middlewareB)` is called
- **THEN** the returned Hono app SHALL have both middleware mounted in order

#### Scenario: createApp with no middleware
- **WHEN** `createApp()` is called with no arguments
- **THEN** the returned Hono app SHALL be a valid Hono application

#### Scenario: createServer returns a Service
- **WHEN** `createServer(8080, opts, [middlewareA])` is called
- **THEN** the returned object has `start` and `stop` methods

#### Scenario: createServer with no upgrade providers behaves as before
- **WHEN** `createServer(8080, opts, middlewares)` is called with no fourth argument (or an empty array)
- **THEN** the http server SHALL NOT register any `'upgrade'` listener
- **AND** WS upgrade requests SHALL receive the default Node behavior (socket reset)

#### Scenario: Upgrade providers are wired after serve binds
- **GIVEN** a `createServer(8080, opts, middlewares, [wsProvider])` instance
- **WHEN** `start()` is called and `serve` returns the underlying `http.Server`
- **THEN** the server SHALL register exactly one `'upgrade'` listener per provider
- **AND** the listener SHALL invoke `wsProvider.upgradeHandler(req, socket, head)` for every upgrade event

#### Scenario: Server start listens on the specified port
- **GIVEN** a server created with `createServer(9090, opts, [])`
- **WHEN** `start()` is called
- **THEN** the HTTP server listens on port 9090
- **AND** the `start()` promise remains pending while the server is running

#### Scenario: Server start rejects on bind failure
- **GIVEN** port 8080 is already in use
- **WHEN** `createServer(8080, opts, []).start()` is called
- **THEN** the `start()` promise rejects with the bind error

#### Scenario: Server start ignores post-listen connection errors
- **GIVEN** a server that has successfully started listening
- **WHEN** a per-connection socket error occurs
- **THEN** the `start()` promise does NOT reject
- **AND** the server continues serving requests

#### Scenario: Server stop closes connections
- **GIVEN** a running server
- **WHEN** `stop()` is called
- **THEN** the server stops accepting new connections
- **AND** the `stop()` promise resolves when all existing connections are closed
- **AND** the `start()` promise resolves

#### Scenario: Health middleware is wired into the server
- **WHEN** the runtime initializes
- **THEN** `healthMiddleware` SHALL be passed to `createServer` with access to eventStore, storageBackend, and baseUrl
