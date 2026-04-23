## ADDED Requirements

### Requirement: LOCAL_DEPLOYMENT enables the local auth provider factory

The runtime SHALL read `process.env.LOCAL_DEPLOYMENT` and treat the value `"1"` as a hard gate for registering the `localProviderFactory` in the auth-provider list.

When `LOCAL_DEPLOYMENT === "1"`, both `githubProviderFactory` and `localProviderFactory` SHALL be available to the registry build.

When `LOCAL_DEPLOYMENT` is unset, set to the empty string, or set to any value other than the literal `"1"`, only `githubProviderFactory` SHALL be available. Any `local:*` entry in `AUTH_ALLOW` SHALL cause `createConfig` to fail with `unknown provider "local"` — the same error class as a typo, with no special-case treatment.

`LOCAL_DEPLOYMENT` SHALL also continue to gate the HSTS exemption in `secure-headers.ts` (existing behavior, unchanged).

#### Scenario: LOCAL_DEPLOYMENT=1 makes local provider available

- **GIVEN** `LOCAL_DEPLOYMENT=1`
- **WHEN** `createConfig` is called with `AUTH_ALLOW = "local:dev"`
- **THEN** the runtime SHALL start successfully
- **AND** the registry SHALL contain a provider with id `"local"`

#### Scenario: LOCAL_DEPLOYMENT unset rejects local entries

- **GIVEN** `LOCAL_DEPLOYMENT` is unset
- **WHEN** `createConfig` is called with `AUTH_ALLOW = "local:dev"`
- **THEN** `createConfig` SHALL throw `unknown provider "local"`

#### Scenario: LOCAL_DEPLOYMENT=0 rejects local entries

- **GIVEN** `LOCAL_DEPLOYMENT="0"`
- **WHEN** `createConfig` is called with `AUTH_ALLOW = "local:dev"`
- **THEN** `createConfig` SHALL throw `unknown provider "local"`

#### Scenario: LOCAL_DEPLOYMENT=1 alone does not register a provider

- **GIVEN** `LOCAL_DEPLOYMENT=1` and `AUTH_ALLOW` unset
- **WHEN** `createConfig` is called
- **THEN** the runtime SHALL start successfully with an empty registry
- **AND** the local provider SHALL NOT be registered (factory available, but no entries to bucket)

## MODIFIED Requirements

### Requirement: AUTH_ALLOW config variable

The config schema SHALL accept an optional `AUTH_ALLOW` environment variable and expose its parsed result as a provider registry, not a discriminated mode union.

The value SHALL be parsed per the grammar defined in the `auth` capability's `AUTH_ALLOW grammar` requirement:
- Top-level entries SHALL be separated by `,`.
- Each entry SHALL be split on its first `:` only, yielding `(ProviderId, ProviderRest)`.
- `ProviderRest` SHALL be dispatched to the registered provider's `factory.create` method.
- `ProviderId` values not matching any registered factory SHALL cause `createConfig` to throw `unknown provider "<id>"`.

There SHALL NOT be a sentinel value for "auth disabled". Empty/unset `AUTH_ALLOW` SHALL yield an empty provider registry; the runtime SHALL start successfully but the login page SHALL render with no provider sections, and every protected route SHALL respond `401`/`302` because no provider can resolve identity.

The `__DISABLE_AUTH__` sentinel SHALL NOT be recognized — operators upgrading from a prior runtime version SHALL replace it with one or more `local:<name>` entries plus `LOCAL_DEPLOYMENT=1` (dev only) or with `github:*` entries (prod).

`AUTH_ALLOW` SHALL be returned as a plain (non-secret) config field. Allowlist contents are visible in pod specs and Kubernetes events for auditability.

#### Scenario: AUTH_ALLOW unset yields empty registry

- **WHEN** `createConfig` is called without `AUTH_ALLOW`
- **THEN** the runtime SHALL start successfully
- **AND** the resulting auth registry SHALL contain zero providers

#### Scenario: github entries register the github provider

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:alice,github:org:acme"`
- **THEN** the registry SHALL contain a provider with id `"github"` whose internal entries represent users `{"alice"}` and orgs `{"acme"}`

#### Scenario: __DISABLE_AUTH__ is no longer recognized

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "__DISABLE_AUTH__"`
- **THEN** `createConfig` SHALL throw — `__DISABLE_AUTH__` is no longer a valid `ProviderId` and SHALL produce `unknown provider "__DISABLE_AUTH__"` (or the equivalent grammar error if the dispatcher interprets it as a malformed entry)

#### Scenario: Mixed providers register independently

- **GIVEN** `LOCAL_DEPLOYMENT="1"`
- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:alice,local:dev"`
- **THEN** the registry SHALL contain providers with ids `"github"` and `"local"`

#### Scenario: Unknown provider fails startup

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "google:user:alice"`
- **THEN** `createConfig` SHALL throw `unknown provider "google"`
