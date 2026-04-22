## Context

`AUTH_ALLOW` is parsed by `packages/runtime/src/auth/allowlist.ts`. The current separator is `;`, documented in `openspec/specs/auth/spec.md` and mirrored in a comment block in `infrastructure/modules/app-instance/variables.tf`. A sibling workstream moved the value out of committed tfvars and into GitHub repo variables (`AUTH_ALLOW_PROD`, `AUTH_ALLOW_STAGING`), wired into the deploy workflows via `TF_VAR_auth_allow`. Comma is the more natural list separator in that context.

## Goals / Non-Goals

**Goals:**
- Change the `AUTH_ALLOW` entry separator from `;` to `,` end-to-end (spec, parser, comment, tests, upgrade docs).
- Keep every other parse rule intact: whitespace trim, empty-segment skip, `__DISABLE_AUTH__` sentinel, per-entry grammar, `disabled`/`open`/`restricted` mode resolution, `allow(user)` predicate.
- Keep the sentinel-adjacency guard: `__DISABLE_AUTH__` alongside other entries still fails startup, now worded around the comma.

**Non-Goals:**
- Supporting both separators simultaneously — no dual-read compatibility window. The value is operator-controlled via two GitHub variables; flipping the separator at merge time is atomic.
- Changing entry grammar (`provider:kind:id`), ID regex, or any downstream auth behavior.
- Touching SECURITY.md (no separator references there).
- Changing the GitHub-variable names or workflow wiring.

## Decisions

**Use `,` as the new separator.**
- Alternative: keep `;`. Rejected — the interview task already moved config to GitHub variables, and the operator's first instinct was comma; matching that removes future friction.
- Alternative: accept both `;` and `,`. Rejected — two parse paths, two sets of scenarios, persistent ambiguity in docs. Single separator is simpler and the blast radius of one `gh variable set` is tiny.

**No dual-read migration window.**
- The env-var value is set by two GitHub variables, both re-settable in one CLI call. `AUTH_ALLOW_PROD` already happens to be comma-formatted (from operator's earlier command). `AUTH_ALLOW_STAGING` is single-entry and unaffected by the separator.
- Alternative: ship a parser that accepts both for one release, drop `;` later. Rejected — added complexity for a zero-cost cutover.

**Keep sentinel semantics unchanged.**
- `__DISABLE_AUTH__` remains valid only as the full value. If a caller writes `github:user:alice,__DISABLE_AUTH__`, parsing still fails with the sentinel-must-be-sole-value error. Spec scenario text updated to use the comma in the failing example.

## Risks / Trade-offs

- **Operator forgets to reformat an env-var containing `;`** → parser rejects malformed entry (one split segment looks like `github:user:a;github:org:b` → fails `provider:kind:id` triple check). App starts up with the previous config until redeploy; next apply fails loudly at startup. Mitigation: CLAUDE.md upgrade-notes item explicitly lists the reformat step; `AUTH_ALLOW_PROD` is already comma-form and `AUTH_ALLOW_STAGING` is single-entry, so the realistic risk surface is only local dev tfvars (`infrastructure/envs/local/terraform.tfvars`) which this change updates in the same PR.
- **Third-party shell wrappers that pass `AUTH_ALLOW` directly** → none known; the variable is set only through the terraform module. No migration fallout outside the repo.

## Migration Plan

1. Apply the PR:
   - `openspec/specs/auth/spec.md` — grammar line + 5 scenarios (`Mixed user and org entries`, `Whitespace around entries is trimmed`, `Parseable value produces restricted mode`, `Sentinel mixed with entries fails startup`, plus the sentinel-paragraph wording) use `,`.
   - `packages/runtime/src/auth/allowlist.ts` — comment block (line 4) and `split(";")` calls (lines 31, 76) use `,`.
   - `packages/runtime/src/auth/allowlist.test.ts` and `packages/runtime/src/auth/integration.test.ts` — literal-separator fixtures use `,`.
   - `infrastructure/modules/app-instance/variables.tf` — grammar comment at lines 45–47 references `,`.
   - `infrastructure/envs/local/terraform.tfvars` — no change (single-entry value).
   - CLAUDE.md — upgrade-notes entry added/amended to document the separator swap and the already-comma-formatted GitHub variables.
2. After merge: no operator action. `AUTH_ALLOW_PROD` is already comma-formatted; `AUTH_ALLOW_STAGING` is single-entry.
3. Rollback: revert the PR. Same steps in reverse; the GitHub variables would then need to be reset to `;`-form via `gh variable set`.

## Open Questions

None.
