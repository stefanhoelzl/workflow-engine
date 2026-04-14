## Context

The runtime's entry point at `packages/runtime/src/main.ts:73` calls `runtimeLogger.info("initialize", { config })`. `config` is the return of `createConfig(process.env)` (zod-parsed), which carries the S3 credentials as plain strings:

```
config = {
  logLevel, port, fileIoConcurrency, githubAuth, baseUrl,
  persistencePath,
  persistenceS3Bucket, persistenceS3Endpoint, persistenceS3Region,
  persistenceS3AccessKeyId,      ← leaks
  persistenceS3SecretAccessKey,  ← leaks
}
```

pino's default serializer calls `JSON.stringify` on the payload, so the two credential fields land in stdout on every container restart. This contradicts SECURITY.md §5 (I1: K8s Secret leaked via logs) and the §4 NEVER-log-secrets stance that currently applies to `Authorization` headers and OAuth secrets.

Prior interviews with the user (see conversation history) settled the shape of the fix: tag secret fields in the zod schema, wrap their values in a `Secret` type whose serialization hooks all redact to `"[redacted]"`, and reveal only at the boundary where the value must be handed to the AWS SDK.

```
   ┌───────────────┐   z.string().transform(createSecret).optional()
   │ process.env   │───────────────────────────────┐
   └───────────────┘                               ▼
                                          ┌─────────────────┐
                                          │    config       │
                                          │  .persistence   │
                                          │    S3Secret     │   ← Secret
                                          │    AccessKey    │
                                          └─────┬───────────┘
                                                │
                             logger.info ───────┤
                             ("initialize",     │   toJSON() / toString() /
                              { config })       │   util.inspect.custom
                                                ▼
                                           "[redacted]"
                                                ▲
                                                │
                             createS3Storage ───┤
                                                ▼
                                           .reveal() → "AKIA…"
                                                │
                                                ▼
                                           AWS SDK client
```

## Goals / Non-Goals

**Goals:**
- Prevent cleartext S3 credentials from reaching any pino log sink.
- Make the redaction structural (enforced by the type) rather than conventional (enforced by reviewer vigilance).
- Preserve the startup init log line for operational diagnostics — let it print `"[redacted]"` in place of the two fields.
- Keep the change surface small: one factory, two schema fields changed, one reveal site, test + docs.

**Non-Goals:**
- No general secrets-management framework (Vault, SOPS, external-secrets) — that's SECURITY.md R-I8, out of scope.
- No sanitization of AWS SDK error messages that may echo the access key ID on auth failure — captured as a new residual-risk row (R-I12) and accepted.
- No production credential rotation — S3 persistence has not been deployed to production (SECURITY.md R-I9 notes the bucket policy is still "for production deployment"), so only local dev credentials need rotating as hygiene.
- No pino `redact` configuration at the logger level — redundant once values self-redact via `toJSON`, and brittle against field renames.
- No new capability or separate module for `Secret` — it stays inline in `config.ts` (the only current caller). Extract later if a second caller appears.

## Decisions

### 1. Factory + closure over class

`createSecret(value: string): Secret` — closure captures the plaintext; the returned object exposes `reveal()`, `toJSON()`, `toString()`, and `[Symbol.for("nodejs.util.inspect.custom")]`. Matches CLAUDE.md's "factories over classes, closures for private state" convention.

Alternatives considered:
- **Class with private field** — works, but contradicts the project convention.
- **Branded string type** — zero runtime protection; only hides the type. Would not fix the bug.
- **Generic `Secret<T>`** — every current secret is a string; YAGNI.

### 2. Three redaction sinks

`toJSON`, `toString`, and the Node `util.inspect` custom symbol each return `"[redacted]"`.

| Sink | Catches | Required? |
|------|---------|-----------|
| `toJSON` | `JSON.stringify`, pino, structured loggers | Yes — this is the bug |
| `toString` | Template literals, `String(s)`, error concatenation | Cheap footgun |
| `util.inspect.custom` | `console.log`, Node's default object print | Cheap footgun |

`reveal()` is the single exit. No audit hook on `reveal()` — the call sites are few and grep-findable.

### 3. Field-level transform in zod

```ts
PERSISTENCE_S3_ACCESS_KEY_ID: z.string().transform(createSecret).optional(),
PERSISTENCE_S3_SECRET_ACCESS_KEY: z.string().transform(createSecret).optional(),
```

Alternatives considered:
- **Object-level transform at the end of the schema** — keeps refines operating on plain strings, but loses the "this field is a secret" signal at the field definition. The field-level tag is the thing that makes future additions hard to miss.
- **Custom `z.secret()` codec** — worth it once a third secret field exists; redundant for two.

