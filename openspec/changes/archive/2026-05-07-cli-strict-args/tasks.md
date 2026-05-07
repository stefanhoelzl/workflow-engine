## 1. Strict-args helper + wiring

- [x] 1.1 Add an `assertNoUnknownArgs(args, knownKeys)` helper in `packages/sdk/src/cli/cli.ts`. It computes `knownKeys` from the subcommand's `args` definition (declared keys plus each entry's `alias`, normalized to an array) plus the literal `_`. It throws `Error("unknown option: --<flag>")` for the first key in `args` outside the known set, and `Error("unexpected argument: <value>")` for the first element of `args._`.
- [x] 1.2 Call the helper as the first line of `uploadCommand.run` and `buildCommand.run`. On throw, print the error message + `run \`wfe <subcommand> --help\` to see valid options` hint to stderr and `process.exit(1)` (mirroring the existing error paths in `cli.ts:62-67` / `cli.ts:84-86`).
- [x] 1.3 Verify manually:
  - [x] 1.3.1 `pnpm exec wfe upload --tenant acme` → exit 1, stderr `unknown option: --tenant`
  - [x] 1.3.2 `pnpm exec wfe upload -x` → exit 1, stderr `unknown option: -x`
  - [x] 1.3.3 `pnpm exec wfe upload extra-arg` → exit 1, stderr `unexpected argument: extra-arg`
  - [x] 1.3.4 `pnpm exec wfe build --foo` → exit 1, stderr `unknown option: --foo`, no `dist/` writes
  - [x] 1.3.5 `pnpm exec wfe upload --help` → exit 0, citty help printed, no `unknown option` message
  - [x] 1.3.6 `pnpm exec wfe upload --url http://localhost:8080 --user local-user` (run from a github.com checkout) → still works as today

## 2. Validate

- [x] 2.1 `pnpm validate` passes (lint, check, test, tofu fmt, tofu validate)
- [x] 2.2 `pnpm exec openspec validate cli-strict-args --strict` passes
