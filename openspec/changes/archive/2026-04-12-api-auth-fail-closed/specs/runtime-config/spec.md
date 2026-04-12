## MODIFIED Requirements

### Requirement: GITHUB_USER config variable

The config schema SHALL accept an optional `GITHUB_USER` environment variable and expose its result as a discriminated union `githubAuth`:

```
githubAuth:
  | { mode: 'disabled' }
  | { mode: 'open' }
  | { mode: 'restricted'; users: string[] }
```

Resolution rules:

- `GITHUB_USER` is unset (undefined) → `githubAuth = { mode: 'disabled' }`.
- `GITHUB_USER` equals the sentinel string `__DISABLE_AUTH__` → `githubAuth = { mode: 'open' }`.
- Any other value → `githubAuth = { mode: 'restricted', users: <parsed list> }`.

The list SHALL be parsed by splitting the raw value on `,`. No whitespace trimming SHALL be performed and empty segments SHALL be preserved, mirroring the behavior of oauth2-proxy's pflag `StringSlice` parsing of `OAUTH2_PROXY_GITHUB_USERS`.

The sentinel `__DISABLE_AUTH__` SHALL be valid only when it is the entire value of `GITHUB_USER`. If it appears as a comma-separated segment alongside other values, config parsing SHALL fail with a validation error.

#### Scenario: GITHUB_USER is not set

- **WHEN** `createConfig` is called without `GITHUB_USER`
- **THEN** the config SHALL contain `githubAuth: { mode: "disabled" }`

#### Scenario: GITHUB_USER is a single username

- **WHEN** `createConfig` is called with `{ GITHUB_USER: "stefanhoelzl" }`
- **THEN** the config SHALL contain `githubAuth: { mode: "restricted", users: ["stefanhoelzl"] }`

#### Scenario: GITHUB_USER is a comma-separated list

- **WHEN** `createConfig` is called with `{ GITHUB_USER: "alice,bob" }`
- **THEN** the config SHALL contain `githubAuth: { mode: "restricted", users: ["alice", "bob"] }`

#### Scenario: GITHUB_USER preserves whitespace and empty segments

- **WHEN** `createConfig` is called with `{ GITHUB_USER: "alice, bob,," }`
- **THEN** the config SHALL contain `githubAuth: { mode: "restricted", users: ["alice", " bob", "", ""] }`

#### Scenario: GITHUB_USER is the sentinel

- **WHEN** `createConfig` is called with `{ GITHUB_USER: "__DISABLE_AUTH__" }`
- **THEN** the config SHALL contain `githubAuth: { mode: "open" }`

#### Scenario: GITHUB_USER mixes sentinel with usernames

- **WHEN** `createConfig` is called with `{ GITHUB_USER: "alice,__DISABLE_AUTH__" }`
- **THEN** `createConfig` SHALL throw a validation error indicating the sentinel must be the only value
