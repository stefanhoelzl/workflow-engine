## 1. Extract net-guard primitive

- [x] 1.1 Create `packages/sandbox-stdlib/src/net-guard/index.ts` exporting `BLOCKED_CIDRS_IPV4`, `BLOCKED_CIDRS_IPV6`, parsed CIDR lists, `isBlockedAddress`, `hasZoneIdentifier`, `assertHostIsPublic`, `HostBlockedError` — lifted verbatim from `packages/sandbox-stdlib/src/fetch/hardened-fetch.ts`
- [x] 1.2 Rename `FetchBlockedError` → `HostBlockedError` at declaration and every reference (grep `FetchBlockedError` across the repo; confined to sandbox-stdlib + its tests)
- [x] 1.3 Update `packages/sandbox-stdlib/src/fetch/hardened-fetch.ts` to import from `net-guard` and remove its duplicate copies of the extracted symbols
- [x] 1.4 Add a unit test file `packages/sandbox-stdlib/src/net-guard/net-guard.test.ts` covering: RFC-1918 rejection, IPv6 zone-identifier rejection, first-IP return on success, fail-closed on partial-private resolution, unparseable-address rejection
- [x] 1.5 Confirm existing fetch tests still pass with the extracted module

## 2. Add nodemailer dependency

- [x] 2.1 Add `nodemailer` + `@types/nodemailer` to `packages/sandbox-stdlib/package.json` dependencies
- [x] 2.2 Run `pnpm install`; confirm lockfile changes are limited to sandbox-stdlib's dependency tree
- [x] 2.3 Run `pnpm build` on `packages/sandbox-stdlib`; confirm nodemailer bundles into a worker-test build without commonjs/dynamic-require errors — if it fails, capture the specific failing dep and either configure `commonjs({ ignoreDynamicRequires: true })` locally or add a `pnpm patch` entry

## 3. Implement mail plugin — worker side

- [x] 3.1 Create `packages/sandbox-stdlib/src/mail/index.ts` exporting `name = "mail"`, `dependsOn = ["web-platform"]`, and `worker(ctx, deps, config)` returning the `PluginSetup`
- [x] 3.2 Implement the `$mail/send` handler: validate input shape via JSON Schema (`args` descriptor); call `assertHostIsPublic(smtp.host)`; construct nodemailer transport with `host: <ip>`, `tls.servername: <original-host>`, and the tls-union mapping (`"tls"→{secure:true}`, `"starttls"→{secure:false, requireTLS:true}`, `"plaintext"→{secure:false, ignoreTLS:true}`); map `smtp.timeout` (default 30_000) to both `connectionTimeout` and `socketTimeout`; base64-decode each attachment's `content` before handing to nodemailer; call `transport.sendMail(msg)`; return `{messageId, accepted, rejected}`
- [x] 3.3 Map nodemailer error classes to structured envelope: `kind: "auth" | "recipient-rejected" | "connection" | "timeout" | "message-rejected"` using `e.code` / `e.responseCode` / `e.command` lookup; attach `code`, `response`, `message` to the thrown object
- [x] 3.4 Declare the descriptor with `log: { request: "mail" }`, `logName: (args) => "mail to <first-recipient>"`, `logInput: (args) => pick(args[0], ["smtp","from","to","cc","bcc","replyTo","subject","timeout"])` (omits `text`, `html`, `attachments`), `public: false`

## 4. Implement mail plugin — guest side

- [x] 4.1 Add `export function guest(): void` to `packages/sandbox-stdlib/src/mail/index.ts`
- [x] 4.2 Inside `guest()`: capture `$mail/send` into a local `const send = globalThis["$mail/send"]`, then `delete globalThis["$mail/send"]`
- [x] 4.3 Install `__mail` as a locked global: `Object.defineProperty(globalThis, "__mail", { value: Object.freeze({ send }), writable: false, configurable: false, enumerable: false })`

## 5. Wire mail plugin into runtime composition

