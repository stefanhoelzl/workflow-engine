## Context

The sandbox currently exposes `fetch` as a hardened outbound I/O primitive. A parallel primitive for SMTP is missing, forcing workflow authors to route email through an HTTP→email relay and bake provider-specific auth shapes into action code. The existing `fetch` plugin establishes the pattern — a host-side worker function fronted by a private `$<name>/do` descriptor, an audit-event triad (`<prefix>.request` / `.response` / `.error`) driven by `log: { request: "<prefix>" }`, and app-layer SSRF hardening via DNS resolution + IP blocklist that runs even though NetworkPolicy already blocks RFC-1918/link-local egress at the CNI layer.

The SMTP surface has three shape differences from HTTP fetch that the design must address deliberately:
1. SMTP is authenticated by design — every call carries credentials.
2. SMTP has a richer TLS story (implicit TLS on port 465, STARTTLS upgrade on port 587, plaintext-only on port 25) that `fetch`'s "scheme = https" simplification doesn't cover.
3. SMTP response codes distinguish connection failure, auth failure, recipient rejection, and message rejection — richer than HTTP's single status-code axis.

Constraints:
- The `workerSource` runs in a Node `worker_thread`, so full Node built-ins and CJS deps are available; the `guestSource` runs in QuickJS with no Node surface.
- Plugin config must be JSON-serializable (SECURITY.md §2 R-6); no function callbacks or live references across the compose boundary.
- Any top-level host-callable global installed for guest use MUST be locked via `Object.defineProperty({writable:false, configurable:false})` wrapping a frozen inner object (SECURITY.md §2 R-2).
- Event-prefix namespacing is discipline, not runtime enforcement — prefixes are strings a plugin declares (SECURITY.md §2 R-7).

## Goals / Non-Goals

**Goals:**
- Workflow authors call `import { sendMail } from "@workflow-engine/sdk"` and pass a self-contained options object — SMTP config lives per-call, not per-workflow or baked into the sandbox.
- SMTP destination is host-resolved and validated against the same RFC-1918/loopback/link-local blocklist as `fetch`, so the two plugins share a single source of truth for "what is a public host."
- Mail operations produce a clean audit-event triad (`mail.request` / `mail.response` / `mail.error`) with bodies + attachments excluded from `input` (size + PII).
- Structured error envelope with a `kind` discriminator, so action authors can branch on error class (auth vs recipient-rejected vs timeout) without regex-parsing SMTP response strings.
- The demo in `workflows/src/demo.ts` works with zero operator setup — bootstraps its own ephemeral ethereal.email credentials via a `fetch` call inside the action itself.

**Non-Goals:**
- DKIM signing. Most tenants will send via a relay that signs on their behalf; self-signing needs private-key material of a different class. Additive later.
- Connection pooling. Per-call open/AUTH/DATA/QUIT mirrors `fetch`'s per-call posture. A pool would introduce cross-call plugin state; defer until a real workload demands it.
- Address-object recipients (`{name, address}` form). `string | string[]` covers the common case; inline `"Name <addr@host>"` covers the rest.
- Opportunistic STARTTLS ("upgrade if server advertises it, else plaintext"). The `tls` union forecloses this deliberately — it's a silent-downgrade footgun.
- Mid-invocation cancellation beyond the per-call `timeout`. Matches `fetch`'s posture; a new sandbox primitive would be needed to do better and is out of scope.
- Non-SMTP nodemailer transports (sendmail, SES, Mailgun). Only the SMTP transport is reachable.

## Decisions

### Decision 1: Use nodemailer for SMTP protocol implementation

**Choice:** Bundle `nodemailer` into the plugin's `workerSource`.

**Rationale:**
- Mature, ~15M weekly downloads, handles every SMTP auth mechanism (PLAIN / LOGIN / CRAM-MD5 / XOAUTH2 / NTLM), MIME multipart, non-ASCII headers, attachments, STARTTLS.
- Error object surface is granular (`e.code`, `e.responseCode`, `e.command`, `e.response`) — a precondition for the structured error-envelope decision.
- Runs in a real Node `worker_thread`; its Node built-in deps (`net`, `tls`, `dns`, `stream`, `crypto`, `zlib`) stay external and resolve natively at runtime.
- Bundle cost is ~200 KB minified, one-time per sandbox construction. Acceptable.

