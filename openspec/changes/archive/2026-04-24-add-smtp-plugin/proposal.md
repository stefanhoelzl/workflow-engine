## Why

Workflow authors have no way to send email from inside an action. Mail is a foundational integration primitive (transactional notifications, alerts, digests), and the current surface forces authors to go through `fetch` against a third-party HTTP→email relay, which locks them into a specific provider and its auth shape. The existing `fetch` plugin proves the pattern for sandboxed outbound I/O — add a parallel SMTP plugin so authors can send through any SMTP server they control (their own relay, Gmail, SES, SendGrid, etc.) with the same level of host-side hardening and audit observability that `fetch` already provides.

## What Changes

- Add a new `sandbox-stdlib` plugin (`packages/sandbox-stdlib/src/mail/`) exposing SMTP send capability to the sandbox via a locked global `__mail` with a single host-callable member `send(opts)`.
- Add an SDK export `sendMail` from `@workflow-engine/sdk` — a thin wrapper over `globalThis.__mail.send` that performs mechanical normalization of attachment `content` values (`Blob | File | Uint8Array | ArrayBuffer | string` → base64) before bridging.
- Bundle `nodemailer` into the plugin's `workerSource`; SMTP protocol, MIME encoding, attachments, and auth mechanisms are delegated to it. No other nodemailer transports (sendmail, SES) are enabled.
- Extract the host-resolution + RFC-1918/loopback/link-local blocklist currently embedded in `packages/sandbox-stdlib/src/fetch/hardened-fetch.ts` into a new internal util (`packages/sandbox-stdlib/src/net-guard/`). Rename `FetchBlockedError` → `HostBlockedError`. `fetch` and the new mail plugin both consume the shared util; SMTP integrates via pre-resolve + `tls.servername` override so SNI + certificate validation work unchanged.
- Reserve a new event prefix `mail.*` (`mail.request` / `mail.response` / `mail.error`) via the existing `log: { request: "mail" }` descriptor mechanism. A `logInput` filter omits `text`, `html`, and `attachments` from the audit stream (size + PII); it deliberately retains `smtp` (including `auth`) — value-level secret stripping is a separate, out-of-scope layer.
- **BREAKING** (internal runtime contract): `FetchBlockedError` is renamed to `HostBlockedError` at its declaration and at every reference site. No behavior change; single grep-replace.
- Add a new `sendDemo` action + `sendMailDemo` manualTrigger to `workflows/src/demo.ts`. The demo is self-contained: it bootstraps ephemeral test credentials via `POST https://api.nodemailer.com/user` (ethereal.email) and sends through ethereal's captured-mail SMTP. Zero operator setup, zero env-var configuration.
- Update `SECURITY.md` — §2 R-7 reserved-prefix list gains `"mail"`; §2 R-2 canonical locked-global example list mentions `__mail` alongside `__sdk`; §2 R-S4 generalizes from fetch-specific to "all outbound-TCP plugins MUST use the shared net-guard primitive" (covers fetch, mail, and any future outbound-TCP plugin).

## Capabilities

### New Capabilities
None. This change extends existing capabilities additively.

### Modified Capabilities
- `sandbox-stdlib`: adds requirements for the mail plugin (`__mail` locked global, SMTP transport, TLS-mode union, structured error envelope, `mail.*` event prefix) and for the shared net-guard primitive (extracted from the existing fetch-hardening requirement set).
- `sdk`: adds a requirement for the `sendMail` export and its attachment-content normalization behavior.

## Impact

- **Affected packages:** `@workflow-engine/sandbox-stdlib` (new `mail/` + `net-guard/` directories; internal refactor of `fetch/hardened-fetch.ts` to consume the shared util), `@workflow-engine/sdk` (new `sendMail` export).
- **New dependency:** `nodemailer` in `sandbox-stdlib` (with `@types/nodemailer`). Bundled into the mail plugin's `workerSource`.
- **APIs:** new SDK export `sendMail`; new sandbox global `__mail` (locked, non-enumerable to tenant code); new event kinds `mail.request`, `mail.response`, `mail.error`.
- **Audit format:** `InvocationEvent` gains three new `kind` values (`mail.request` / `mail.response` / `mail.error`) in `packages/core`'s `EventKind` union.
- **Dashboard:** existing event-rendering pipeline consumes the new kinds unchanged (kinds are open-ended markers); a future iteration may add a mail-specific flamegraph chip but is not in scope.
- **Tenant bundles:** the SDK bundle ships the new `sendMail` export. Tenants must rebuild via `pnpm build` and re-upload via `wfe upload --tenant <name>` to pick up the new export. Tenants not using mail see zero behavioural change.
- **State wipe:** none. `pending/`, `archive/`, and storage keys are unchanged.
- **Security docs:** `SECURITY.md` §2 R-2, R-7, R-S4 updated as listed above. No change to §3, §4, §5, §6.
- **Rollback:** revert the change; tenants that uploaded bundles calling `sendMail` would fail at first send (no `__mail` global) and would need to re-upload a mail-free bundle.
