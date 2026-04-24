## MODIFIED Requirements

### Requirement: Target URL resolution

The CLI SHALL POST each bundle to `<url>/api/workflows/<owner>/<repo>`. The `<url>` SHALL be resolved with the following precedence:

1. `--url <url>` flag, if provided
2. Built-in default: `https://workflow-engine.webredirect.org`

The CLI SHALL NOT read any environment variable for the URL.

`<owner>` and `<repo>` SHALL be resolved per the `Repository auto-detection` requirement.

#### Scenario: Default URL used when no flag

- **WHEN** `wfe upload` is invoked with no `--url` flag and repo detection yields `acme/foo`
- **THEN** the CLI SHALL POST to `https://workflow-engine.webredirect.org/api/workflows/acme/foo`

#### Scenario: Flag overrides default

- **WHEN** `wfe upload --url http://localhost:8080 --repo acme/foo` is invoked
- **THEN** the CLI SHALL POST to `http://localhost:8080/api/workflows/acme/foo`

### Requirement: Authentication via GITHUB_TOKEN or --user

The CLI SHALL support two mutually-exclusive authentication modes for upload requests:

1. **GitHub** (production): when `GITHUB_TOKEN` is set and non-empty, the CLI SHALL include `X-Auth-Provider: github` and `Authorization: Bearer <token>` on every upload request.
2. **Local** (dev only): when `--user <name>` is passed (or the programmatic `upload({ user })` option is set) and non-empty, the CLI SHALL include `X-Auth-Provider: local` and `Authorization: User <name>` on every upload request.

The two modes SHALL be mutually exclusive. If both `GITHUB_TOKEN` and `--user` are supplied, the CLI SHALL exit with status `1` and print an error to stderr identifying the conflict; no upload SHALL be attempted.