**Alternatives considered:**
- `emailjs` (~40 KB). Smaller, covers core protocol, but shallower error surface and less battle-tested against provider quirks (Gmail/O365/SES idioms). Trade-off rejected — error granularity is load-bearing for the structured envelope.
- Hand-rolled SMTP client. Full control, minimal bundle. Rejected — reimplementing RFC 5321 + RFC 5322 + auth mechanisms + MIME encoding is a large attack surface for marginal benefit, and it ships as a critical path to every tenant.

### Decision 2: Per-call SMTP config, no workflow-level or plugin-level declaration

**Choice:** Every `sendMail` invocation carries its own `smtp` block. The mail plugin has no config.

**Rationale:**
- Mirrors how `fetch` takes its URL per call — maximal flexibility, no SDK surface changes needed to support multiple SMTP providers in a single workflow.
- Keeps the plugin stateless. No per-workflow config lifecycle, no reconfigure path.
- Tenant credentials flow through `workflow.env` (via `env(...)`) to the action, same pattern as any other sensitive config.

**Alternatives considered:**
- `defineWorkflow({ smtp: {...} })` declaration, baked into plugin config at sandbox construction. Rejected — requires plugin-config surface, limits workflow to one SMTP server, doesn't pay for itself.

### Decision 3: TLS mode as a three-value string union, not booleans

**Choice:** `smtp.tls: "tls" | "starttls" | "plaintext"`. Host-side maps to nodemailer: `"tls" → {secure: true}`, `"starttls" → {secure: false, requireTLS: true}`, `"plaintext" → {secure: false, ignoreTLS: true}`.

**Rationale:**
- Forecloses the silent-downgrade failure mode of nodemailer's default `secure: false` (which attempts STARTTLS if advertised, else falls through to plaintext — author thinks they have TLS when they might not).
- Covers 100% of real-world SMTP configurations with a single field: implicit TLS (port 465), forced STARTTLS (port 587), legacy plaintext (port 25 / internal relays).
- Author intent is explicit and auditable.

