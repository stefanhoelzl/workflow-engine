## Why

Commit `ec8728ad` renamed `tenant → owner` and added `--repo`, but `wfe upload --tenant acme` still exits `0` today: citty parses with `strict: false`, so unknown flags are silently dropped. A user with a stale CI script from before the rename gets a successful exit and an upload to the wrong target. The `cli` spec is also still written in the pre-rename `--tenant`/`WFE_TENANT` vocabulary, so the doc lies about what the binary accepts.

## What Changes

- The `wfe` CLI rejects unknown long/short flags and unexpected positional arguments per subcommand. `wfe upload --tenant acme` exits `1` with `unknown option: --tenant` on stderr plus a `run \`wfe upload --help\`` hint. `--help` and `--version` are unaffected (citty short-circuits them before parsing). Top-level `wfe` parsing is unchanged.
- Realign `openspec/specs/cli/spec.md` to the post-`ec8728ad` reality:
  - Drop the `WFE_TENANT` env-var fallback and its scenario — never re-implemented after the rename, no env var is read for the upload target today.
  - Replace `--tenant <name>` requirement + scenarios with `--repo <owner>/<name>` plus the github.com `git remote` auto-detect that's already implemented (`detectGitRemote`).
  - Update the upload POST path from `/api/workflows/<tenant>` to `/api/workflows/<owner>/<repo>`.
  - Update the programmatic `UploadOptions` shape from `{ tenant }` to `{ owner, repo }`.
  - Replace the "missing tenant fails fast" scenario with "missing repo + no detectable github.com remote fails fast".

## Capabilities

### New Capabilities
<!-- None — this lands as deltas to an existing capability. -->

### Modified Capabilities
- `cli`: adds a "strict argument parsing" requirement; realigns the existing target-resolution, auth, upload-semantics, and programmatic-API requirements from the obsolete `tenant` vocabulary to `owner`/`repo`.

## Impact

- Source: `packages/sdk/src/cli/cli.ts` only (a small `assertNoUnknownArgs` helper called at the top of each subcommand `run`). No tests added — there is no `cli.test.ts` today and the helper is too small to seed one.
- Spec: `openspec/specs/cli/spec.md` — four MODIFIED requirements, one ADDED requirement, two REMOVED scenarios (`WFE_TENANT fallback`, `Missing tenant fails fast`).
- Behavior: any caller passing flags the CLI doesn't declare now exits `1`. The known-bad case is the legacy `--tenant` flag; no other unknown-flag uses are documented anywhere in the repo.
- Out of scope: env-var-based upload-target resolution (no `WFE_OWNER`/`WFE_REPO` is introduced); CLI test infrastructure; suggestion / Levenshtein hints on the unknown-flag error.
