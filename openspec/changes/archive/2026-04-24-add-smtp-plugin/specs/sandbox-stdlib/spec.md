## ADDED Requirements

### Requirement: net-guard primitive

The sandbox-stdlib package SHALL export a `net-guard` module from `packages/sandbox-stdlib/src/net-guard/` providing shared host-resolution and IANA special-use blocklist enforcement for every outbound-TCP plugin. The module SHALL export: `BLOCKED_CIDRS_IPV4` and `BLOCKED_CIDRS_IPV6` (readonly string arrays of CIDRs covering RFC-1918 private ranges, CGNAT, loopback, link-local/metadata, TEST-NET, benchmark, 6to4 relay, IETF protocol assignments, multicast, reserved, and limited broadcast), `isBlockedAddress(addrStr: string): boolean`, `hasZoneIdentifier(hostname: string): boolean`, `assertHostIsPublic(hostname: string): Promise<string>`, and `HostBlockedError` (class extending Error with a `reason: "bad-scheme" | "private-ip" | "redirect-to-private" | "zone-id"` discriminator). The `assertHostIsPublic` function SHALL call `dns.lookup(host, {all: true})`, unwrap IPv4-mapped IPv6 addresses, reject IPv6 zone identifiers, fail closed if ANY resolved address matches a blocked CIDR, and return the first resolved address on success. An unparseable address SHALL be treated as blocked. Every outbound-TCP plugin in sandbox-stdlib SHALL consume this module rather than duplicating the blocklist or resolver.

#### Scenario: net-guard rejects RFC-1918 address

- **GIVEN** a hostname resolving to `10.0.0.1`
- **WHEN** `assertHostIsPublic("internal.host")` is called
- **THEN** the promise SHALL reject with a `HostBlockedError` whose `reason` is `"private-ip"`
- **AND** no socket SHALL be opened

#### Scenario: net-guard rejects IPv6 zone identifier

- **GIVEN** a hostname string `"[fe80::1%eth0]"`
- **WHEN** `assertHostIsPublic` is called
- **THEN** the promise SHALL reject with a `HostBlockedError` whose `reason` is `"zone-id"`

#### Scenario: net-guard returns first validated IP on success

- **GIVEN** a hostname resolving to `[1.2.3.4, 5.6.7.8]` (both public)
- **WHEN** `assertHostIsPublic(host)` is called
- **THEN** the promise SHALL resolve to `"1.2.3.4"`
- **AND** every address in the returned DNS record set SHALL have been checked against the blocklist

#### Scenario: net-guard fails closed on partial-private resolution

- **GIVEN** a hostname resolving to `[1.2.3.4, 10.0.0.1]`
- **WHEN** `assertHostIsPublic(host)` is called
- **THEN** the promise SHALL reject with a `HostBlockedError` whose `reason` is `"private-ip"`

### Requirement: createMailPlugin factory

The sandbox-stdlib package SHALL export a `createMailPlugin(): Plugin` factory. The plugin SHALL declare `name: "mail"` and `dependsOn: ["web-platform"]`. The plugin SHALL register a private (`public` unset) guest function descriptor named `$mail/send` whose handler invokes `nodemailer` to deliver SMTP mail and returns `{messageId, accepted, rejected}` on success. The plugin's `guestSource` SHALL install a locked top-level global `__mail` with a frozen inner object `{send}`, installed via `Object.defineProperty(globalThis, "__mail", { value: Object.freeze({ send }), writable: false, configurable: false })`, where `send` is the captured `$mail/send` descriptor. After capturing, the guest IIFE SHALL `delete globalThis["$mail/send"]`. The descriptor SHALL declare `log: { request: "mail" }`, a `logName` producing `"mail to <first-recipient>"`, and a `logInput` returning `{smtp, from, to, cc, bcc, replyTo, subject, timeout}` (deliberately omitting `text`, `html`, `attachments`). The handler SHALL call the net-guard primitive `assertHostIsPublic(opts.smtp.host)` before constructing the nodemailer transport, and SHALL pass the validated IP as the transport's `host` with `tls.servername` set to the original hostname. The plugin SHALL NOT define `onRunFinished` (no cross-call state).

