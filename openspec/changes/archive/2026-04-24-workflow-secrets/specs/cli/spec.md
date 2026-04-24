## ADDED Requirements

### Requirement: CLI seals and uploads workflows with secret bindings

The `wfe upload --tenant <name>` CLI SHALL detect `manifest.secretBindings` on any workflow in the bundle. When any workflow has non-empty `secretBindings`, the CLI SHALL:

1. Call `GET <url>/api/workflows/<tenant>/public-key` once (with existing auth). Validate the response shape `{ algorithm: "x25519", publicKey: <b64>, keyId: <hex> }`.
2. Base64-decode `publicKey` to a 32-byte X25519 pk.
3. For each workflow with `secretBindings`, for each envName in the list:
   a. Read `process.env[envName]`. If undefined, fail with error: `"Missing env var for secret binding: <envName>"`.
   b. Compute `ct = crypto_box_seal(plaintext, pk)` and base64-encode.
   c. Assign `manifest.secrets[envName] = <b64 ct>`.
4. Set `manifest.secretsKeyId = response.keyId` for each workflow whose secrets were just sealed.
5. Delete the `secretBindings` field from each manifest.
6. Repack the tarball with the rewritten manifests (preserving all other bundle files unchanged).
7. POST the rewritten bundle to `<url>/api/workflows/<tenant>` as before.

The CLI SHALL NOT write the rewritten manifest or any plaintext to disk. All processing SHALL be in-memory.

If `secretBindings` is absent or empty on every workflow, the CLI SHALL upload the bundle unchanged without fetching the public key.

#### Scenario: Bundle with secret bindings is sealed and uploaded

- **GIVEN** a bundle whose manifest has `secretBindings: ["TOKEN"]` and `process.env.TOKEN = "ghp_xxx"`
- **WHEN** `wfe upload --tenant acme` runs
- **THEN** the CLI SHALL fetch `https://.../api/workflows/acme/public-key`
- **AND** SHALL seal `"ghp_xxx"` against the returned pk
- **AND** SHALL POST a bundle whose manifest has `secrets: { TOKEN: <base64 ciphertext> }` and `secretsKeyId: <hex>`
- **AND** SHALL NOT include `secretBindings` in the POSTed manifest
- **AND** the response SHALL be 204

#### Scenario: Missing env var fails upload

- **GIVEN** a bundle with `secretBindings: ["TOKEN"]` and `process.env.TOKEN` is unset
- **WHEN** `wfe upload` runs
- **THEN** upload SHALL fail with error `"Missing env var for secret binding: TOKEN"`
- **AND** no network POST SHALL be made

#### Scenario: Bundle without secret bindings skips PK fetch

- **GIVEN** a bundle whose manifests have no `secretBindings` or only empty arrays
- **WHEN** `wfe upload` runs
- **THEN** the CLI SHALL NOT call the public-key endpoint
- **AND** the bundle SHALL be POSTed unchanged

#### Scenario: Public-key fetch failure aborts upload

- **GIVEN** a bundle with secret bindings
- **WHEN** the public-key fetch returns 401 or 404 or the connection fails
- **THEN** upload SHALL fail with a descriptive error
- **AND** no bundle SHALL be POSTed

#### Scenario: Plaintext is not written to disk

- **GIVEN** a bundle with secret bindings and a valid `process.env`
- **WHEN** the CLI rewrites the manifest
- **THEN** no filesystem write in or around `dist/` SHALL contain the plaintext or rewritten manifest
- **AND** the only disk interaction SHALL be reading the original bundle

#### Scenario: keyId matches server response

- **GIVEN** a bundle successfully sealed
- **WHEN** the POSTed manifest is inspected
- **THEN** `manifest.secretsKeyId` SHALL equal the `keyId` field from the public-key endpoint response
