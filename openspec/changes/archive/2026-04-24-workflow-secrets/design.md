## Context

Two prerequisite changes have landed:

- **workflow-env-runtime-injection** added `RuntimeWorkflow<Env>`, `RuntimeSecrets`, `GuestGlobals`, `installGuestGlobals` in `@workflow-engine/core`; added `PluginSetup.onPost` in `@workflow-engine/sandbox`; installed `globalThis.workflow` with a mutable `env` record per run via a minimal `env-installer` plugin. `workflow.env.X` at runtime now returns build-time-resolved values from `manifest.env`. No secrets yet.
- **secrets-crypto-foundation** added infrastructure keypair provisioning, the `SECRETS_PRIVATE_KEYS` env var, a key-store with `getPrimary()` + `lookup(keyId)` + `decryptSealed(...)`, the `GET /api/workflows/:tenant/public-key` endpoint, upload decrypt-verify, and executor per-invocation decryption routing `plaintextStore` through the `run` message's ctx. No consumer reads `ctx.plaintextStore` yet.

This change fills in the author-facing surface and the runtime consumer. The design is Option 4 from the architecture discussion: plaintexts are plain strings in `workflow.env`, no opaque wrapping, protection is literal-match scrubbing at `post()` via `onPost`.

## Goals / Non-Goals

**Goals:**
- Author declares secrets with `env({ name, secret: true })` — rejects `default` at the type level.
- `workflow.env.TOKEN` at runtime returns the plaintext string, indistinguishable in type from a regular env binding.
- `secret(value: string): string` for runtime-registered sensitive values.
- Vite plugin routes secret bindings into a `secretBindings: string[]` list on the build-artifact manifest, never writes plaintext/ciphertext.
- CLI seals secret env values against the server public key at upload time and rewrites the manifest.
- Runtime `secrets` plugin installs `globalThis.workflow` with plaintexts merged in + `globalThis.$secrets` with `addSecret`, scrubs every outbound worker→main message.
- Swap the `env-installer` plugin for the `secrets` plugin in the production composition (`env-installer` is retired in this change).

**Non-Goals:**
- No opaque `Secret` handle class. No `.reveal()`. `workflow.env.TOKEN` is `string`.
- No `secret\`Bearer ${x}\`` tagged template. `secret(value)` is a plain function call only.
- No `revealSecrets` flag on guest functions. Every plugin handler receives plaintexts naturally (which is either wanted or harmless — see Option 4 analysis).
- No sentinel-based substitution. The scrubber operates on literal plaintext strings.
- No minimum plaintext length enforcement. Author's responsibility.
- No author-side transformation matching (base64, hex, hash). Documented limitation.
- No WebCrypto-with-secrets special casing. `crypto.subtle.importKey("raw", new TextEncoder().encode(env.HMAC_KEY), ...)` works naturally because env is plaintext.

## Decisions

### Decision 1: `env({ secret: true })` is a discriminated type

The `env()` factory accepts `{ name?, default?, secret?: boolean }`. The return type SHALL be a discriminated union between `EnvRef` (non-secret) and `SecretEnvRef` (secret: true). `default` SHALL be statically rejected when `secret: true`.

```ts
function env(opts: { name?: string; default?: string }): EnvRef;
function env(opts: { name?: string; secret: true }): SecretEnvRef;
// Overload union rejects { secret: true, default: "..." } at type-check time
```

This gives the Vite plugin a clean discriminant when walking declared env entries. At runtime, both return types are resolved to strings; the discriminator only matters at build-time routing.

