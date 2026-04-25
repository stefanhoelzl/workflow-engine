## MODIFIED Requirements

### Requirement: Build pipeline

The CLI SHALL build workflows using a pure `buildWorkflows(cwd)` core module exported from `@workflow-engine/sdk/cli` (or equivalent internal path). The core SHALL return an in-memory pair `{ files: Map<name, bytes>, manifest: UnsealedManifest }` where `manifest` matches today's `{ workflows: [...] }` shape and carries `secretBindings` for each workflow that declared `env({secret:true})`.

`buildWorkflows` SHALL be the single implementation of workflow discovery, env resolution, trigger collection, and per-workflow JS production used by every code path that needs workflow JS or manifest data. It SHALL invoke Vite/Rolldown via the programmatic API with a private internal-only emit-to-memory plugin; nothing else SHALL re-implement these concerns.

The CLI SHALL NOT support a user-authored `vite.config.ts`; any such file in `cwd` SHALL be ignored. The previously-public `@workflow-engine/sdk/plugin` export and its `packages/sdk/src/plugin/` directory SHALL be deleted.

#### Scenario: Single build implementation shared across entry points

- **WHEN** inspecting the CLI source
- **THEN** the `wfe build` subcommand and the internal `bundle` function SHALL both invoke the same exported `buildWorkflows` function
- **AND** there SHALL be no duplicate implementations of workflow discovery

#### Scenario: Public Vite plugin is removed

- **WHEN** inspecting the SDK package
- **THEN** `packages/sdk/src/plugin/` SHALL NOT exist
- **AND** `packages/sdk/package.json`'s `exports` SHALL NOT contain a `./plugin` subpath
- **AND** the only consumer of the in-memory build implementation SHALL be `buildWorkflows`

#### Scenario: User vite.config.ts is ignored

- **WHEN** the CLI runs in a directory containing a user-authored `vite.config.ts`
- **THEN** the CLI SHALL use its bundled internal vite/rolldown configuration regardless

### Requirement: Build-only subcommand

The `wfe` binary SHALL expose a `build` subcommand that invokes `buildWorkflows(cwd)` and writes only the per-workflow `<name>.js` files to `<cwd>/dist/`. It SHALL NOT write `<cwd>/dist/manifest.json`, SHALL NOT pack `<cwd>/dist/bundle.tar.gz`, and SHALL NOT perform any network I/O, authentication, or target-URL resolution.

The `build` subcommand SHALL fail fast when a workflow declares an env binding (plaintext or `secret: true`) whose resolved value is absent: stderr SHALL include `Missing environment variable: <name>` and the command SHALL exit with status `1`. No JS file SHALL be written to `<cwd>/dist/` in that case.

The `build` subcommand SHALL NOT accept `--url`, `--owner`, `--tenant`, `--user`, `--token`, or read `GITHUB_TOKEN`. Passing any authentication-related flag or environment variable SHALL have no effect on its behaviour.

#### Scenario: Build subcommand writes only JS files to dist

- **WHEN** `wfe build` is invoked in a directory containing `src/foo.ts` and `src/bar.ts`
- **THEN** `<cwd>/dist/foo.js` and `<cwd>/dist/bar.js` SHALL exist
- **AND** `<cwd>/dist/manifest.json` SHALL NOT exist
- **AND** `<cwd>/dist/bundle.tar.gz` SHALL NOT exist
- **AND** the command SHALL exit with status `0`
- **AND** SHALL NOT issue any HTTP request

#### Scenario: Build subcommand performs no authentication

- **GIVEN** `GITHUB_TOKEN=ghp_xxx` is set in the environment
- **WHEN** `wfe build` is invoked
- **THEN** no HTTP request SHALL be issued (the token is ignored by design)

#### Scenario: Build fails fast on missing plaintext env var

- **GIVEN** a workflow declares `env({name: "API_URL"})` with no default
- **AND** `process.env.API_URL` is unset
- **WHEN** `wfe build` is invoked
- **THEN** stderr SHALL include `Missing environment variable: API_URL`
- **AND** the command SHALL exit with status `1`

#### Scenario: Build fails fast on missing secret env var

- **GIVEN** a workflow declares `env({name: "TOKEN", secret: true})`
- **AND** `process.env.TOKEN` is unset
- **WHEN** `wfe build` is invoked
- **THEN** stderr SHALL include `Missing environment variable: TOKEN`
- **AND** the command SHALL exit with status `1`

#### Scenario: Build subcommand fails on missing workflows

- **WHEN** `wfe build` is invoked in a directory where `src/` does not exist or contains no top-level `.ts` files
- **THEN** the CLI SHALL exit with status `1`
- **AND** stderr SHALL include `no workflows found in src/`

### Requirement: CLI seals and uploads workflows with secret bindings

The `wfe upload` CLI SHALL seal and POST workflows in a single in-memory pipeline routed through an internal `bundle({cwd, url, owner, user?, token?}) → Promise<Uint8Array>` function. The pipeline SHALL:

