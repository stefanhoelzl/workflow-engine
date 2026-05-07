## Context

The `wfe` CLI is built on `citty` (`packages/sdk/src/cli/cli.ts`). citty parses argv with `parseArgs({ strict: false })` internally, so unknown long flags (e.g. `--tenant`), unknown short flags, and unexpected positionals are silently kept in the parsed `args` object and ignored by `run()`. There is no `strict` toggle exposed on `defineCommand`. Subcommands today: `upload` (declares `--url`, `--repo`, `--user`) and `build` (no flags).

The cli spec under `openspec/specs/cli/` was written when the upload target was `--tenant`/`WFE_TENANT`. Commit `ec8728ad` renamed `tenant → owner` in code and added `--repo`, but the spec prose was not realigned.

There is no `cli.test.ts` today; CLI behavior is exercised indirectly through `upload.test.ts`, `build.test.ts`, etc.

## Goals / Non-Goals

**Goals:**

- `wfe upload --tenant acme` (and any other unknown-flag invocation) exits `1` with a clear stderr message instead of running an upload to the wrong target.
- The `cli` spec describes what the binary actually accepts.
- Implementation surface is minimal: one helper, called from each subcommand's `run`.

**Non-Goals:**

- Suggestion / Levenshtein hints on the unknown-flag error.
- Introducing `WFE_OWNER`/`WFE_REPO` env-var fallbacks. The spec drops `WFE_TENANT` outright; `--repo` plus git-remote auto-detect already covers CI ergonomics.
- Adding a `cli.test.ts`. The helper is small and the wiring is adequately covered by the existing per-subcommand tests; introducing test infrastructure for one helper is more cost than benefit.
- Strict parsing at the top-level `wfe` entry. citty already errors on unknown subcommand names ("Unknown command"), and `--help`/`--version` need to flow through unaffected.

## Decisions

### Detection via set-diff on `args`, not a citty plugin or fork

citty stores unrecognized `--foo[=bar]` flags as extra string keys on the parsed `args` object (alongside `_` for positionals). The known set is computed from the subcommand's `args` definition (declared keys plus each entry's `alias` field, normalized to an array) plus the literal `_`. Anything in `args` outside that set is unknown.

A small synchronous helper:

```
assertNoUnknownArgs(args, knownKeys)
  → if any unknown key found: throw with message "unknown option: --<flag>"
  → if args._ has elements: throw with message "unexpected argument: <value>"
```

The helper is called as the first line of each subcommand's `run`. On throw, the existing `catch` in `run` prints the message and exits `1`; we add a hint line (`run \`wfe <subcommand> --help\`...`) at the throw site.

**Alternatives considered:**

- *Patch citty / write a citty plugin.* citty's `strict: false` is hardcoded inside `parseArgs`; flipping it would require either a fork or a plugin that re-parses argv. Both are heavier than a six-line helper for a two-subcommand CLI.
- *Re-parse `rawArgs` with `node:util parseArgs({ strict: true })`.* Equivalent in coverage but duplicates citty's flag definitions in a second place that can drift.

### Per-subcommand call site, not a `setup` hook

citty exposes a `setup` hook on `CommandDef`, which would let the assertion live once per subcommand declaration. We instead call the helper from `run` because (a) it keeps the failure path inline with the existing try/catch, (b) the known-keys list is most naturally derived from the same `args:` object literal that defines the command, kept side-by-side. Two call sites is fine for two subcommands.

### Hard fail, not warn

A warn-and-continue would still let `wfe upload --tenant acme` upload to the wrong target. The whole motivation for strict args is the legacy `--tenant` footgun; a warn defeats it.

## Risks / Trade-offs

- **Risk:** future contributor adds a subcommand and forgets to call `assertNoUnknownArgs`. → **Mitigation:** call sites are short and visible; a code-review checklist note in this proposal is sufficient. Extracting a `defineStrictCommand` wrapper is over-engineering for two subcommands.
- **Risk:** citty version bump changes how unknown flags are stored on `args`. → **Mitigation:** SDK pins citty in `package.json`; bump is a deliberate action that will surface this code path.
- **Risk:** users with valid third-party CI scripts pass an unknown flag intentionally (e.g. an env-template artifact). → **Mitigation:** none — this is the desired behavior. The error names the offending flag clearly; the fix is to delete the flag from the script.
- **Trade-off:** no `cli.test.ts`. We accept that the strict-args behavior will be exercised manually during the implementation tasks (curl-style scripted invocations against `pnpm exec wfe`). The spec scenarios document the contract for the next person who does add tests.
