## ADDED Requirements

### Requirement: SECRETS_PRIVATE_KEYS config field

The runtime config SHALL expose a required `SECRETS_PRIVATE_KEYS` field populated from the env var of the same name. The value SHALL be parsed as a comma-separated list of `keyId:base64(sk)` entries where each `sk` decodes to exactly 32 bytes. The parsed form SHALL be wrapped via `createSecret()` so that the config object never exposes the raw bytes when serialized, stringified, or logged.

The runtime SHALL fail startup (via `createConfig` throw) if the env var is missing, empty, malformed, contains any entry with the wrong secret-key length, or has no entries. The primary (active sealing) key SHALL be the first entry in the list.

#### Scenario: Valid env var parses into config

- **GIVEN** `SECRETS_PRIVATE_KEYS="k1:<valid-b64-32>"`
- **WHEN** `createConfig(env)` is called
- **THEN** `config.SECRETS_PRIVATE_KEYS` SHALL be a `Secret` wrapping the parsed value
- **AND** `config.SECRETS_PRIVATE_KEYS.reveal()` SHALL yield the internal parsed representation

#### Scenario: Missing env var fails startup

- **GIVEN** no `SECRETS_PRIVATE_KEYS` is set
- **WHEN** `createConfig(env)` is called
- **THEN** it SHALL throw an error identifying the missing field

#### Scenario: Malformed entry fails startup

- **GIVEN** `SECRETS_PRIVATE_KEYS="bad-entry-no-colon"`
- **WHEN** `createConfig(env)` is called
- **THEN** it SHALL throw an error naming the malformed entry

#### Scenario: Wrong secret-key length fails startup

- **GIVEN** `SECRETS_PRIVATE_KEYS="k1:<b64-of-16-bytes>"`
- **WHEN** `createConfig(env)` is called
- **THEN** it SHALL throw with an error referencing the invalid secret-key length

#### Scenario: Config field is redacted when serialized

- **GIVEN** a valid config
- **WHEN** `JSON.stringify(config)` or `console.log(config.SECRETS_PRIVATE_KEYS)` is invoked
- **THEN** the output SHALL contain `"[redacted]"` where the secret value would be
- **AND** SHALL NOT contain any plaintext byte from any secret key
