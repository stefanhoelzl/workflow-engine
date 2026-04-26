## Why

Workflow authors currently have three trigger kinds — `httpTrigger`, `cronTrigger`, `manualTrigger` — none of which react to incoming email. Email is the dominant asynchronous-event channel for many business integrations (invoice receipts, customer replies, ticket-system notifications, OAuth verification codes), and today authors who want an email-driven workflow must run their own IMAP polling loop as a side service that calls a webhook. That external loop duplicates infrastructure, holds credentials outside the sealed-secret pipeline, and bypasses the runtime's invocation accounting.

The `triggers` spec already names `MailTrigger` as the canonical example of a future union extension, and the rebased trigger-config-secrets change means sealed credentials can now flow from `env({ secret: true })` declarations into trigger descriptors without any new crypto plumbing. The remaining work is the concrete `imapTrigger` kind itself: SDK factory, runtime `TriggerSource` with its polling loop, manifest schema, and a disposition model that lets the handler decide what to do with each message (mark read, label, move, delete, or no-op).

## What Changes

- New `imapTrigger` SDK factory: `imapTrigger({ host, port, tls, insecureSkipVerify?, user, password, folder, search, onError?, handler })`.
- New runtime `TriggerSource<"imap", ImapTriggerDescriptor>` implementing a per-(owner, repo) polling loop at 60 s cadence, one TCP connection per poll, serial dispatch across matched messages.
- Handler receives a parsed message payload (envelope + text/html bodies + base64-inline attachments) and returns `Promise<{ command?: string[] }>` — an array of raw IMAP command suffixes the source executes against the current UID after a successful invocation. `onError` on the trigger config provides the same shape when the handler throws.
- Manifest schema extended with `ImapTriggerManifest` alongside the existing cron/http/manual shapes. All string-typed fields participate in the existing secret-sentinel resolution path (no new crypto).
- `workflows/src/demo.ts` gains an `inbound` imapTrigger against a locally-run `hoodiecrow-imap` server, keeping the "every trigger kind is probe-exercisable under `pnpm dev`" invariant from CLAUDE.md.
- New `pnpm imap` foreground script that boots `hoodiecrow-imap` on `localhost:3993` with IMAPS + self-signed cert + dev credentials and the `UIDPLUS`, `MOVE`, `IDLE`, `STARTTLS`, `LITERALPLUS` plugins enabled. `scripts/dev.ts`'s `DEV_SECRET_DEFAULTS` table gains `IMAP_USER` / `IMAP_PASSWORD` entries.
- SECURITY.md §5 gains two invariants: `imap` source's handler output is NOT sentinel-resolved (only manifest descriptors are), and resolved IMAP credentials in source state are permitted plaintext per the already-established "plaintext confinement" carve-out.

## Capabilities

### New Capabilities

- `imap-trigger`: the `imapTrigger` SDK factory contract, the runtime `ImapTriggerSource` implementation (polling cadence, SEARCH composition, disposition execution, error taxonomy), the parsed-message input shape, the `{ command?: string[] }` output shape, and the dev-loop / hoodiecrow test harness.

### Modified Capabilities

- `triggers`: extend the `Trigger` union from `HttpTrigger | CronTrigger | ManualTrigger` to include `ImapTrigger`. The `TriggerSource` interface itself is unchanged.
- `sdk`: export the `imapTrigger` factory and re-export its descriptor / input / output types from the package root.
- `core-package`: add `imapTriggerManifestSchema` (discriminated on `type: "imap"`) to the manifest zod union; all string fields validate as `z.string()` so sentinel substrings pass unchanged.
- `workflow-registry`: add the `imap` kind to the kind-aware dispatch and descriptor-build paths; the existing secret-sentinel resolution already covers the new string fields without further changes.

## Impact

- **Code**: new `packages/runtime/src/triggers/imap.ts` and `packages/runtime/src/triggers/imap.test.ts`; edits to `packages/sdk/src/index.ts`, `packages/core/src/index.ts`, `packages/runtime/src/workflow-registry.ts`, `workflows/src/demo.ts`, `scripts/dev.ts`, and a new `scripts/imap.ts`.
- **Runtime dependencies**: `imapflow` (IMAP client) and `postal-mime` (MIME parser) added to `packages/runtime`. `hoodiecrow-imap` added as a dev dependency of the repo root for test + dev-loop use only.
- **Networking**: production deployments need egress to TCP/993 (IMAPS) on whichever hosts the author's workflows target. The `NetworkPolicy` for the app pod must permit this; the change's tasks include a `Cluster smoke (human)` block for that verification.
- **Event stream**: imap triggers emit the existing `trigger.request` / `trigger.response` / `trigger.error` vocabulary. `trigger.response.output` carries the full `{ command?: string[] }` envelope for dashboard visibility. No new event-kind prefix.
- **Dashboard**: workflow detail and invocation renderers treat the new descriptor like any other trigger kind; the disposition array shows in the response-output panel as a list of command strings.
- **Security**: trigger-time plaintext credentials live in `ImapTriggerSource` instance state (existing carve-out covers this). Handler-produced disposition strings bypass sentinel resolution deliberately — sentinels only appear in manifest-sourced strings. Deliberate, documented tradeoff: `trigger.error` events for `auth-failed` include server response text, which on an unusual server echoing LOGIN args back could leak credentials. Accepted in favour of operator debugging.