- [x] 5.1 Import the mail plugin via `?sandbox-plugin` at whichever runtime composition site currently imports fetch/timers/console/web-platform
- [x] 5.2 Add the mail plugin to the plugin list in topological order (after web-platform)
- [x] 5.3 Add `mail.request`, `mail.response`, `mail.error` to `EventKind` in `packages/core/src/index.ts`
- [x] 5.4 Confirm `pnpm build` on the runtime succeeds with the new plugin

## 6. SDK export

- [x] 6.1 Implement `sendMail` in `packages/sdk/src/index.ts` (or the nearest appropriate file): accepts the full options object; normalizes `attachments[*].content` from `Blob | File | Uint8Array | ArrayBuffer | string` → base64 string; calls `globalThis.__mail.send(normalized)`; returns / rethrows unchanged
- [x] 6.2 Add TypeScript types for `SendMailOptions`, `SendMailResult`, and the structured error (union of the five `kind` values)
- [x] 6.3 Export `sendMail` + its types from `@workflow-engine/sdk`

## 7. Demo

- [x] 7.1 Add `sendDemo` action to `workflows/src/demo.ts`: fetches `POST https://api.nodemailer.com/user` with `{requestor: "workflow-engine-demo", version: "1"}`, then calls `sendMail` using the returned credentials with `tls: "starttls"`
- [x] 7.2 Add `sendMailDemo` manualTrigger wrapping `sendDemo` — input `{to: z.string().email()}`, output `{messageId, viewUrl}`
- [x] 7.3 Do NOT wire `sendDemo` into `runDemo` — it stays isolated to its own trigger
- [x] 7.4 Manually exercise the demo via the local dashboard: invoke `sendMailDemo`, confirm the `mail.request` / `mail.response` events appear, confirm the returned `viewUrl` resolves to a valid captured message

## 8. Tests

- [x] 8.1 Unit tests for `$mail/send` handler in `packages/sandbox-stdlib/src/mail/mail.test.ts` using a mock nodemailer: success path (`{messageId, accepted, rejected}` returned), each TLS mode maps correctly, timeout default and override, each structured-error `kind` produced from the matching nodemailer error shape, private-IP host rejected before nodemailer is constructed
- [x] 8.2 Sandbox-boundary test: `__mail` is locked — assignment / delete / property-mutation all fail; `$mail/send` is `undefined` after guest IIFE
- [x] 8.3 Sandbox-boundary test: `logInput` strips `text`, `html`, `attachments` from emitted `mail.request.input`
- [x] 8.4 Sandbox-boundary test: SMTP destination validation — `__mail.send` against a host resolving to `10.0.0.1` rejects with `HostBlockedError` and emits `mail.error`
- [x] 8.5 SDK test: each attachment content type (`Blob`, `File`, `Uint8Array`, `ArrayBuffer`, `string`) normalizes to the expected base64 string before bridging
- [x] 8.6 SDK test: non-attachment fields (`smtp.auth.pass`, `subject`, `from`) pass through unmodified

## 9. Security docs

- [x] 9.1 Append `"mail"` to SECURITY.md §2 R-7 reserved-prefix list
- [x] 9.2 Update SECURITY.md §2 R-2 canonical locked-global example list to include `__mail` alongside `__sdk`
- [x] 9.3 Generalize SECURITY.md §2 R-S4 from fetch-specific to "all outbound-TCP plugins MUST use the shared `net-guard` primitive (`assertHostIsPublic`)" — cover fetch, mail, and any future outbound-TCP plugin

## 10. Release + validation

- [x] 10.1 Add an upgrade note entry to CLAUDE.md `## Upgrade notes` section (additive; no state wipe; tenants re-upload to pick up new SDK export)
- [x] 10.2 Run `pnpm validate` — confirm lint, type check, and test suite pass
- [x] 10.3 Run `pnpm local:up:build` and manually exercise `sendMailDemo` end-to-end against ethereal.email
- [x] 10.4 Run `pnpm exec openspec validate add-smtp-plugin --strict` and fix any reported issues
