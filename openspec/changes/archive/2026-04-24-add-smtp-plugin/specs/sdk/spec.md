## ADDED Requirements

### Requirement: sendMail export

The SDK SHALL export a named function `sendMail` from `@workflow-engine/sdk`. The function SHALL accept a single options object with required fields `smtp` (object with `host: string`, `port: number`, `tls: "tls" | "starttls" | "plaintext"`, `auth: { user: string, pass: string }`, optional `timeout: number`), `from: string`, `to: string | string[]`, `subject: string`, and optional fields `cc: string | string[]`, `bcc: string | string[]`, `replyTo: string | string[]`, `text: string`, `html: string`, `attachments: Array<{filename: string, content: Blob | File | Uint8Array | ArrayBuffer | string, contentType?: string}>`. The function SHALL normalize each attachment's `content` to a base64 string before invoking `globalThis.__mail.send`: `Blob` and `File` values SHALL be awaited via `arrayBuffer()` then base64-encoded; `Uint8Array` and `ArrayBuffer` values SHALL be base64-encoded directly; plain `string` values SHALL be interpreted as UTF-8 text content of the attachment and base64-encoded. The function SHALL otherwise pass the options object through to `__mail.send` unmodified; it SHALL NOT inspect, redact, or transform any field other than attachment content. The function SHALL return the resolved `{messageId: string, accepted: string[], rejected: string[]}` from the bridge, or throw the structured error envelope propagated from the bridge.

#### Scenario: Author imports and calls sendMail

- **GIVEN** an action handler that does `import { sendMail } from "@workflow-engine/sdk"`
- **WHEN** the action awaits `sendMail({ smtp, from, to, subject, text })` with a valid configuration
- **THEN** the call SHALL resolve to `{messageId, accepted, rejected}`

#### Scenario: Blob attachment is normalized to base64

- **GIVEN** the action passes `attachments: [{filename: "x.pdf", content: blob, contentType: "application/pdf"}]` where `blob` is a `Blob` instance
- **WHEN** `sendMail` invokes `__mail.send`
- **THEN** the bridged `attachments[0].content` SHALL be a base64 string
- **AND** the SDK SHALL NOT invoke `__mail.send` with a non-string `content`

#### Scenario: File attachment is normalized to base64

- **GIVEN** the action passes `attachments: [{filename: "x.pdf", content: file}]` where `file` is a `File` instance
- **WHEN** `sendMail` invokes `__mail.send`
- **THEN** the bridged `attachments[0].content` SHALL be a base64 string

#### Scenario: Uint8Array attachment is normalized to base64

- **GIVEN** the action passes `attachments: [{filename: "raw.bin", content: bytes}]` where `bytes` is a `Uint8Array`
- **WHEN** `sendMail` invokes `__mail.send`
- **THEN** the bridged `attachments[0].content` SHALL be a base64 string encoding those bytes

#### Scenario: ArrayBuffer attachment is normalized to base64

- **GIVEN** the action passes `attachments: [{filename: "raw.bin", content: buf}]` where `buf` is an `ArrayBuffer`
- **WHEN** `sendMail` invokes `__mail.send`
- **THEN** the bridged `attachments[0].content` SHALL be a base64 string encoding the buffer contents

#### Scenario: String attachment is interpreted as UTF-8 text

- **GIVEN** the action passes `attachments: [{filename: "note.txt", content: "hello", contentType: "text/plain"}]`
- **WHEN** `sendMail` invokes `__mail.send`
- **THEN** the bridged `attachments[0].content` SHALL be the base64 encoding of the UTF-8 bytes of `"hello"`

#### Scenario: SDK does not transform non-attachment fields

- **GIVEN** the action passes a valid `sendMail` options object with `smtp.auth.pass === "secret"`
- **WHEN** `sendMail` invokes `__mail.send`
- **THEN** the bridged `smtp.auth.pass` SHALL equal `"secret"` unchanged
- **AND** the SDK SHALL NOT log, redact, or modify `smtp`, `from`, `to`, `subject`, `text`, or `html`

#### Scenario: Structured error propagates unchanged

- **GIVEN** the host-side handler throws `{kind: "auth", code: 535, message: "auth failed", response: "535 5.7.8 ..."}`
- **WHEN** the SDK caller awaits `sendMail(...)`
- **THEN** the awaited promise SHALL reject with an error preserving `kind`, `code`, `message`, and `response`
