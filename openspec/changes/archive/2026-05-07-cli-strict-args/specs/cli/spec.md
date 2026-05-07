## ADDED Requirements

### Requirement: Strict argument parsing

The `wfe upload` and `wfe build` subcommands SHALL reject unknown long flags, unknown short flags, and unexpected positional arguments. On detection, the CLI SHALL print `unknown option: <flag>` (or `unexpected argument: <value>` for positionals) to stderr followed by `run \`wfe <subcommand> --help\` to see valid options`, and SHALL exit with status `1` BEFORE attempting any build, network request, or other side effect.

The check SHALL run after citty has resolved `--help` and `--version`, which short-circuit before user code; those flags SHALL NOT be treated as unknown. The top-level `wfe` command (subcommand dispatch) SHALL NOT enforce strict parsing — citty's "Unknown command" error already covers unknown subcommand names.

#### Scenario: Unknown long flag rejected

- **WHEN** `wfe upload --tenant acme` is invoked (legacy flag removed in favor of `--repo`)
- **THEN** the CLI SHALL print `unknown option: --tenant` to stderr
- **AND** the CLI SHALL print a hint pointing at `wfe upload --help`
- **AND** the CLI SHALL exit with status `1`
- **AND** SHALL NOT build any workflow or issue any HTTP request

#### Scenario: Unknown short flag rejected

- **WHEN** `wfe upload -x` is invoked
- **THEN** the CLI SHALL print `unknown option: -x` to stderr
- **AND** the CLI SHALL exit with status `1`

#### Scenario: Unexpected positional rejected

- **WHEN** `wfe upload extra-arg` is invoked
- **THEN** the CLI SHALL print `unexpected argument: extra-arg` to stderr
- **AND** the CLI SHALL exit with status `1`

#### Scenario: build subcommand rejects unknown flag

- **WHEN** `wfe build --foo` is invoked
- **THEN** the CLI SHALL print `unknown option: --foo` to stderr
- **AND** the CLI SHALL exit with status `1`
- **AND** SHALL NOT compile any workflow

#### Scenario: --help and --version unaffected

- **WHEN** `wfe upload --help` is invoked
- **THEN** the CLI SHALL print citty's generated help to stdout and exit `0`
- **AND** SHALL NOT print any `unknown option` message

## MODIFIED Requirements

### Requirement: Target URL resolution

The CLI SHALL POST the built tarball to `<url>/api/workflows/<owner>/<repo>`. The `<url>` SHALL be resolved with the following precedence:

1. `--url <url>` flag, if provided.
2. Built-in default: `https://workflow-engine.webredirect.org`.

The `<owner>` and `<repo>` path segments SHALL be resolved from:

1. `--repo <owner>/<name>` flag, if provided. The flag value MUST match `^([^/]+)/([^/]+)$`; on a malformed value the CLI SHALL exit with status `1` and print an error to stderr identifying the malformed flag, BEFORE attempting any build or upload.
2. Otherwise, the CLI SHALL inspect the cwd's `git remote get-url origin` and parse a `github.com` URL of either the SSH form `git@github.com:<owner>/<repo>(.git)?` or the HTTPS form `https://github.com/<owner>/<repo>(.git)?`.

If neither source yields an owner/repo pair, the CLI SHALL print `could not determine owner/repo: pass --repo <owner>/<name> or run from a github.com checkout` to stderr and exit with status `1` BEFORE attempting any build or upload.

The CLI SHALL NOT read any environment variable for the URL or for the owner/repo target.

#### Scenario: Default URL used when no flag

- **WHEN** `wfe upload --repo acme/demo` is invoked with no `--url` flag
- **THEN** the CLI SHALL POST to `https://workflow-engine.webredirect.org/api/workflows/acme/demo`

#### Scenario: Flag overrides default URL

- **WHEN** `wfe upload --url http://localhost:8080 --repo acme/demo` is invoked
- **THEN** the CLI SHALL POST to `http://localhost:8080/api/workflows/acme/demo`

#### Scenario: Repo from github.com SSH remote

- **GIVEN** the cwd's `origin` remote is `git@github.com:acme/demo.git`
- **WHEN** `wfe upload` is invoked with no `--repo` flag
- **THEN** the CLI SHALL POST to `<default-url>/api/workflows/acme/demo`

#### Scenario: Repo from github.com HTTPS remote

- **GIVEN** the cwd's `origin` remote is `https://github.com/acme/demo.git`
- **WHEN** `wfe upload` is invoked with no `--repo` flag
- **THEN** the CLI SHALL POST to `<default-url>/api/workflows/acme/demo`

