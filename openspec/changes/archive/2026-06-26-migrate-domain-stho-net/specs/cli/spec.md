## MODIFIED Requirements

### Requirement: Target URL resolution

The CLI SHALL POST the built tarball to `<url>/api/workflows/<owner>/<repo>`. The `<url>` SHALL be resolved with the following precedence:

1. `--url <url>` flag, if provided.
2. Built-in default: `https://workflow-engine.stho.net`.

The `<owner>` and `<repo>` path segments SHALL be resolved from:

1. `--repo <owner>/<name>` flag, if provided. The flag value MUST match `^([^/]+)/([^/]+)$`; on a malformed value the CLI SHALL exit with status `1` and print an error to stderr identifying the malformed flag, BEFORE attempting any build or upload.
2. Otherwise, the CLI SHALL inspect the cwd's `git remote get-url origin` and parse a `github.com` URL of either the SSH form `git@github.com:<owner>/<repo>(.git)?` or the HTTPS form `https://github.com/<owner>/<repo>(.git)?`.

If neither source yields an owner/repo pair, the CLI SHALL print `could not determine owner/repo: pass --repo <owner>/<name> or run from a github.com checkout` to stderr and exit with status `1` BEFORE attempting any build or upload.

The CLI SHALL NOT read any environment variable for the URL or for the owner/repo target.

#### Scenario: Default URL used when no flag

- **WHEN** `wfe upload --repo acme/demo` is invoked with no `--url` flag
- **THEN** the CLI SHALL POST to `https://workflow-engine.stho.net/api/workflows/acme/demo`

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