#### Scenario: Mail send emits mail.request/mail.response triad

- **GIVEN** guest code awaits `globalThis.__mail.send(validMailOpts)` and the send succeeds
- **WHEN** the call resolves
- **THEN** a `mail.request` event SHALL be emitted with `createsFrame: true` carrying `input = {smtp, from, to, cc, bcc, replyTo, subject, timeout}`
- **AND** a `mail.response` event SHALL be emitted with `closesFrame: true` carrying `output = {messageId, accepted, rejected}`
- **AND** neither event SHALL contain `text`, `html`, or `attachments` in its payload

#### Scenario: Mail send to RFC-1918 host is refused before socket

- **GIVEN** `opts.smtp.host` resolves to `10.0.0.25`
- **WHEN** `__mail.send(opts)` is called
- **THEN** `assertHostIsPublic` SHALL reject with `HostBlockedError`
- **AND** no SMTP connection SHALL be attempted
- **AND** a `mail.error` event SHALL be emitted

#### Scenario: TLS-mode union maps to nodemailer transport options

- **GIVEN** `opts.smtp.tls === "tls"`
- **WHEN** the handler constructs the nodemailer transport
- **THEN** the transport options SHALL include `{secure: true}`

- **GIVEN** `opts.smtp.tls === "starttls"`
- **WHEN** the handler constructs the nodemailer transport
- **THEN** the transport options SHALL include `{secure: false, requireTLS: true}`

- **GIVEN** `opts.smtp.tls === "plaintext"`
- **WHEN** the handler constructs the nodemailer transport
- **THEN** the transport options SHALL include `{secure: false, ignoreTLS: true}`

#### Scenario: Timeout bounds both connection and socket

- **GIVEN** `opts.smtp.timeout === 15000`
- **WHEN** the handler constructs the nodemailer transport
- **THEN** the transport SHALL set `connectionTimeout` to `15000`
- **AND** SHALL set `socketTimeout` to `15000`

#### Scenario: Timeout default

- **GIVEN** `opts.smtp.timeout` is omitted
- **WHEN** the handler constructs the nodemailer transport
- **THEN** both `connectionTimeout` and `socketTimeout` SHALL default to `30000`

#### Scenario: Structured error for auth failure

- **GIVEN** SMTP server rejects AUTH with a 535 response
- **WHEN** the handler catches the nodemailer error
- **THEN** the thrown error SHALL carry `kind: "auth"`
- **AND** SHALL carry the numeric SMTP `code`
- **AND** SHALL carry the raw server `response` string

#### Scenario: Structured error for connection failure

- **GIVEN** TCP connect to the SMTP host fails
- **WHEN** the handler catches the nodemailer error
- **THEN** the thrown error SHALL carry `kind: "connection"`

#### Scenario: Structured error for timeout

- **GIVEN** the SMTP session exceeds `smtp.timeout`
- **WHEN** the handler catches the nodemailer error
- **THEN** the thrown error SHALL carry `kind: "timeout"`

#### Scenario: Structured error for recipient rejection

- **GIVEN** the server accepts the sender but rejects a recipient with a 5xx RCPT TO response
- **WHEN** the handler catches the nodemailer error
- **THEN** the thrown error SHALL carry `kind: "recipient-rejected"`

#### Scenario: Structured error for message rejection

- **GIVEN** the server accepts the envelope but rejects the message body with a 5xx DATA response
- **WHEN** the handler catches the nodemailer error
- **THEN** the thrown error SHALL carry `kind: "message-rejected"`

#### Scenario: __mail global is locked

- **GIVEN** the mail plugin's guest IIFE has evaluated
- **WHEN** guest code attempts `globalThis.__mail = {}` or `delete globalThis.__mail` or `globalThis.__mail.send = () => {}`
- **THEN** each attempt SHALL fail silently in non-strict mode or throw in strict mode
- **AND** the original `__mail.send` SHALL remain reachable