**Alternatives considered:** dedicated `secret()` factory on the declaration side (rejected previously — author's preference for single-factory ergonomics).

### Decision 2: Vite plugin emits `manifest.secretBindings: string[]`

At build-time discovery (inside `runIifeInVmContext`), the plugin walks the workflow's env declarations:

- `EnvRef` (non-secret) → resolved via `process.env` → written to `manifest.env[key]`.
- `SecretEnvRef` (secret) → NOT resolved; the envName is added to a new `manifest.secretBindings: string[]` field.

`manifest.secretBindings` is an intermediate build-artifact field. The server rejects uploads that still contain it (sees it as out-of-schema). The CLI is expected to consume and drop it before upload.

**Why not seal at build time?** The author's `process.env` at build time may not contain the secret values (e.g., CI builds the bundle on one job and uploads on a separate job with different env). Reading at CLI time (upload job) aligns with how GHA typically injects secrets — into the upload step, not the build step. Also, this keeps plaintexts off the build artifact on disk.

**Alternatives considered:**
- Seal at build time with a "to-seal" plaintext field in the manifest. Rejected — plaintexts on disk are a risk class we avoid.
- Skip the intermediate field entirely; let CLI re-scan source for `env({secret:true})`. Rejected — CLI would need to load and evaluate the bundle, duplicating plugin discovery.

### Decision 3: CLI fetch-PK + seal + rewrite flow

On `wfe upload --tenant <name>`:

1. Extract tarball, parse manifests, find workflows with non-empty `secretBindings`.
2. If any workflow has secretBindings, `fetch <api>/api/workflows/<tenant>/public-key` once. Validate response shape. Decode pk.
3. For each workflow with secretBindings, for each envName: `plaintext = process.env[envName]`; if undefined and envName has no known default, fail with clear error; `ct = crypto_box_seal(plaintext, pk)`; assign `manifest.secrets[envName] = base64(ct)`.
4. Set `manifest.secretsKeyId = response.keyId` for each such workflow.
5. Delete `manifest.secretBindings` from each manifest.
6. Repack the tarball with the rewritten manifests (no other bundle file changes).
7. POST the rewritten bundle as before.

`wfe upload` SHALL NOT write the rewritten manifest or the plaintexts to disk. All processing is in-memory.

**Error cases:**
- Missing `process.env[envName]` → error "Missing env var for secret binding: <envName>. Set it in the shell running `wfe upload`."
- Public-key fetch fails (network, 404, 401) → propagate with clear message.
- PK response shape invalid → fail with schema error.

### Decision 4: `secrets` plugin replaces `env-installer`

The `env-installer` plugin from the prior change SHALL be retired. Its role is subsumed into a new `secrets` plugin in `packages/runtime/src/plugins/secrets.ts`. The `secrets` plugin:

1. **Guest source (Phase 2):** Installs `globalThis.workflow = { name, env: envObject }` and `globalThis.$secrets = { addSecret(v) { ... } }` via `installGuestGlobals`. Registers guest functions `$secrets/populate(name, envStrings, plaintextStore)` and `$secrets/clear()`. The `addSecret` guest call dispatches to a registered host function that mutates the plaintext set worker-side.

2. **Worker-side `onBeforeRunStarted(ctx)`:** Takes `ctx.plaintextStore` (per-invocation decrypted secrets from the executor), stashes a `plaintextsSet = new Set(Object.values(plaintextStore))` in plugin closure for the scrubber. Host→guest calls `$secrets/populate(ctx.workflow, ctx.envStrings, ctx.plaintextStore)`.

3. **Guest-side `$secrets/populate(name, envStrings, plaintextStore)`:** Clears `envObject`, assigns `name`, assigns each `envStrings[k]` to `envObject[k]`, assigns each `plaintextStore[k]` to `envObject[k]` (secrets mixed with env in the same record — by design, authors don't see a distinction).

4. **Worker-side `onPost(msg)`:** Walks `msg` for string leaves, applies longest-first literal replacement: for each plaintext in `plaintextsSet` (sorted by descending length at cache build time), `replaceAll(plaintext, "[secret]")`. Returns the (possibly transformed) message.

5. **Worker-side `onRunFinished()`:** Host→guest `$secrets/clear()`; also clears `plaintextsSet`.

6. **Worker-side `addSecret` host function (invoked when guest calls `globalThis.$secrets.addSecret(v)`):** Adds `v` to the plaintext set and re-sorts (longest-first). The scrubber now redacts that literal on subsequent `onPost` invocations.

`envStrings` and `plaintextStore` are delivered on the `run` message's ctx. No new message types; the prior changes already route these fields.

### Decision 5: scrubber is literal-only, longest-first, unbounded min length

The scrubber's replace loop iterates `plaintextsSet` in descending-length order to avoid partial-overlap corruption (e.g., with plaintexts `["alpha", "alphabet"]`, replacing "alpha" first would break "alphabet" matching). No minimum length is enforced — a 2-byte secret will redact legitimate "ok" strings in archive events, and that's an author decision.

Any occurrence of any literal plaintext in any string leaf of any outbound message is replaced with `[secret]`. Derivatives (base64, hex, slice, hash, reverse) are not covered; `secret(derivedValue)` is the documented escape hatch.

### Decision 6: `addSecret` is a global + host-round-trip

The guest-side `globalThis.$secrets.addSecret(value)` invokes a plugin-registered guest function that dispatches to a host handler adding the value to the plugin's worker-side plaintext set.

**Why not keep the set guest-side?** The scrubber runs on worker-thread `post()` — it needs the set worker-side. Guest-side mirror would add complexity without gain.

### Decision 7: `manifest.secrets` keys are disjoint from `manifest.env` keys

The Vite plugin routes each declared env binding exclusively into one map — either `env` (plaintext) or `secretBindings` (sealed). The CLI's rewrite preserves that invariant: `secrets` keys never appear in `env`. The runtime's `secrets` plugin can safely merge them into a single `workflow.env` record without collision.

`ManifestSchema` enforces disjoint key sets (already specified in the prior change).

## Risks / Trade-offs

- **[Risk] Author logs a derived form of a secret (e.g., `console.log(btoa(env.TOKEN))`).** → Scrubber misses; plaintext-derived value reaches archive. Mitigation: documented as a known limitation; `secret(derivedValue)` escape hatch. Same failure class as GitHub Actions' log masker.
- **[Risk] Short plaintext like "ok" causes broad over-redaction.** → Accepted as author responsibility; no minimum length.
- **[Risk] Scrubber performance at high event rates.** → Each outbound message walks all string leaves against N plaintexts. For small N (<20 per invocation typical) and short messages, negligible. If it becomes a hotspot, consider an Aho-Corasick multi-pattern matcher.
- **[Risk] CLI fetches PK over untrusted network without pinning.** → Standard TLS protects the channel; PK leakage is not a confidentiality concern (public by definition). Integrity is protected by TLS. No additional pinning needed.
- **[Risk] `process.env[envName]` at CLI time is undefined (author forgot to set it).** → Upload fails fast with clear error naming the missing var. No partial seal.
- **[Risk] Time-of-check vs time-of-use on `manifest.secretBindings`.** → An attacker with local filesystem access could tamper with the build-artifact manifest to add secrets after build. Mitigation: plaintext never lands on disk; tampering with `secretBindings` only affects which envs the CLI attempts to read from — the CLI's own `process.env` controls what gets sealed. No elevation.
- **[Risk] `secret()` called with data that later becomes unusable once the run ends.** → `addSecret` registers a value; the set is cleared on `onRunFinished`. Between runs the set is empty, so post-run code paths (shouldn't exist) would not benefit from redaction. Acceptable.
- **[Trade-off] Retiring `env-installer` the same change it was introduced.** → Previous change's integration is wasted work. Alternative: skip `env-installer` in the prior change and land the full `secrets` plugin here. Rejected because the prior change's scope wanted a user-visible deliverable (env gap fix), and `env-installer` was the minimal consumer.

## Migration Plan

1. Merge core type updates (`RuntimeSecrets.addSecret` now has a consumer).
2. Merge SDK type additions (`SecretEnvRef`, `env({secret:true})` overload, `secret()` factory).
3. Merge Vite plugin routing (secret bindings → `manifest.secretBindings`).
4. Merge CLI rewrite flow.
5. Merge runtime `secrets` plugin; update sandbox composition to use it in place of `env-installer`.
6. Deploy runtime. Server now accepts sealed bundles.
7. Update docs. Tenants adopting secrets bump SDK, rebuild, re-upload.

Rollback strategy: revert the runtime composition step first (so existing non-secret bundles still run on the `env-installer`), then optionally revert the CLI, SDK, and Vite plugin changes. Tenants with bundles already sealed against the primary key would need the runtime rolled back OR need to re-upload without secrets.

## Open Questions

- **Deprecation path for `env-installer` plugin file?** → Delete it outright. The prior change's tests referencing it migrate to the new `secrets` plugin. No external consumer.
- **Should `addSecret` also redact from in-flight `console.log` events that occurred before registration?** → No; redaction operates on outbound messages. A `console.log(x)` that emits an event before `secret(x)` registers will archive the plaintext. Document.
- **Any value in exposing secret count in audit?** → Out of scope. Revisit if operators ask for it.
