## ADDED Requirements

### Requirement: UpgradeProvider interface

The runtime SHALL define `UpgradeProvider` as a separate interface from `TriggerSource`, declared at `packages/runtime/src/triggers/source.ts`. The interface SHALL contain at minimum:

- `upgradeHandler(req: IncomingMessage, socket: Duplex, head: Buffer): void` — invoked from the http server's `'upgrade'` event. Implementations SHALL run all auth/routing checks before invoking any WebSocket handshake; on any failure they SHALL write a uniform raw `HTTP/1.1 404 Not Found` response on the socket and call `socket.destroy()`.
- `pingInterval?: number` — optional. Hint to `services/server.ts` for socket-liveness timer cadence in milliseconds. Implementations that don't need heartbeat omit the field.

The interface SHALL be open to additive growth (e.g. `subprotocols`, `maxPayload`) without changing `TriggerSource`. A backend MAY implement both `TriggerSource` and `UpgradeProvider`; the WS backend is the only such implementer in v1. A backend MAY implement only one.

The runtime SHALL provide `isUpgradeProvider(value): value is UpgradeProvider` as a structural type guard (`typeof value.upgradeHandler === "function"`). `main.ts` SHALL use this guard to filter the backends array when threading the list to `createServer`.

#### Scenario: WS backend implements both interfaces

- **GIVEN** the WS backend factory's return value
- **WHEN** the value is type-checked
- **THEN** it SHALL satisfy both `TriggerSource<"ws">` and `UpgradeProvider`
- **AND** `isUpgradeProvider(value)` SHALL return `true`

#### Scenario: Other backends are not UpgradeProviders

- **GIVEN** the existing HTTP, cron, manual, and IMAP backend instances
- **WHEN** `isUpgradeProvider` is invoked on each
- **THEN** each call SHALL return `false`
- **AND** none of those backends SHALL be passed to the upgrade-event wiring

## MODIFIED Requirements

### Requirement: Trigger is an abstract umbrella

The `Trigger` type SHALL be an abstract umbrella defined as a TypeScript union of concrete trigger implementations. The union contains five members: `HttpTrigger | CronTrigger | ManualTrigger | ImapTrigger | WsTrigger`. The `Trigger` type SHALL be used by runtime dispatch and the workflow registry; authors SHALL NOT write `Trigger` directly. Each concrete trigger type SHALL ship its own SDK factory (e.g., `httpTrigger(...)`, `cronTrigger(...)`, `manualTrigger(...)`, `imapTrigger(...)`, `wsTrigger(...)`), its own brand symbol, and its own concrete type.

#### Scenario: Trigger union includes all five trigger kinds

- **GIVEN** the SDK's `Trigger` umbrella type
- **WHEN** the type is inspected
- **THEN** the `Trigger` union SHALL equal `HttpTrigger | CronTrigger | ManualTrigger | ImapTrigger | WsTrigger`
- **AND** existing `HttpTrigger`, `CronTrigger`, `ManualTrigger`, and `ImapTrigger` consumers SHALL continue to compile without change

#### Scenario: Trigger union grows by union member

- **GIVEN** a future change introducing a sixth trigger kind
- **WHEN** the new trigger type is added
- **THEN** the `Trigger` union SHALL be extended by union-append
- **AND** existing consumers SHALL continue to compile without change
