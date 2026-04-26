## Context

The runtime today hosts three concrete `TriggerSource` implementations — cron (in-process `setTimeout` scheduler), http (Hono middleware mounted at `/webhooks/*`), and manual (dashboard-button dispatch). `triggers/spec.md` already anticipates a future IMAP trigger as the canonical example of union extension. The recently-landed trigger-config-secrets change (commit `04a9fb47`) makes sealed `env({ secret: true })` values usable anywhere a trigger descriptor takes a `z.string()` field via `\x00secret:NAME\x00` sentinel substrings resolved by `WorkflowRegistry` before `TriggerSource.reconfigure` — so IMAP credentials flow through without any new crypto plumbing.

The forcing function is the user-level gap: there is no first-class way to react to email from a workflow. Authors currently poll externally or wire webhooks from forwarder services. Both bypass the runtime's invocation accounting and sealed-secret pipeline.

Concrete constraints shaping the design:

- **Per-poll connection, not long-lived IDLE**. Simplicity for v1; mirrors cron's stateless fire loop. IDLE is left for a follow-up change; hoodiecrow's `IDLE` plugin is enabled in test so the upgrade path exists.
- **Author-controlled dedup**. No engine-invented keyword. Authors compose their own SEARCH + disposition to avoid re-firing.
- **Handler return is imperative**. Unlike cron (discarded), http (HTTP response), or manual (dashboard render), the imap handler's return value is a list of raw IMAP commands the source executes against the current UID. This is consistent with `triggers/spec.md`'s already-generic "basis for the trigger source's response" wording; the imap-trigger spec specifies its own interpretation.
- **Bridge is JSON-only**. `File` / `Blob` cannot cross into the sandbox; attachments must be base64-inline in the event payload.

## Goals / Non-Goals

**Goals:**

- Deliver an `imapTrigger({host, port, tls, user, password, folder, search, onError?, handler})` SDK factory and a runtime `ImapTriggerSource` that together react to new IMAP messages at a 60 s polling cadence.
- Parse each message via `postal-mime` into a rich payload (envelope + text/html bodies + base64-inline attachments + threading headers + raw headers map) and deliver it to the handler.
- Let the handler control post-invocation server state via a typed envelope return `{ command?: string[] }` where each string is a raw IMAP command suffix (e.g. `` `UID STORE ${msg.uid} +FLAGS (\\Seen)` ``).
- Plug into the existing sentinel-resolution path so `user` / `password` (and any other secret-capable string field) land as plaintext in the source without any imap-specific crypto code.
- Ship a pure-JS dev/test server (`hoodiecrow-imap`) via `pnpm imap` so integration tests and `demo.ts` probes exercise the real IMAP wire protocol without Podman / JVM dependencies.

**Non-Goals:**

- **IDLE (push) delivery.** Follow-up change. Author contract stays stable under that future work because dedup + disposition are already under author control.
- **OAuth2 / XOAUTH2 auth.** Authors that need it write their own access-token-refresh workflow and supply the token as a sealed secret.
- **Multi-folder watching in one trigger.** One trigger = one folder. Authors compose multiple triggers if they want multi-folder coverage.
- **Attachment streaming / chunked storage.** Attachments are base64-inline in the event (JSON-only bridge constraint). No per-attachment size cap is imposed by the engine; author responsibility, documented.
- **Automatic connection pooling across triggers.** One trigger = one connection opened per poll, closed after. Shared pooling is deferred.
- **Disposition verb validation.** Allowlist documentation only (`UID STORE`, `UID COPY`, `UID MOVE`, `UID EXPUNGE`, `EXPUNGE`); engine executes the string verbatim via imapflow's `connection.exec()` escape hatch. Anything else is the author's problem.
- **Engine-invented dedup keyword.** Every iteration of `imapTrigger` previously imagined a `$Cw-…` keyword; that design was abandoned in favour of author-owned dedup via SEARCH + disposition.
- **Cross-poll UID cursor persistence.** No disk state per trigger; author's SEARCH + disposition handles what the engine used to handle with a cursor.

