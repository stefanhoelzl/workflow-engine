## ADDED Requirements

### Requirement: Core package exports the secrets-crypto subpath

The `@workflow-engine/core` package SHALL expose a `./secrets-crypto` subpath (analogous to the existing `./test-utils` subpath) that owns the cryptographic seal/unseal primitives for workflow secrets. The subpath SHALL export exactly the following:

- `sealCiphertext(plaintext: string, publicKey: Uint8Array): Uint8Array` — pure function that returns the raw ciphertext bytes from an X25519 sealed-box encryption of the UTF-8 plaintext. The caller is responsible for any subsequent base64 encoding.
- `unsealCiphertext(ciphertext: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array` — pure function that returns the plaintext bytes from an X25519 sealed-box decryption. Throws a descriptive error if decryption fails.
- `awaitCryptoReady(): Promise<void>` — initialises the underlying crypto backend. Callers SHALL await this once before invoking `sealCiphertext` or `unsealCiphertext`. The export name SHALL NOT mention any specific crypto library; the backing implementation is an internal detail of `core`.

The subpath SHALL be the single home of `crypto_box_seal` / `crypto_box_seal_open` invocations across the monorepo. The CLI's manifest-sealing codepath and the runtime's keystore-decryption codepath SHALL both import these primitives from this subpath; neither SHALL re-implement them or call libsodium directly. Higher-level concerns — manifest walking, base64 wrapping, env-var lookup, multi-key keystore resolution, fingerprint derivation — remain owned by their respective callers (`packages/sdk/src/cli/` for sealing, `packages/runtime/src/secrets/` for unsealing). Only the libsodium-touching primitives move to `core`.

`packages/core/package.json`'s `exports` field SHALL list `./secrets-crypto`. The implementation SHALL live in sibling files under `packages/core/src/secrets/` and SHALL NOT be re-exported from `packages/core/src/index.ts`. Re-exporting from the main entry would pull libsodium into the sandbox-plugin esbuild bundle, which is a non-goal.

#### Scenario: Subpath exports the seal/unseal primitives

- **WHEN** importing `import { sealCiphertext, unsealCiphertext, awaitCryptoReady } from "@workflow-engine/core/secrets-crypto"`
- **THEN** all three symbols SHALL be defined with the documented signatures

#### Scenario: Subpath does not leak the backing crypto library name

- **WHEN** inspecting the public exports of `@workflow-engine/core/secrets-crypto`
- **THEN** no exported symbol's name SHALL contain `sodium`, `libsodium`, `nacl`, or any other crypto-library identifier

#### Scenario: Main entry does not pull libsodium

- **WHEN** building the sandbox bundle (`?sandbox-plugin` esbuild path) which resolves `@workflow-engine/core` to `index.ts`
- **THEN** the bundled output SHALL NOT contain `libsodium-wrappers` source or any reference to `crypto_box_seal`
- **AND** running `grep -r "crypto_box" packages/core/src/index.ts` SHALL return no matches

#### Scenario: Seal and unseal round-trip through the subpath

- **GIVEN** an X25519 keypair `(pk, sk)` and a plaintext string `"ghp_xxx"`
- **WHEN** `unsealCiphertext(sealCiphertext("ghp_xxx", pk), pk, sk)` is called
- **THEN** the returned bytes SHALL UTF-8-decode to `"ghp_xxx"`

#### Scenario: Single libsodium consumer in the monorepo

- **WHEN** grepping the monorepo for `import.*libsodium-wrappers`
- **THEN** the only matches SHALL be inside `packages/core/src/secrets/`

## MODIFIED Requirements

### Requirement: Core package has minimal dependencies

The `@workflow-engine/core` package SHALL depend on `zod` (runtime), `ajv` (runtime, for JSON Schema validation inside `ManifestSchema`), and `libsodium-wrappers` (runtime, scoped to `secrets-crypto` and not transitively pulled into the sandbox bundle from the main entry). It SHALL NOT depend on vite, typescript, or any build tooling.

#### Scenario: Core dependency list

- **WHEN** inspecting `packages/core/package.json` dependencies
- **THEN** it lists exactly `zod`, `ajv`, and `libsodium-wrappers`
- **AND** it has no devDependencies related to build tooling

#### Scenario: SDK and runtime no longer depend on libsodium directly

- **WHEN** inspecting `packages/sdk/package.json` and `packages/runtime/package.json`
- **THEN** neither lists `libsodium-wrappers` in `dependencies` or `peerDependencies`
- **AND** any libsodium use in those packages SHALL be via `@workflow-engine/core/secrets-crypto`

### Requirement: Core package is ESM

The `@workflow-engine/core` package SHALL use ES modules (`"type": "module"`) and export three entry points via the `exports` field: the main `"."` entry, a `"./test-utils"` subpath for test-only helpers, and a `"./secrets-crypto"` subpath for seal/unseal primitives.

#### Scenario: Core exports field

- **WHEN** inspecting `packages/core/package.json`
- **THEN** it has `"type": "module"`
- **AND** its `exports` field defines `"."`, `"./test-utils"`, and `"./secrets-crypto"`
