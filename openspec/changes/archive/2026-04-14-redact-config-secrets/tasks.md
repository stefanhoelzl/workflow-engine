## 1. Secret primitive

- [x] 1.1 Add `createSecret(value: string): Secret` factory inline in `packages/runtime/src/config.ts`. Use a closure to capture the value. Export the `Secret` type (named export) separately from the factory.
- [x] 1.2 Implement `reveal()`, `toJSON()`, `toString()`, and `[Symbol.for("nodejs.util.inspect.custom")]` on the returned object. The last three SHALL return the literal string `"[redacted]"`.
- [x] 1.3 Add unit tests in `packages/runtime/src/config.test.ts` asserting: `JSON.stringify(createSecret("abc")) === '"[redacted]"'`; `String(createSecret("abc")) === "[redacted]"`; `` `${createSecret("abc")}` === "[redacted]"``; `util.inspect(createSecret("abc")) === "[redacted]"`; `createSecret("abc").reveal() === "abc"`.

## 2. Schema integration

- [x] 2.1 In `packages/runtime/src/config.ts`, change `PERSISTENCE_S3_ACCESS_KEY_ID` and `PERSISTENCE_S3_SECRET_ACCESS_KEY` from `z.string().optional()` to `z.string().transform(createSecret).optional()`.
- [x] 2.2 Tighten the bucket-requires-credentials refine at `config.ts:65-74` to use explicit `!== undefined` checks rather than truthiness, so it survives the type change and future refactors.
- [x] 2.3 Update `packages/runtime/src/config.test.ts` S3 scenarios to assert `.reveal()` against expected cleartext rather than comparing `Secret` objects to strings directly.
- [x] 2.4 Add a config-level test asserting `JSON.stringify(createConfig({ PERSISTENCE_S3_BUCKET: ..., PERSISTENCE_S3_ACCESS_KEY_ID: "id123", PERSISTENCE_S3_SECRET_ACCESS_KEY: "supersecret" }))` does not contain either cleartext credential and does contain `"[redacted]"`.

## 3. Consumer boundary

- [x] 3.1 Update `packages/runtime/src/main.ts:35-36` so `createS3Storage` receives `config.persistenceS3AccessKeyId?.reveal() ?? ""` and `config.persistenceS3SecretAccessKey?.reveal() ?? ""`. Leave the `?? ""` fallback in place; the refine guarantees non-undefined when the bucket is set.
- [x] 3.2 Grep `packages/` for any other site that serializes `config` or reads the credential fields. Confirm no additional reveal sites are required. Document the finding in the PR description.

## 4. Documentation and threat model

- [x] 4.1 Add a NEVER bullet to the `CLAUDE.md` Security Invariants list: "NEVER add a config field sourced from a K8s Secret without wrapping it in `createSecret()` at the zod field level."
- [x] 4.2 Add the same NEVER bullet to the numbered NEVER list in `SECURITY.md` §5 (near the existing bullets at lines ~608-625).
- [x] 4.3 Add a new mitigation bullet under `SECURITY.md` §5 Mitigations: describe the `Secret` wrapper, its redaction sinks, and `reveal()` as the single exit. Reference `packages/runtime/src/config.ts`.
- [x] 4.4 Add a new residual-risk row **R-I12** under `SECURITY.md` §5 Residual risks: "AWS SDK error messages surfaced via `main.service-failed` may contain the S3 access key ID verbatim. Secret key is never echoed by the SDK. Impact: low — access key ID alone cannot authenticate. Status: Accepted."
- [x] 4.5 Add a short paragraph to `SECURITY.md` §5 noting that the `Secret` wrapper depends on the JSON serializer honoring `toJSON()`, verified for pino as of this change, and that any future log-transport change must re-verify.

## 5. Credential hygiene

- [x] 5.1 **N/A** — local-dev S3 uses hardcoded `minioadmin`/`minioadmin` defaults in `infrastructure/modules/s3/s2/s2.tf:7-8` (well-known S2 defaults, not real secrets). No `infrastructure/local/local.secrets.auto.tfvars` exists. Rotation is not meaningful for a toy default; the leaked-to-logs value has no abuse value.
- [x] 5.2 **N/A** — see 5.1. Production UpCloud S3 credentials are provisioned fresh per deploy by `upcloud_managed_object_storage_user_access_key` (`infrastructure/modules/s3/upcloud/upcloud.tf:63`), so production has no pre-existing leak window. The init-log verification will be performed the first time S3 persistence is deployed.

## 6. Validation

- [x] 6.1 Run `pnpm validate` (lint, format check, type check, tests) and confirm it passes.
- [x] 6.2 Run `pnpm exec openspec validate redact-config-secrets --strict` and confirm it passes.
- [x] 6.3 Manually review the diff against SECURITY.md §4/§5 and the proposal's NEVER list; confirm no new code path reveals or stringifies either credential outside `createS3Storage`'s call site.