1. Call `buildWorkflows(cwd)` to obtain `{ files, manifest }` in memory.
2. If any workflow in `manifest.workflows` has non-empty `secretBindings`:
   - Call `GET <url>/api/workflows/<owner>/public-key` once (with the resolved auth headers). Validate the response shape `{ algorithm: "x25519", publicKey: <b64>, keyId: <hex> }`.
   - For each binding on each affected workflow, read `process.env[name]`, call `sealCiphertext(plaintext, pubkey)` from `@workflow-engine/core/secrets-crypto`, base64-encode the returned bytes into `manifest.workflows[i].secrets[name]`, set `manifest.workflows[i].secretsKeyId = keyId`, and remove the `secretBindings` field. The CLI SHALL NOT call `crypto_box_seal` directly; only `sealCiphertext` from core.
3. Pack a single tenant tarball in-memory containing `manifest.json` (sealed) at the root plus one `<name>.js` per workflow at the root, from the `files` map.
4. Return the tarball bytes.

The CLI SHALL NOT contain its own `crypto_box_seal` invocation; all sealing SHALL go through `sealCiphertext` from `@workflow-engine/core/secrets-crypto`. The CLI SHALL NOT depend directly on `libsodium-wrappers`. `packages/sdk/package.json`'s `dependencies` SHALL NOT list `libsodium-wrappers`.

`wfe upload` SHALL then POST the returned bytes to `<url>/api/workflows/<owner>` with `Content-Type: application/gzip` and the resolved auth headers, as before.

The pipeline SHALL NOT write the built JS files, unsealed manifest, sealed manifest, or tarball to disk. All processing between `buildWorkflows` and the HTTP POST SHALL be in-memory.

If no workflow has a non-empty `secretBindings`, the CLI SHALL pack and POST the tarball without fetching the public key.

#### Scenario: Sealing routes through core

- **WHEN** `wfe upload` runs against a bundle with secret bindings
- **THEN** the only `crypto_box_seal` invocation SHALL be inside `@workflow-engine/core/secrets-crypto`
- **AND** `packages/sdk/` SHALL NOT contain a direct call to any libsodium API

#### Scenario: SDK package does not depend on libsodium directly

- **WHEN** inspecting `packages/sdk/package.json`
- **THEN** the `dependencies` SHALL NOT list `libsodium-wrappers` or any other libsodium binding

#### Scenario: Bundle with secret bindings is sealed and uploaded

- **GIVEN** a workflow declaring `env({name: "TOKEN", secret: true})` and `process.env.TOKEN = "ghp_xxx"`
- **WHEN** `wfe upload --owner acme --url https://example` runs
- **THEN** the CLI SHALL fetch `https://example/api/workflows/acme/public-key`
- **AND** SHALL seal `"ghp_xxx"` against the returned pk via `sealCiphertext` from core
- **AND** SHALL POST a bundle whose workflow manifest has `secrets: { TOKEN: <base64 ciphertext> }` and `secretsKeyId: <hex>`
- **AND** SHALL NOT include `secretBindings` in the POSTed manifest
- **AND** the response SHALL be 204

#### Scenario: Missing secret env var fails upload at build phase

- **GIVEN** a workflow declares `env({name: "TOKEN", secret: true})` and `process.env.TOKEN` is unset
- **WHEN** `wfe upload` runs
- **THEN** `buildWorkflows` SHALL fail with `Missing environment variable: TOKEN`
- **AND** no public-key fetch SHALL be issued
- **AND** no network POST SHALL be made

#### Scenario: Bundle without secret bindings skips PK fetch

- **GIVEN** a workflow with no `env({secret:true})` declarations
- **WHEN** `wfe upload` runs
- **THEN** the CLI SHALL NOT call the public-key endpoint
- **AND** the tarball SHALL be POSTed without a `secrets` or `secretsKeyId` field in any workflow manifest

#### Scenario: Public-key fetch failure aborts upload

- **GIVEN** a workflow with secret bindings
- **WHEN** the public-key fetch returns 401 or 404 or the connection fails
- **THEN** upload SHALL fail with a descriptive error
- **AND** no bundle SHALL be POSTed

#### Scenario: Plaintext and tarball are not written to disk

- **GIVEN** a workflow with secret bindings and a valid `process.env`
- **WHEN** `wfe upload` runs
- **THEN** no filesystem write in or around `dist/` SHALL contain plaintext secret values
- **AND** no `dist/bundle.tar.gz` SHALL be produced on the upload path
- **AND** no `dist/manifest.json` SHALL be produced on the upload path

#### Scenario: keyId matches server response

- **GIVEN** a bundle successfully sealed
- **WHEN** the POSTed manifest is inspected
- **THEN** each sealed workflow manifest's `secretsKeyId` SHALL equal the `keyId` field from the public-key endpoint response
