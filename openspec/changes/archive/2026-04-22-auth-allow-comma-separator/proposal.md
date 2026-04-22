## Why

`AUTH_ALLOW` currently uses `;` as its entry separator. Moving `auth_allow` to GitHub repo variables made comma the natural choice — it's what the operator typed first when setting `AUTH_ALLOW_PROD`, and it matches how lists are usually written in shell env values. Comma is safe given the entry grammar (`provider:kind:id` with IDs restricted to `[A-Za-z0-9][-A-Za-z0-9]*`).

## What Changes

- **BREAKING** `AUTH_ALLOW` grammar separator changes from `;` to `,`. Entries are now comma-separated (e.g. `github:user:alice,github:org:acme`).
- Parser in `packages/runtime/src/auth/allowlist.ts` splits on `,` instead of `;`.
- Sentinel `__DISABLE_AUTH__` rule is unchanged: still valid only as the entire value; now rejected if it appears as one `,`-separated segment.
- Test fixtures, parser comment, infrastructure module comment (`modules/app-instance/variables.tf`), and the CLAUDE.md upgrade note that documents the grammar all update to the comma form.
- Upgrade note added to CLAUDE.md describing the env-value reformat required at deploy time.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `auth`: `AUTH_ALLOW` grammar and the sentinel-adjacency scenario reference the new separator.

## Impact

- Affected code: `packages/runtime/src/auth/allowlist.ts`, `packages/runtime/src/auth/allowlist.test.ts`, `packages/runtime/src/auth/integration.test.ts` (any tests using the literal separator), `infrastructure/modules/app-instance/variables.tf` (comment block).
- Affected config: GitHub repo variables `AUTH_ALLOW_PROD` and `AUTH_ALLOW_STAGING` — `AUTH_ALLOW_PROD` is already comma-formatted; `AUTH_ALLOW_STAGING` is single-entry (unaffected). No operator action required post-merge.
- Affected docs: CLAUDE.md upgrade-notes entry (the `auth-allow-to-github-variables` item mentioning `;`) replaced/updated; SECURITY.md is unaffected (no separator references).
- No state wipe, no tenant re-upload. Env-var format change only.
- No sandbox-boundary, EventBus, or manifest changes.
