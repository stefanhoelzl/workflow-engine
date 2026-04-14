## Why

`packages/runtime/src/main.ts:73` emits `runtimeLogger.info("initialize", { config })` on every startup. `config` contains `persistenceS3SecretAccessKey` and `persistenceS3AccessKeyId` as plain strings, so the S3 credentials land in stdout — captured by kubectl logs, log shippers, and any terminal running `pnpm start`. This violates SECURITY.md §5 (K8s Secrets must not leak via logs — threat I1) and the §4 NEVER-log-secrets invariant. The bug shipped with the S3 storage backend on 2026-04-08 and has been latent since.

## What Changes

- Introduce a `Secret` value type in `packages/runtime/src/config.ts` (factory + closure) whose `toJSON()`, `toString()`, and `[Symbol.for("nodejs.util.inspect.custom")]` all return `"[redacted]"`. `.reveal()` is the single exit.
- Change `PERSISTENCE_S3_ACCESS_KEY_ID` and `PERSISTENCE_S3_SECRET_ACCESS_KEY` zod fields to `z.string().transform(createSecret).optional()`. Config consumers receive `Secret | undefined` instead of `string | undefined`.
- Tighten the bucket-requires-credentials refine in `config.ts` to use explicit `!== undefined` checks rather than truthiness, so future refactors cannot silently break it against `Secret` values.
- Update `main.ts` to call `.reveal()` at the `createS3Storage` boundary — the only place the cleartext credential must leave the wrapper.
- Extend SECURITY.md §5 with a new mitigation bullet (the `Secret` wrapper), a residual-risk row for AWS SDK errors that may still echo the access key ID, and two NEVER bullets (wrap K8s-Secret-sourced config fields; assume the JSON serializer honors `toJSON()`). Mirror the wrap-in-`Secret` NEVER into CLAUDE.md's Security Invariants list.
- No production rotation required: S3 persistence has only been exercised in local dev; local dev credentials are rotated as hygiene.

## Capabilities

### New Capabilities

_None._ The `Secret` primitive lives inside `runtime-config` and does not need a standalone capability.

### Modified Capabilities

- `runtime-config`: `PERSISTENCE_S3_ACCESS_KEY_ID` and `PERSISTENCE_S3_SECRET_ACCESS_KEY` resolve to `Secret`-wrapped values rather than plain strings; serialization requirements must forbid cleartext exposure.

## Impact

- **Code.** `packages/runtime/src/config.ts` (schema + factory), `packages/runtime/src/main.ts:29-48` (reveal at S3 boundary), `packages/runtime/src/config.test.ts` (assertions switch to `.reveal()`; new unit tests for `Secret`).
- **Specs.** `openspec/specs/runtime-config/spec.md` scenario prose changes to describe `Secret`-wrapped outputs.
- **Docs.** `SECURITY.md` §5 (mitigations + residual risks + NEVER list), `CLAUDE.md` (Security Invariants list).
- **Consumers.** `createS3Storage` signature unchanged; no downstream breakage. AWS SDK receives revealed strings as today.
- **Rotation.** Local dev S3 access key + secret rotated on deploy; production unaffected (S3 backend not yet deployed to prod per SECURITY.md §I9).
- **Logs.** Startup init log line remains, but now prints `"[redacted]"` in place of the two credential fields. No observability regression.
