## ADDED Requirements

### Requirement: AUTH_ALLOW config variable

The config schema SHALL accept an optional `AUTH_ALLOW` environment variable and expose its parsed result as a discriminated union `auth`:

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

The value SHALL be parsed per the grammar and validation rules defined in the `auth` capability's "AUTH_ALLOW grammar" requirement. Unparseable values (unknown provider, unknown kind, invalid identifier, malformed structure) SHALL cause `createConfig` to throw a validation error at startup; the runtime SHALL fail to start with a diagnostic that identifies the first offending token.

The sentinel `__DISABLE_AUTH__` SHALL be valid only when it is the entire value of `AUTH_ALLOW`. If it appears as a semicolon-separated segment alongside other entries, `createConfig` SHALL throw a validation error indicating the sentinel must be the only value.

`AUTH_ALLOW` SHALL be returned as a plain (non-secret) config field. Allowlist contents are visible in pod specs and Kubernetes events for auditability.

#### Scenario: AUTH_ALLOW unset produces disabled mode

- **WHEN** `createConfig` is called without `AUTH_ALLOW`
- **THEN** the config SHALL contain `auth: { mode: "disabled" }`

#### Scenario: Sentinel produces open mode

- **WHEN** `createConfig` is called with `{ AUTH_ALLOW: "__DISABLE_AUTH__" }`
- **THEN** the config SHALL contain `auth: { mode: "open" }`

#### Scenario: Parseable list produces restricted mode

- **WHEN** `createConfig` is called with `{ AUTH_ALLOW: "github:user:alice;github:org:acme" }`
- **THEN** the config SHALL contain `auth: { mode: "restricted", users: Set(["alice"]), orgs: Set(["acme"]) }`

#### Scenario: Unknown provider fails startup

- **WHEN** `createConfig` is called with `{ AUTH_ALLOW: "google:user:alice" }`
- **THEN** `createConfig` SHALL throw a validation error identifying `google` as an unknown provider

#### Scenario: Sentinel mixed with entries fails startup

- **WHEN** `createConfig` is called with `{ AUTH_ALLOW: "github:user:alice;__DISABLE_AUTH__" }`
- **THEN** `createConfig` SHALL throw a validation error indicating the sentinel must be the only value

### Requirement: GitHub OAuth App credentials

The config schema SHALL accept two environment variables that provide the GitHub OAuth App's credentials used to drive the in-app OAuth handshake:

- `GITHUB_OAUTH_CLIENT_ID` — the OAuth App's client id (plain string).
- `GITHUB_OAUTH_CLIENT_SECRET` — the OAuth App's client secret (wrapped via `createSecret()`; callers that need the cleartext SHALL call `.reveal()` at the point of use, and no other code path SHALL reveal the value).

Both variables SHALL be optional at the schema level. Validation of their presence SHALL occur at auth initialisation:

- When `auth.mode === "restricted"`, both variables MUST be set; otherwise `createConfig` SHALL throw a validation error identifying the missing field.
- When `auth.mode === "disabled"` or `auth.mode === "open"`, both variables MAY be unset.

#### Scenario: Restricted mode without client id fails startup

- **WHEN** `createConfig` is called with `{ AUTH_ALLOW: "github:user:alice" }` and no `GITHUB_OAUTH_CLIENT_ID`
- **THEN** `createConfig` SHALL throw a validation error identifying `GITHUB_OAUTH_CLIENT_ID` as missing

#### Scenario: Restricted mode with both credentials succeeds

- **WHEN** `createConfig` is called with `{ AUTH_ALLOW: "github:user:alice", GITHUB_OAUTH_CLIENT_ID: "cid", GITHUB_OAUTH_CLIENT_SECRET: "csecret" }`
- **THEN** the config SHALL contain `githubOauthClientId: "cid"`
- **AND** `githubOauthClientSecret.reveal()` SHALL equal `"csecret"`

#### Scenario: Disabled mode omits credentials

- **WHEN** `createConfig` is called without `AUTH_ALLOW` and without either OAuth credential
- **THEN** `createConfig` SHALL succeed with `auth: { mode: "disabled" }`

#### Scenario: Client secret redacts on serialization

- **WHEN** `createConfig` is called with valid auth config including `GITHUB_OAUTH_CLIENT_SECRET: "supersecret"`
- **AND** the resulting config object is serialized via `JSON.stringify`
- **THEN** the output SHALL NOT contain the substring `"supersecret"`
- **AND** the output SHALL contain `"[redacted]"` in place of the secret value

## REMOVED Requirements

### Requirement: GITHUB_USER config variable
**Reason**: Replaced by `AUTH_ALLOW`, which uses a provider-prefixed grammar (`github:user:<login>;github:org:<org>`), accepts org-level entries in addition to user-level, and governs both `/api/*` Bearer and `/dashboard` session paths with a single predicate.
**Migration**: Operators with `GITHUB_USER="alice,bob"` should set `AUTH_ALLOW="github:user:alice;github:user:bob"`. Operators who want to admit any member of a GitHub org should use `AUTH_ALLOW="github:org:<org>"` (previously unsupported). The sentinel `__DISABLE_AUTH__` continues to enable open mode. Whitespace-preservation behaviour of the old `StringSlice` parsing is replaced by whitespace-trim on the new grammar; any operator who relied on preserved whitespace must update their config. See `auth/spec.md` → "AUTH_ALLOW grammar" for the full grammar, and this capability's "AUTH_ALLOW config variable" requirement for config-side behaviour.