## Decisions

### D1. One connection per poll, serial per trigger

Each 60 s poll tick opens a fresh TCP/TLS connection, LOGINs, SELECTs the author's `folder`, runs SEARCH, FETCHs each matching UID in turn, invokes the handler, applies the disposition, moves to the next UID, then LOGOUT/closes. The next poll is scheduled after the current batch drains. Cross-poll re-entry is impossible because `setTimeout` is only re-armed after the current poll completes.

*Alternatives considered:*

- **Long-lived connection per trigger.** Saves handshake latency but adds reconnection logic and decouples from cron's stateless-tick pattern. Rejected for v1.
- **Pooled connections per (host, user).** Good future optimization; premature for v1.
- **Parallel dispatch within a batch.** Unnecessary complexity. Serial is predictable; big backlogs drain at handler speed, which is an acceptable property for an email trigger.

### D2. Handler return is an envelope `{ command?: string[] }`

The handler's signature is `(msg: ImapMessage) => Promise<{ command?: string[] }>`. Each entry in `command` is a raw IMAP command suffix (e.g. `UID STORE <uid> +FLAGS (\\Seen)`, `UID MOVE <uid> Archive`, `UID EXPUNGE <uid>`) that the source passes verbatim to imapflow's `connection.exec()`. Empty array or omitted field → noop. The `onError` trigger-config field is the same envelope shape and is applied when the handler throws/rejects; its default is `{}`.

Envelope (not bare array) for forward compatibility — future fields like `stop: true` (abort batch) or `backoff: number` can be added without breaking the signature.

*Alternatives considered:*

- **Typed discriminated union `{ kind: "flags"|"move"|…, ... }`.** Type-safe, no injection surface, introspectable for dashboard rendering. Rejected because raw strings are consistent with the earlier raw-SEARCH decision; authors already think in IMAP-command terms.
- **Bare `string[]`.** Functionally equivalent for v1 but no extension room without breaking changes.
- **Single `string` (not array).** Loses the common "delete = flag + expunge" composition.

### D3. Author writes full UID-scoped command; engine does not bind UID

Authors write the complete command including UID / sequence-set:

```ts
handler: async (msg) => ({ command: [`UID STORE ${msg.uid} +FLAGS (\\Seen)`] })
```

The engine parses nothing, validates nothing, and passes each string verbatim to imapflow's `connection.exec()`. Supported verb list is documented (`UID STORE`, `UID COPY`, `UID MOVE`, `UID EXPUNGE`, `EXPUNGE`) but not enforced; anything else is the author's problem — typos can operate on the wrong UID or the whole mailbox.

*Alternatives considered:*

- **Engine binds UID; author writes verb + args only.** Safer (`["STORE +FLAGS (\\Seen)"]` auto-scopes to `UID STORE <msg.uid> +FLAGS (\\Seen)`), but asymmetric with raw-SEARCH decision where the engine accepts the author's raw string without scoping.
- **Verb allowlist enforcement.** Catches typos earlier at the cost of needing to extend the allowlist every time IMAP gains a useful verb. Rejected — documentation instead of enforcement.

### D4. SEARCH composition — raw passthrough

The author's `search` string is passed verbatim to the IMAP `UID SEARCH` command. Literal encoding (`{N}\r\n<bytes>`) is applied to any embedded string arguments so quote / CRLF sequences cannot break the protocol. No engine-side `UNKEYWORD $Cw-…` wrap — dedup is the author's problem, and they're free to include whatever `UNKEYWORD <their-keyword>` / `SINCE <date>` clauses make sense for their disposition.

### D5. Parsed message payload — rich, attachments base64-inline

