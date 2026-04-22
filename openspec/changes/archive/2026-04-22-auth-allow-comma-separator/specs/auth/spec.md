## MODIFIED Requirements

### Requirement: AUTH_ALLOW grammar

The runtime SHALL accept an `AUTH_ALLOW` environment variable with the grammar:

```
AUTH_ALLOW = Entry ( "," Entry )*
Entry      = Provider ":" Kind ":" Id
Provider   = "github"
Kind       = "user" | "org"
Id         = [A-Za-z0-9][-A-Za-z0-9]*
```

Whitespace around entries SHALL be trimmed. Empty entries (`",,"`) SHALL be ignored. Tokens whose `Provider` is not `github`, or whose `Kind` is not `user` or `org`, or whose `Id` does not match the identifier regex, SHALL cause `createConfig` to throw a validation error at startup; the runtime SHALL fail to start.

#### Scenario: Mixed user and org entries

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:alice,github:org:acme,github:user:bob"`
- **THEN** the parsed allowlist SHALL contain `users = { "alice", "bob" }` and `orgs = { "acme" }`

#### Scenario: Unknown provider fails startup

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "google:user:alice"`
- **THEN** `createConfig` SHALL throw a validation error identifying the unknown provider

#### Scenario: Unknown kind fails startup

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:team:acme/eng"`
- **THEN** `createConfig` SHALL throw a validation error identifying the unknown kind

#### Scenario: Invalid identifier fails startup

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:has spaces"`
- **THEN** `createConfig` SHALL throw a validation error identifying the invalid identifier

#### Scenario: Whitespace around entries is trimmed

- **WHEN** `createConfig` is called with `AUTH_ALLOW = " github:user:alice ,  github:org:acme "`
- **THEN** the parsed allowlist SHALL contain `users = { "alice" }` and `orgs = { "acme" }`

### Requirement: AUTH_ALLOW mode resolution

The config schema SHALL expose `auth` as a discriminated union:

```
auth:
  | { mode: "disabled" }
  | { mode: "open" }
  | { mode: "restricted"; users: Set<string>; orgs: Set<string> }
```

Resolution rules:
- `AUTH_ALLOW` is unset (undefined) or an empty string → `auth = { mode: "disabled" }`.
- `AUTH_ALLOW` equals the sentinel string `__DISABLE_AUTH__` → `auth = { mode: "open" }`.
- Any other parseable value → `auth = { mode: "restricted", users, orgs }`.

The sentinel `__DISABLE_AUTH__` SHALL be valid only when it is the entire value of `AUTH_ALLOW`. If it appears as a comma-separated segment alongside other entries, config parsing SHALL fail with a validation error.

#### Scenario: AUTH_ALLOW unset produces disabled mode

- **WHEN** `createConfig` is called without `AUTH_ALLOW`
- **THEN** the config SHALL contain `auth: { mode: "disabled" }`

#### Scenario: Sentinel produces open mode

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "__DISABLE_AUTH__"`
- **THEN** the config SHALL contain `auth: { mode: "open" }`

#### Scenario: Parseable value produces restricted mode

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:alice,github:org:acme"`
- **THEN** the config SHALL contain `auth: { mode: "restricted", users: Set(["alice"]), orgs: Set(["acme"]) }`

#### Scenario: Sentinel mixed with entries fails startup

- **WHEN** `createConfig` is called with `AUTH_ALLOW = "github:user:alice,__DISABLE_AUTH__"`
- **THEN** `createConfig` SHALL throw a validation error indicating the sentinel must be the only value