#### Scenario: Missing repo and no detectable remote fails fast

- **GIVEN** the cwd has no `origin` remote, or `origin` does not point at github.com
- **WHEN** `wfe upload` is invoked with no `--repo` flag
- **THEN** the CLI SHALL print `could not determine owner/repo: pass --repo <owner>/<name> or run from a github.com checkout` to stderr
- **AND** SHALL exit with status `1`
- **AND** SHALL NOT build any workflow or issue any upload request

#### Scenario: Malformed --repo flag fails fast

- **WHEN** `wfe upload --repo notvalid` is invoked
- **THEN** the CLI SHALL exit with status `1`
- **AND** SHALL print a stderr message identifying the malformed `--repo` value
- **AND** SHALL NOT build any workflow or issue any upload request

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

- **WHEN** `wfe upload --repo acme/demo --user dev` is invoked without `GITHUB_TOKEN`
- **THEN** every upload request SHALL carry `X-Auth-Provider: local` and `Authorization: User dev`

#### Scenario: Both modes supplied is rejected

- **WHEN** `GITHUB_TOKEN=ghp_xxx` is set AND `wfe upload --user dev` is invoked
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

The CLI SHALL POST a single tarball per invocation (not per-bundle) — the build step packages all discovered workflows into one `.tar.gz` containing a root `manifest.json` (`{workflows: [...]}`) plus one `<name>.js` per workflow. The tarball SHALL be POSTed to the resolved `/api/workflows/<owner>/<repo>` endpoint with `Content-Type: application/gzip`.

The CLI SHALL NOT retry a failed request.

The CLI SHALL exit with status `0` only when the upload received a `204 No Content` response. On any failure (build error, network error, owner/repo resolution failure, or non-`204` HTTP response), the CLI SHALL exit with status `1`.

#### Scenario: Successful upload

- **WHEN** a valid bundle is built and the server responds `204 No Content`
- **THEN** the CLI SHALL exit with status `0`

#### Scenario: Build error

- **WHEN** the build step fails (e.g., TypeScript error, missing handler)
- **THEN** the CLI SHALL exit with status `1`
- **AND** no upload request SHALL be issued

#### Scenario: Network error

- **WHEN** the upload request fails with a network error (e.g., connection refused)
- **THEN** the CLI SHALL exit with status `1`

#### Scenario: Server returns 4xx or 5xx

- **WHEN** the server responds with any non-`204` status (e.g., `401`, `404`, `422`, `500`)
- **THEN** the CLI SHALL print the status + error body to stderr
- **AND** exit with status `1`
- **AND** SHALL NOT retry

### Requirement: Programmatic API

The SDK SHALL export an `upload(options)` programmatic API. The `options` shape SHALL be:

```ts
interface UploadOptions {
  cwd: string;       // workflows directory
  url: string;       // base URL of the runtime
  owner: string;     // GitHub-org-style owner segment
  repo: string;      // repository name segment
  user?: string;     // local-provider login (mutually exclusive with token)
  token?: string;    // GitHub Bearer token (mutually exclusive with user)
}
```

If both `user` and `token` are supplied, the function SHALL reject with an error identifying the conflict; no HTTP request SHALL be made. If neither is supplied, no `Authorization` or `X-Auth-Provider` header SHALL be sent.

The `user` option SHALL drive the same headers as the CLI's `--user` flag (`X-Auth-Provider: local` + `Authorization: User <name>`). The `token` option SHALL drive `X-Auth-Provider: github` + `Authorization: Bearer <token>`.

#### Scenario: upload() with user sets local headers

- **WHEN** `await upload({ cwd, url, owner: "acme", repo: "demo", user: "dev" })` is invoked
- **THEN** every upload request SHALL carry `X-Auth-Provider: local` and `Authorization: User dev`

#### Scenario: upload() with token sets github headers

- **WHEN** `await upload({ cwd, url, owner: "acme", repo: "demo", token: "ghp_xxx" })` is invoked
- **THEN** every upload request SHALL carry `X-Auth-Provider: github` and `Authorization: Bearer ghp_xxx`

#### Scenario: upload() with both user and token rejects

- **WHEN** `await upload({ cwd, url, owner: "acme", repo: "demo", user: "dev", token: "ghp_xxx" })` is invoked
- **THEN** the promise SHALL reject with an error identifying the mutual-exclusion violation
- **AND** SHALL NOT send any HTTP request