```ts
type ImapMessage = {
  uid: number;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  from: { name?: string; address: string };
  to: Array<{ name?: string; address: string }>;
  cc: Array<{ name?: string; address: string }>;
  bcc: Array<{ name?: string; address: string }>;
  replyTo?: Array<{ name?: string; address: string }>;
  subject: string;
  date: string;                             // ISO 8601
  text?: string;
  html?: string;
  headers: Record<string, string[]>;        // duplicate headers preserved
  attachments: Array<{
    filename?: string;
    contentType: string;
    size: number;
    contentId?: string;
    contentDisposition?: "inline" | "attachment";
    content: string;                        // base64
  }>;
};
```

No engine-side cap on attachment total size; authors limit via their SEARCH or accept whatever their mailbox delivers. `postal-mime`'s `attachmentEncoding: "base64"` option provides the base64 directly, avoiding an intermediate Buffer copy.

*Alternatives considered:*

- **Full raw RFC-822 bytes as `raw: base64`.** Lets authors parse their own MIME but doubles the event size (raw + extracted).
- **Minimal parsed shape (strings only).** Pushes address parsing onto every author; inconsistent handling across workflows.
- **`File` / `Blob` attachment objects.** Bridge is JSON-only (verified in the trigger-secrets interview) — cannot survive the sandbox crossing.
- **Size cap (e.g., 5 MB per message).** Consistent user vote against any engine-level cap; documented as author's responsibility.

### D6. Credentials via existing sentinel mechanism

`host`, `user`, `password`, `folder`, `search` are all `z.string()` fields in `ImapTriggerManifest`. `env({ secret: true })` values resolve to `\x00secret:NAME\x00` sentinels at build time (SDK `resolveEnvRecord`); `WorkflowRegistry.install` substitutes plaintext before calling `ImapTriggerSource.reconfigure(owner, repo, entries)`. The imap source sees only plaintext — it never parses sentinels.

`port` (`z.number()`), `tls` (`z.enum([...])`), and `insecureSkipVerify` (`z.boolean()`) are non-sentinel-capable by shape; in practice these never need to be secret. If a future use case requires a secret port, the schema widens to `z.union([z.number(), z.string().refine(containsSentinel)])` with a coercion step — out of scope for v1.

### D7. Handler output is NOT sentinel-resolved

Sentinel resolution runs only on manifest descriptors (at `WorkflowRegistry.install`). Handler outputs are runtime values produced inside the sandbox and returned across the bridge — they never pass through `resolveSecretSentinels`. This is intentional: dispositions are author-owned strings at runtime, and the existing plaintext-literal scrubber in `packages/runtime/src/plugins/secrets.ts` already redacts registered plaintexts from outbound `WorkerToMain` messages.

A new SECURITY.md §5 invariant captures this: *"The imap trigger source SHALL NOT run `resolveSecretSentinels` on handler outputs; sentinel substitution applies only to manifest-sourced strings."*

### D8. Error taxonomy — include server text everywhere, including `auth-failed`

The imap source emits `trigger.error` with one of the following `reason` values, each carrying a fixed field set:

| reason | fields |
|---|---|
| `connect-failed` | `host`, `port`, `code` |
| `tls-failed` | `host`, `port`, `details` |
| `auth-failed` | `host`, `port`, `imapStatus`, `imapText` |
| `search-failed` | `search`, `imapStatus`, `imapText` |
| `fetch-failed` | `uid`, `imapStatus`, `imapText` |
| `disposition-failed` | `command`, `imapStatus`, `imapText` |
| `handler-failed` | standard executor-emitted shape |

Deliberate tradeoff on `auth-failed`: an unusual IMAP server that echoes LOGIN arguments in its NO response could leak credentials into the persisted event stream. Major providers (Gmail, Fastmail, Outlook.com, Dovecot) do not do this, but it is not ruled out by protocol. Accepted in favour of operator debugging over that edge case.

Poll failures back off exponentially up to 15 min; one successful poll resets cadence to 60 s.

*Alternatives considered:*

- **Redact server text on auth-failed only.** Safer but opaque when debugging misconfigured servers.
- **Include `user` identifier in `auth-failed`.** Rejected — `user` came through sentinel resolution; SECURITY §5 "plaintext confinement" reads strictly against it.