#### Scenario: $mail/send private descriptor is deleted after capture

- **GIVEN** the mail plugin's guest IIFE has evaluated
- **WHEN** guest code reads `globalThis["$mail/send"]`
- **THEN** the value SHALL be `undefined`

#### Scenario: Attachment content is base64 on the bridge

- **GIVEN** the host-side JSON Schema for `$mail/send` arguments
- **WHEN** validating an attachment entry
- **THEN** the schema SHALL require `content` to be a string
- **AND** the handler SHALL base64-decode `content` before passing to nodemailer

#### Scenario: Net-guard integration uses pre-resolve + SNI

- **GIVEN** `opts.smtp.host === "smtp.example.com"` resolving to `93.184.216.34`
- **WHEN** the handler constructs the nodemailer transport
- **THEN** the transport `host` option SHALL be `"93.184.216.34"` (the validated IP)
- **AND** the transport `tls.servername` option SHALL be `"smtp.example.com"` (the original hostname)

## MODIFIED Requirements

### Requirement: createFetchPlugin factory

The sandbox-stdlib package SHALL export a `createFetchPlugin(opts?: { fetch?: FetchImpl }): Plugin` factory. When `opts.fetch` is omitted, the plugin SHALL close over the `hardenedFetch` export from the same package. The plugin SHALL declare `dependsOn: ["web-platform"]`. The plugin SHALL register a private guest function `$fetch/do` whose handler invokes the bound fetch implementation and returns the serialized response. The plugin's `source` blob SHALL install a WHATWG-compliant `globalThis.fetch` that captures `$fetch/do` and marshals `Request`/`Response` to/from the host. The descriptor SHALL declare `log: { request: "fetch" }` so each fetch call produces `fetch.request`/`fetch.response` or `fetch.error`.

#### Scenario: Production fetch uses hardenedFetch by default

- **GIVEN** `createFetchPlugin()` called with no arguments
- **WHEN** guest code calls `await fetch("https://public.example.com/")`
- **THEN** the host-side handler SHALL invoke `hardenedFetch` (DNS validation via the shared net-guard primitive, IANA blocklist, redirect re-check, 30s timeout)
- **AND** the request SHALL fail closed if any hardening check rejects

#### Scenario: Test fetch override

- **GIVEN** `createFetchPlugin({ fetch: mockFetch })` with `mockFetch` a test double
- **WHEN** guest code calls `await fetch("https://any/")`
- **THEN** `mockFetch` SHALL be invoked instead of `hardenedFetch`

#### Scenario: Fetch call produces request/response events

- **GIVEN** guest code awaits `fetch("https://public.example.com/")` and the request succeeds
- **WHEN** the call resolves
- **THEN** a `fetch.request` event SHALL be emitted with `createsFrame: true`
- **AND** a `fetch.response` event SHALL be emitted with `closesFrame: true`
- **AND** the response event's `ref` SHALL point to the request event's `seq`

### Requirement: hardenedFetch export

The sandbox-stdlib package SHALL export `hardenedFetch` as a named constant — a fetch implementation that consumes the shared net-guard primitive (`assertHostIsPublic`) for host resolution and IANA special-use blocklist enforcement, rejects `data:` URLs with an error, re-validates redirect targets via the same primitive (manual follow, limit 5), strips `Authorization` on cross-origin redirects, enforces a 30s wall-clock timeout, and fails closed with a sanitized error (instance of `HostBlockedError`) on any block check failure.

#### Scenario: hardenedFetch rejects IANA special-use CIDR

- **GIVEN** a hostname resolving to an IANA private range (e.g., `10.0.0.1`)
- **WHEN** `hardenedFetch(url)` is called
- **THEN** the promise SHALL reject with a `HostBlockedError` before any socket is opened
- **AND** the error message SHALL NOT leak the resolved IP address

#### Scenario: hardenedFetch enforces 30s timeout

- **GIVEN** an upstream that never responds
- **WHEN** `hardenedFetch(url)` is called
- **THEN** the promise SHALL reject no later than 30 seconds after the call