### 4. Tighten the bucket-requires-credentials refine

The existing refine at `config.ts:65-74` uses truthy checks against `env.PERSISTENCE_S3_ACCESS_KEY_ID`. `Secret` objects are truthy, so it keeps working — but a future reader who refactors to `.length > 0` would silently break it.

Change to explicit `!== undefined`:

```ts
(env) =>
  env.PERSISTENCE_S3_BUCKET === undefined ||
  (env.PERSISTENCE_S3_ACCESS_KEY_ID !== undefined &&
   env.PERSISTENCE_S3_SECRET_ACCESS_KEY !== undefined)
```

Type-agnostic; survives the transform.

### 5. Reveal at the S3 client boundary only

`main.ts:35-36` changes to `config.persistenceS3AccessKeyId?.reveal() ?? ""`. The cleartext lives only inside the AWS SDK client's closure after that. No other module sees the revealed string.

### 6. Unit tests on `Secret` alone

The interview chose the narrower test layer: `createSecret('x')` asserts `JSON.stringify` yields `"\"[redacted]\""`, `String()` yields `"[redacted]"`, `util.inspect` yields `"[redacted]"`, `.reveal()` yields `"x"`. Pino uses `JSON.stringify` internally, so redaction in pino is proved transitively. An integration test running `init()` with a fake destination was explicitly declined.

### 7. SECURITY.md and CLAUDE.md updates

- New mitigation bullet in SECURITY.md §5 describing the `Secret` wrapper.
- New residual-risk row **R-I12**: "AWS SDK error messages surfaced via `main.service-failed` may contain the S3 access key ID verbatim. Secret key is never echoed by the SDK. Impact: low — access key ID alone cannot authenticate. Status: Accepted."
- New NEVER bullet in SECURITY.md §5 and in CLAUDE.md Security Invariants: "NEVER add a config field sourced from a K8s Secret without wrapping it in `createSecret()` at the zod field level."
- One-line note in SECURITY.md §5: "The `Secret` wrapper depends on the JSON serializer honoring `toJSON()`. Verified for pino. Revisit if the logging transport changes."

### 8. No openspec-change needed for specs beyond `runtime-config`

The `storage-backend` capability receives plain strings (after `.reveal()` at the boundary) and does not change. Only `runtime-config` scenarios — which describe the shape of `createConfig`'s return — need updating.

## Risks / Trade-offs

- **Risk.** A developer adds a future K8s-Secret-sourced env var and forgets to wrap it in `createSecret`, re-introducing the bug. → **Mitigation.** NEVER bullet in SECURITY.md §5 and CLAUDE.md; field-level wrapping is a one-line addition next to the zod definition, discoverable at the moment a developer is adding a field.

- **Risk.** AWS SDK errors quoted in `main.service-failed` may echo the access key ID. → **Mitigation.** Accepted as R-I12. Secret key is never echoed; access key ID alone has no abuse value without the secret.

- **Risk.** The `Secret` wrapper depends on `JSON.stringify` calling `toJSON()`. A future log transport that walks properties manually (e.g., a custom structured-log encoder) would bypass the redaction. → **Mitigation.** Documented as an assumption in SECURITY.md §5; reviewers changing the log transport must verify.

- **Risk.** Truthy-check refactor of the bucket-requires-creds refine could silently fail on `Secret` objects. → **Mitigation.** Refactor the refine to `!== undefined` as part of this change.

- **Trade-off.** We rotate local-dev credentials but not production. If S3 persistence is later deployed to production without a fresh credential set, the leaked-to-local-logs credentials must not be reused. Captured in the tasks list.

- **Trade-off.** Keeping the init log line means `[redacted]` appears in every log, adding a small amount of noise compared to dropping the log entirely. Preserving it is worth the operational signal for verifying effective config at startup.

## Migration Plan

No runtime migration. Config parsing changes produce a new in-process value shape; nothing persists `config` to storage. On deploy:

1. Merge the code change; image rebuild picks up the new `config.ts`.
2. Rotate the local-dev S3 credentials (console → new key pair → update `infrastructure/local/local.secrets.auto.tfvars`).
3. Re-apply local infra (`pnpm infra:up`); the new K8s Secret propagates via `envFrom.secretRef`.
4. Tail logs to confirm `"persistenceS3SecretAccessKey":"[redacted]"` appears in the init line.

Rollback: revert the commit. No data migration to undo.

## Open Questions

None. All design branches were resolved during the pre-proposal interview.