When neither mode is supplied, the CLI SHALL omit both headers and let the server decide (today's server SHALL respond `401 Unauthorized`).

#### Scenario: GITHUB_TOKEN present sends github headers

- **WHEN** `GITHUB_TOKEN=ghp_xxx` is set and `wfe upload` is invoked without `--user`
- **THEN** every upload request SHALL carry `X-Auth-Provider: github` and `Authorization: Bearer ghp_xxx`

#### Scenario: --user sends local headers

- **WHEN** `wfe upload --repo alice/utils --user alice` is invoked without `GITHUB_TOKEN`
- **THEN** every upload request SHALL carry `X-Auth-Provider: local` and `Authorization: User alice`

#### Scenario: Both modes supplied is rejected

- **WHEN** `GITHUB_TOKEN=ghp_xxx` is set AND `wfe upload --user alice` is invoked
- **THEN** the CLI SHALL exit with status `1`
- **AND** print an error to stderr identifying that the two modes are mutually exclusive
- **AND** SHALL NOT send any upload request

#### Scenario: Neither mode omits both headers

- **WHEN** `GITHUB_TOKEN` is unset and `--user` is not passed
- **THEN** upload requests SHALL omit both `Authorization` and `X-Auth-Provider`

#### Scenario: 401 surfaced to the user

- **WHEN** the server returns `401 Unauthorized` for a bundle
- **THEN** the CLI SHALL print `✗ <name>` followed by indented `status: 401` and the server's `error` field to stderr
- **AND** the CLI SHALL continue attempting remaining bundles

### Requirement: Upload semantics

For each discovered bundle, the CLI SHALL POST the contents of `dist/<name>/bundle.tar.gz` to the resolved `/api/workflows/<owner>/<repo>` endpoint with `Content-Type: application/gzip`. The CLI SHALL attempt every bundle even if earlier ones fail (best-effort). The CLI SHALL NOT retry a failed request.

The CLI SHALL exit with status `0` only when every bundle received a `204 No Content` response. On any failure (build error, network error, repo-detection error, or non-`204` HTTP response), the CLI SHALL exit with status `1`.

#### Scenario: All bundles succeed

- **WHEN** three bundles each receive `204 No Content`
- **THEN** the CLI SHALL exit with status `0`

#### Scenario: One bundle fails, others succeed

- **WHEN** bundle `foo` receives `204`, bundle `bar` receives `422`, and bundle `baz` receives `204`
- **THEN** the CLI SHALL still attempt the upload for `baz`
- **AND** the CLI SHALL exit with status `1`

#### Scenario: Network error on first bundle

- **WHEN** the first bundle's POST fails with a network error (e.g., connection refused)
- **THEN** the CLI SHALL still attempt remaining bundles
- **AND** the CLI SHALL exit with status `1`

#### Scenario: No retry

- **WHEN** a bundle receives a non-204 response
- **THEN** the CLI SHALL NOT retry that bundle in the same invocation

### Requirement: Programmatic API

The SDK SHALL export an `upload(options)` programmatic API. The `options` shape SHALL be:

```ts
interface UploadOptions {
  cwd: string;       // workflows directory
  url: string;       // base URL of the runtime
  owner: string;     // GitHub login (org or user) that owns the repo
  repo: string;      // GitHub repository name
  user?: string;     // local-provider login (mutually exclusive with token)
  token?: string;    // GitHub Bearer token (mutually exclusive with user)
}
```

If both `user` and `token` are supplied, the function SHALL reject with an error identifying the conflict; no HTTP request SHALL be made. If neither is supplied, no `Authorization` or `X-Auth-Provider` header SHALL be sent.

The `user` option SHALL drive the same headers as the CLI's `--user` flag (`X-Auth-Provider: local` + `Authorization: User <name>`). The `token` option SHALL drive `X-Auth-Provider: github` + `Authorization: Bearer <token>`.

`owner` SHALL be validated against `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$` and `repo` SHALL be validated against `^[a-zA-Z0-9._-]{1,100}$`; on validation failure the function SHALL reject with an error naming the offending field; no HTTP request SHALL be made.

#### Scenario: upload() with user sets local headers

- **WHEN** `await upload({ cwd, url, owner: "alice", repo: "utils", user: "alice" })` is invoked
- **THEN** every upload request SHALL carry `X-Auth-Provider: local` and `Authorization: User alice`
- **AND** the request path SHALL be `/api/workflows/alice/utils`

#### Scenario: upload() with token sets github headers

- **WHEN** `await upload({ cwd, url, owner: "acme", repo: "foo", token: "ghp_xxx" })` is invoked
- **THEN** every upload request SHALL carry `X-Auth-Provider: github` and `Authorization: Bearer ghp_xxx`
- **AND** the request path SHALL be `/api/workflows/acme/foo`

#### Scenario: upload() with both user and token rejects

- **WHEN** `await upload({ cwd, url, owner: "acme", repo: "foo", user: "dev", token: "ghp_xxx" })` is invoked
- **THEN** the promise SHALL reject with an error identifying the mutual-exclusion violation
- **AND** SHALL NOT send any HTTP request

#### Scenario: upload() with invalid owner rejects

- **WHEN** `await upload({ cwd, url, owner: "-bad", repo: "foo", token: "ghp_xxx" })` is invoked (owner starts with a hyphen)
- **THEN** the promise SHALL reject with an error naming the `owner` field
- **AND** SHALL NOT send any HTTP request

## ADDED Requirements

### Requirement: Repository auto-detection

The CLI SHALL resolve `(owner, repo)` at upload time with the following precedence:

1. If `--repo <owner>/<name>` flag is passed, parse it into `owner` and `repo` and use these.
2. Otherwise, execute `git remote get-url origin` in the CWD via `execFile` (no new dependency). If the output can be parsed as a `github.com` URL (HTTPS or SSH), extract `owner` and `repo` from the first two path segments after the host.
3. Otherwise, exit with status `1` and print an actionable error to stderr naming the detection failure.

Parsing SHALL recognize the following URL shapes as `github.com` origins:

- `https://github.com/<owner>/<repo>` (with or without `.git` suffix)
- `https://<userinfo>@github.com/<owner>/<repo>` (userinfo stripped)
- `git@github.com:<owner>/<repo>` (with or without `.git` suffix)
- `ssh://git@github.com/<owner>/<repo>` (with or without port, with or without `.git` suffix)

Any other origin (different host, malformed URL, empty remote, missing git binary) SHALL NOT be interpreted. The parser SHALL silently fall through to require `--repo` rather than synthesizing a malformed value.

`owner` and `repo` extracted from the remote SHALL be validated against the regexes from the `Programmatic API` requirement; on validation failure the CLI SHALL treat detection as failed and exit with status `1` asking for `--repo`.

#### Scenario: HTTPS origin parses

- **GIVEN** `git remote get-url origin` returns `https://github.com/acme/foo.git`
- **WHEN** `wfe upload` is invoked with no `--repo` flag
- **THEN** the CLI SHALL upload to `/api/workflows/acme/foo`

#### Scenario: HTTPS origin without .git suffix parses

- **GIVEN** `git remote get-url origin` returns `https://github.com/acme/foo`
- **WHEN** `wfe upload` is invoked with no `--repo` flag
- **THEN** the CLI SHALL upload to `/api/workflows/acme/foo`

#### Scenario: SSH origin parses

- **GIVEN** `git remote get-url origin` returns `git@github.com:alice/utils.git`
- **WHEN** `wfe upload` is invoked with no `--repo` flag
- **THEN** the CLI SHALL upload to `/api/workflows/alice/utils`

#### Scenario: SSH protocol origin parses

- **GIVEN** `git remote get-url origin` returns `ssh://git@github.com/alice/utils`
- **WHEN** `wfe upload` is invoked with no `--repo` flag
- **THEN** the CLI SHALL upload to `/api/workflows/alice/utils`

#### Scenario: HTTPS origin with userinfo strips credentials

- **GIVEN** `git remote get-url origin` returns `https://ghs_tokenxxx@github.com/acme/foo.git`
- **WHEN** `wfe upload` is invoked with no `--repo` flag
- **THEN** the CLI SHALL upload to `/api/workflows/acme/foo`
- **AND** the userinfo SHALL NOT appear anywhere in the request

#### Scenario: Non-GitHub origin falls through to --repo

- **GIVEN** `git remote get-url origin` returns `https://gitlab.com/acme/foo.git`
- **WHEN** `wfe upload` is invoked with no `--repo` flag
- **THEN** the CLI SHALL exit with status `1`
- **AND** stderr SHALL include a message naming the `--repo` flag as the remedy

#### Scenario: GitHub Enterprise host falls through to --repo

- **GIVEN** `git remote get-url origin` returns `https://github.example.com/acme/foo.git`
- **WHEN** `wfe upload` is invoked with no `--repo` flag
- **THEN** the CLI SHALL exit with status `1`
- **AND** stderr SHALL include a message naming the `--repo` flag as the remedy

#### Scenario: No origin configured

- **GIVEN** the current directory has no git remote named `origin`
- **WHEN** `wfe upload` is invoked with no `--repo` flag
- **THEN** the CLI SHALL exit with status `1`
- **AND** stderr SHALL include a message naming the `--repo` flag as the remedy

#### Scenario: --repo flag overrides detected remote

- **GIVEN** `git remote get-url origin` returns `https://github.com/acme/foo.git`
- **WHEN** `wfe upload --repo alice/utils` is invoked
- **THEN** the CLI SHALL upload to `/api/workflows/alice/utils`
- **AND** SHALL NOT invoke `git` for detection

## REMOVED Requirements

### Requirement: Target tenant selection via --tenant or WFE_TENANT

**Reason:** Tenant (now renamed to `owner`) is no longer specified independently of the repo. The repo value carries the `owner` in its `owner/repo` form, and the CLI auto-detects both from the git origin. Explicit tenant selection is redundant and can disagree with the repo's actual owner, which is confusing.

**Migration:** Replace any `--tenant X` flag with `--repo X/<repo-name>` (or omit entirely to use git remote detection). Remove any `WFE_TENANT` env var usage from CI configs.