### D9. Library choice — `imapflow` + `postal-mime`

Both by the same maintainer (Andris Reinman / nodemailer), both actively maintained as of 2026, built-in TypeScript types, MIT-compatible licenses. `imapflow` is the only maintained IMAP client on npm (`node-imap` and `emailjs-imap-client` unpublished since 2022). `postal-mime` is explicitly recommended by `mailparser`'s own README as its modern successor; zero transitive dependencies; native `base64` attachment mode.

### D10. Dev / test server — `hoodiecrow-imap` with UIDPLUS + MOVE + IDLE plugins

`hoodiecrow-imap` is a scriptable IMAP mock server by the same maintainer, pure JS, in-memory state, purpose-built for integration testing. Source inspection confirms full command coverage via plugins: `uidplus` (UID EXPUNGE), `move` (UID MOVE), `idle`, `starttls`, `literalplus`. Last published 2022 but IMAP4rev1 is a frozen protocol — "deprecated" here means "no new features", not "broken".

Used for **both unit tests and `pnpm imap`** (single code path). `scripts/imap.ts` boots hoodiecrow on `localhost:3993` with a self-signed cert, fixed dev creds (`dev@localhost` / `devpass`), and blocks on SIGINT. Tests spawn the same bootstrap on a random port per suite.

*Alternatives considered:*

- **Mock imapflow at the library boundary for tests + hoodiecrow only for `pnpm imap`.** Fast hermetic tests, but risk of mock/real drift. Rejected after the interview explicitly weighed the "test the real protocol" value.
- **GreenMail container via Podman.** Actively maintained, no deprecation risk, but ~200 MB JVM image and a Podman dep for every dev session. Rejected.
- **Write a pure-JS IMAP subset server ourselves.** ~300 LOC upfront, we own every protocol edge case forever. Rejected — hoodiecrow already does this for us.

### D11. Dev-loop secret injection via existing `DEV_SECRET_DEFAULTS`

`scripts/dev.ts` already injects `WEBHOOK_TOKEN` into `process.env` before CLI upload (line 147). Adding `IMAP_USER` and `IMAP_PASSWORD` is a two-line extension. The CLI seals them against the server's public key using the unchanged seal path; runtime decrypts via the unchanged keyStore path; sentinel resolution substitutes them before `reconfigure`. Exact same code path as production, just with placeholder values.

### D12. Demo workflow composition

`workflows/src/demo.ts` gains an `inbound` imapTrigger against `localhost:3993` using sealed `IMAP_USER` / `IMAP_PASSWORD` and `insecureSkipVerify: true` (dev cert is self-signed). Its handler dispatches to an existing action (`runDemo` pattern from other triggers) and returns `{ command: [\`UID STORE \${msg.uid} +FLAGS (\\\\Seen)\`] }`. `onError` is `{ command: [\`UID STORE \${msg.uid} +FLAGS (\\\\Seen)\`] }` — deliberately simple, not a separate error-folder move, so the demo stays compact. This keeps the project convention that every SDK surface is exercised by `demo.ts`.

### D13. Flow diagram — registration to first handler

```
  wfe upload (secrets sealed via existing CLI path)
       │
       ▼
  WorkflowRegistry.install(owner, repo, manifest)
       │
       ├── decryptWorkflowSecrets(manifest)           ──► plaintextStore
       ├── resolveSecretSentinels(descriptors, store) ──► resolved entries
       └── imapSource.reconfigure(owner, repo, imapEntries)
               │
               ▼
        ImapTriggerSource stores entries; arms first timer
               │
               ▼                      (60 s later)
        poll loop for (owner, repo, trigger):
          ┌──────────────────────────────────────────────┐
          │  open TCP/TLS → LOGIN → SELECT folder         │
          │  UID SEARCH <resolved author-string>          │
          │  for each matched UID (serial):                │
          │    UID FETCH body[]                           │
          │    postal-mime parse                          │
          │    executor.invoke(handler, parsedMsg)       │
          │     ├─ success → run each cmd in output.command│
          │     │            via connection.exec()         │
          │     └─ error   → trigger.error + run each cmd  │
          │                  in trigger.onError.command    │
          │  LOGOUT → close                               │
          └──────────────────────────────────────────────┘
               │
               ▼
        arm next timer (60 s after batch completes)
```