**Alternatives considered:**
- `secure: boolean` (nodemailer's shape). Three modes expressed across three booleans (`secure`, `requireTLS`, `ignoreTLS`). Rejected — more surface, easier to misconfigure.
- Port-based inference (465 → TLS, else STARTTLS). Rejected — surprises on non-standard ports, and authors shouldn't have to memorize port conventions.

### Decision 4: SDK export with thin wrapper + attachment normalization; bridge takes base64 only

**Choice:** `@workflow-engine/sdk` exports `sendMail`, a thin wrapper over `globalThis.__mail.send(opts)`. The wrapper's only transformation is mechanical attachment-content normalization: `Blob | File | Uint8Array | ArrayBuffer | string` are all converted to base64 strings before bridging. The bridge schema accepts `content: string` (base64) only.

**Rationale:**
- "Thin wrapper" means the SDK does not inspect, redact, or validate credentials — it does not touch `smtp.auth` or any payload field.
- Guest-side attachment ergonomics are strictly better than forcing authors to base64-encode manually; the normalization is mechanical and always correct.
- Monomorphic bridge input schema — validated host-side via JSON Schema (no zod in the hot path) — is simpler and faster to validate than a union type.
- A plain JS string as `content` is interpreted as UTF-8 text content of the attachment (matches nodemailer's string-content semantics).

**Alternatives considered:**
- Pass binary as `Uint8Array` across the bridge. Rejected — base64 is lossy-free, the bridge already serializes JSON, and binary crossing QuickJS boundaries requires per-plugin special-casing.
- Author base64-encodes. Rejected — ergonomically worse and easier to get wrong.

### Decision 5: Extract the IP-block primitive; rename `FetchBlockedError` → `HostBlockedError`

**Choice:** Move `BLOCKED_CIDRS_IPV4/6`, `isBlockedAddress`, `hasZoneIdentifier`, `assertHostIsPublic` out of `packages/sandbox-stdlib/src/fetch/hardened-fetch.ts` into a new file `packages/sandbox-stdlib/src/net-guard/index.ts`. Rename `FetchBlockedError` → `HostBlockedError`. Fetch imports from `net-guard`; so does the mail plugin.

**Rationale:**
- The extracted symbols already have zero coupling to fetch — they're pure data + pure functions + one async resolver. The coupling boundary is at `makeConnector()` (undici-specific), which stays in fetch.
- Sharing the blocklist is a single-source-of-truth property: updating the IANA special-use list updates both plugins at once. Matters when a future RFC adds a new reserved CIDR.
- `FetchBlockedError` in a mail-plugin error message would be confusing; renaming is the clean fix. One grep-replace across a small blast radius.

**Alternatives considered:**
- Duplicate the block list into the mail plugin. Rejected — drift risk.
- Keep `FetchBlockedError` name, re-export from `net-guard`. Rejected — ugly and confusing for mail errors.

### Decision 6: SMTP net-guard integration uses pre-resolve + `tls.servername` override (parity with fetch)

**Choice:** Before constructing the nodemailer transport, call `assertHostIsPublic(opts.smtp.host)` to get a validated IP. Hand nodemailer `host: <ip>` with `tls: { servername: opts.smtp.host }` so SNI and certificate validation use the original hostname.

**Rationale:**
- Closes the TOCTOU window between DNS validation and connection establishment (otherwise a ~µs gap where DNS could rotate).
- Matches fetch's posture at the undici connector layer — consistent hardening across outbound plugins.
- Nodemailer natively supports `tls.servername`; no patching required.

**Alternatives considered:**
- Pre-validate only, then let nodemailer resolve independently. Rejected — reopens the TOCTOU window and diverges from fetch.

### Decision 7: Event prefix `mail.*` via `log: { request: "mail" }`

**Choice:** The `$mail/send` descriptor declares `log: { request: "mail" }`, which the sandbox core's auto-wrap treats as the prefix for emitted events (`mail.request` before handler, `mail.response` on resolve, `mail.error` on reject). Descriptor also sets `logName` to `"mail to <first-recipient>"` and `logInput` to pick `{smtp:{host,port,tls,timeout}, from, to, cc, bcc, replyTo, subject}` (strips `text`, `html`, `attachments`, **and `smtp.auth`**).

**Rationale:**
- Clean taxonomy — dashboards can filter mail operations distinct from user-defined actions or fetch calls.
- Mechanism already exists (fetch uses the same pattern with `log: { request: "fetch" }`). Zero new machinery.
- `logInput` filter addresses the size + PII concern (bodies + attachments can be multi-MB and routinely contain PII).
- `smtp.auth` is dropped per the same `Authorization`-header rule fetch follows (SECURITY.md §4): credentials don't go into the audit message in the first place. The runtime `secrets` plugin's `onPost` scrubber catches every registered plaintext as defense-in-depth — credentials bound via `env({ secret: true })` are redacted automatically even if a future diff accidentally re-included them. The `addSecret` descriptor itself does the same thing for exactly this reason: `logInput: () => ["[secret]"]`. Scrubber as backstop, `pick` as floor.

**Alternatives considered:**
- Piggyback on `action.*`. Rejected — loses taxonomy, makes dashboard filtering harder, and conflates user code with sandbox primitives.
- Retain `smtp.auth` and rely solely on the `secrets` scrubber. Rejected — the scrubber only catches strings the author registered (via `env({secret:true})` or `secret(value)`); a workflow that hardcodes `pass: "literal"` (wrong on its own merits, but possible) would still leak. The Authorization-header rule is the canonical posture: don't put it in the message, period.

### Decision 8: Return `{messageId, accepted, rejected}`, throw structured error envelope

**Choice:** On success, resolve `{messageId, accepted, rejected}` (passes through nodemailer's corresponding fields). On failure, throw an object-like error with `kind: "auth" | "recipient-rejected" | "connection" | "timeout" | "message-rejected"`, plus `code?` (SMTP response code), `response?` (raw server response string), and `message`.

**Rationale:**
- `accepted` / `rejected` arrays are necessary for multi-recipient sends where some succeed and others fail; a single-boolean success model loses information.
- `messageId` enables downstream correlation (e.g., log aggregation against a mail-provider's delivery webhook).
- Structured error `kind` lets authors branch without string-matching: `try { await sendMail(...) } catch (e) { if (e.kind === "auth") ... }`.

**Alternatives considered:**
- `{messageId}` only, partial-delivery surfaces only as thrown error. Rejected — loses accepted/rejected granularity that matters for bulk sends.
- Plain `Error` with message only. Rejected — forces authors to regex the message string to decide behavior.

### Decision 9: No `onRunFinished`; per-call `timeout` bounds in-flight duration

**Choice:** The mail plugin does not define `onRunFinished`. Each `sendMail` call is self-contained (nodemailer `createTransport` + `sendMail` + implicit `QUIT`); no pool, no long-lived sockets. `smtp.timeout` (default 30_000 ms) sets both `connectionTimeout` and `socketTimeout` on the transport, capping in-flight duration.

**Rationale:**
- Plugin has no cross-call state → nothing to clean up on run end.
- If an invocation is torn down mid-DATA-phase, the nodemailer promise keeps running host-side until the socket timeout fires (~30s max). SMTP's commit semantics are transactional — the message is committed only after the server responds `250 OK` to `<CRLF>.<CRLF>`, so the failure modes are: "drop before commit → no mail sent, safe to retry" or "drop after commit → mail sent, no audit event emitted." Matches fetch's inherent ambiguity window; documented, not a defect.

**Alternatives considered:**
- Implement `onRunFinished` to eagerly abort the nodemailer transport. Rejected — adds complexity for near-zero benefit (the timeout already caps duration), and nodemailer's abort surface is limited.
- Pool connections within an invocation. Rejected — adds state, adds `onRunFinished` obligation, and the workload shape we're targeting (1–3 transactional sends per invocation) doesn't need amortization.

### Decision 10: Self-contained demo via ethereal.email REST bootstrap

**Choice:** Demo action fetches `POST https://api.nodemailer.com/user` to bootstrap ephemeral SMTP credentials on each invocation, then sends through the returned ethereal.email SMTP host. Exposed as a manualTrigger only (not cron, not part of `runDemo`).

**Rationale:**
- Zero operator setup — demo "just works" on a fresh clone, mirroring how `fetchEcho` works without any operator config.
- Exercises a realistic cross-plugin workflow shape (`fetch` to get config → `sendMail` to use it) that tenants will use for provider-specific bootstrap patterns.
- Ethereal.email is purpose-built for this (run by nodemailer's maintainer, messages captured and viewable at a URL returned in the bootstrap response, never actually delivered).
- Public REST endpoint requires no auth, no account, and resolves to a public IP — passes the net-guard.

**Alternatives considered:**
- In-cluster mailhog/mailpit. Rejected — would resolve to a K8s-internal IP, refused by net-guard. Poking a hole in the net-guard for a demo would be worse than the demo not existing.
- Env-sourced operator-configured SMTP. Rejected — fails silently in unconfigured installs, hides the demo surface from new developers.
- Runtime bootstrap at startup. Rejected — couples runtime startup to a third-party domain for a demo feature; wrong layering.

## Risks / Trade-offs

- **Nodemailer bundle health** → The worker build uses `@rollup/plugin-commonjs`. Nodemailer (and any of its transitive deps) may contain dynamic `require`, circular CJS, or wildcard star-exports that trip the bundler. Mitigation: discoverable at first `pnpm build`; failure modes are build errors, not runtime errors. If a specific dep misbehaves, the existing `pnpm patch` precedent (applied to `fetch-blob`) handles the worst case.
- **TOCTOU in SMTP connect even with pre-resolve** → Pre-resolving and handing nodemailer an IP closes the window to microseconds. The remaining risk is a compromised authoritative DNS rotating between our validation and nodemailer's connect, which is indistinguishable from a compromised DNS in the first place. Mitigation: accepted as residual; matches fetch's posture.
- **SMTP commit ambiguity on invocation cancellation** → If the invocation dies between the server's `250 OK` response and our parsing of it, the mail is sent but no `mail.response` event is emitted. Retry could double-send. Mitigation: documented in design as inherent to at-most-once remote side effects; matches fetch's POST-ambiguity window. Action authors responsible for idempotency if they need it.
- **Credential echo in `mail.error.response`** → SMTP `AUTH LOGIN` flow base64-encodes the user in a command the server may echo back in an error response. If auth fails, the raw response string lands in `mail.error`, including the echoed user (not the password — servers never echo passwords). Mitigation: the future value-level secrets-stripping layer is the correct mitigation; this design deliberately does not do descriptor-level error redaction, for consistency with the rest of the event stream.
- **Ethereal.email availability for demo** → Demo depends on `api.nodemailer.com` being up. If it's down, the demo fails with a fetch error. Mitigation: accepted. Demo is not production-critical; fetch failure is still a useful "this is the error-path UX" learning moment for devs.
- **Rename `FetchBlockedError` → `HostBlockedError`** → Internal breaking change across a small blast radius. Mitigation: single grep-replace; confined to `sandbox-stdlib` and its tests. No tenant-facing API shift.
- **Bundle size growth** → Adds ~200 KB of nodemailer to `sandbox-stdlib`. Cold-start path reads + base64-decodes all plugin `workerSource` strings. At current plugin count (web-platform, fetch, timers, console, mail) the cost is modest; if the stdlib grows by N similar plugins, cold-start becomes noticeable. Mitigation: accepted for v1; no CI size gate added. Revisit if cold-start regresses.
