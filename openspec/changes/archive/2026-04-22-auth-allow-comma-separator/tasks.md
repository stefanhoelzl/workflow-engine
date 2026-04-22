## 1. Parser

- [x] 1.1 Update `packages/runtime/src/auth/allowlist.ts`: change grammar comment (line 4), `split(";")` in `parseAuthAllow` (line 31), and sentinel-adjacency `split(";")` in `parseAuth` (line 76) to use `","`.

## 2. Tests

- [x] 2.1 Update `packages/runtime/src/auth/allowlist.test.ts` fixtures that use `;` to use `,`; add or adjust a fixture proving `,,` is skipped and that sentinel-mixed-with-entries via `,` still fails.
- [x] 2.2 Update `packages/runtime/src/auth/integration.test.ts` (and any other `packages/runtime/src/auth/*.test.ts`) fixtures that use the literal `;` separator. Also updated `packages/runtime/src/config.test.ts` and two tf variable-description strings (`envs/prod/prod.tf`, `envs/local/local.tf`) that carried `;`-form examples.
- [x] 2.3 Run `pnpm validate` and confirm lint, format, type check, and tests pass.

## 3. Infrastructure comment

- [x] 3.1 Update `infrastructure/modules/app-instance/variables.tf` lines 45–47: change the grammar-example comment (`"github:user:stefanhoelzl;github:org:acme"`) to use `,`.

## 4. Docs

- [x] 4.1 Update the CLAUDE.md upgrade-notes entry for the AUTH_ALLOW GitHub-variables work to reference the new `,` separator, and add a dedicated bullet describing this separator swap (so operators searching for the `;` → `,` change find it in the upgrade log).

## 5. Cutover verification

- [x] 5.1 Confirm `gh variable get AUTH_ALLOW_PROD` is already comma-formatted and parses under the new grammar locally (e.g. via a quick `parseAuth` unit invocation in a vitest scratch test or `node --import tsx`). No operator reset needed. Verified via `gh variable list`: value is `github:user:stefanhoelzl,github:user:mrh1997,github:org:baltech-ag,github:org:sharepad-de`.
- [x] 5.2 Confirm `gh variable get AUTH_ALLOW_STAGING` is single-entry (no separator) and therefore unaffected. Verified: value is `github:user:stefanhoelzl`.