## Risks / Trade-offs

- **[Raw-string UID scoping is a footgun]** A typo like `1:*` instead of `${msg.uid}` in the handler operates on the whole mailbox. → Symmetric with the raw-SEARCH decision; documented. Example workflows in `demo.ts` and spec scenarios consistently use `${msg.uid}` template literals to model the right pattern.
- **[`auth-failed` events may leak credentials from quirky servers]** A misconfigured / adversarial server echoing LOGIN args in its NO response would persist them in the event stream. → Accepted tradeoff, documented in D8 and a SECURITY.md §5 addendum.
- **[Infinite re-fire loop from SEARCH/disposition mismatch]** Author writes `search: "ALL"` and `handler → {}` → every message fires every poll forever. → TSC doesn't catch this; manifests as observable behaviour (dashboard shows growing invocation counts). Documentation + demo.ts example shape mitigate.
- **[Unbounded attachment payload size]** A single 200 MB attachment base64-inlined into a `trigger.request` event stalls the event loop during `JSON.stringify` and may exceed S3's 5 GB PutObject limit on extreme cases. → Author responsibility per the no-cap decision; documentation covers backend limits and event-loop stall.
- **[Hoodiecrow deprecated in 2022]** Future protocol changes or bug discoveries would not land. → IMAP4rev1 is frozen; plugin coverage for the commands we use was verified by source inspection; deprecation is a statement about "no new features" for a frozen protocol.
- **[Per-poll connection adds ~1 s handshake latency]** Negligible at 60 s cadence; becomes relevant only if a future author-tunable poll interval drops below 10 s. → Connection-per-poll choice is revisitable under IDLE follow-up.
- **[No verb validation on author output]** A `LOGOUT` command in the handler's `command` array would close the connection mid-batch, leaving subsequent messages undisposed. → Accepted per D3; documentation lists supported verbs; the batch-stop-on-error path (D8 `disposition-failed`) bounds blast radius.
- **[Plaintext credentials live in `ImapTriggerSource` instance state]** Visible to any code path that logs the descriptor. → Existing "plaintext confinement" invariant in SECURITY.md §5 already covers this for the cron source; imap gets the same carve-out explicitly. Code review is the enforcement mechanism (no main-thread scrubber).

## Migration Plan

Single-PR land. No data migration, no manifest-format breaking change (additive kind discriminator). Existing workflows unaffected.

Order within the PR (each step compiles and passes `pnpm validate` independently):

1. Add `imapflow`, `postal-mime` to `packages/runtime`, `hoodiecrow-imap` to repo root dev deps.
2. Extend `packages/core/src/index.ts` manifest schema with the imap trigger discriminator; no behaviour change until producers / consumers use it.
3. Add `imapTrigger` factory to `packages/sdk/src/index.ts` + type tests; still unused by demo.ts.
4. Add `packages/runtime/src/triggers/imap.ts` (`ImapTriggerSource`) + `imap.test.ts` using hoodiecrow; wire into `workflow-registry.ts` kind-aware dispatch.
5. Extend `scripts/dev.ts` `DEV_SECRET_DEFAULTS` with `IMAP_USER` / `IMAP_PASSWORD`; add `scripts/imap.ts` + `pnpm imap` script; add `pnpm imap:send` helper (or `pnpm imap send`) for operator probing.
6. Add the `inbound` imapTrigger to `workflows/src/demo.ts`.
7. SECURITY.md §5 addenda.

**Rollback**: revert the PR. No persistent artifacts. Existing workflows are unaffected.

## Open Questions

None. All design branches were resolved in the interview + explore sessions preceding this proposal.
