## Context

`scripts/dev.ts` is the only code today that uploads a workflow bundle to the runtime. It imports vite directly, builds `workflows/`, and `fetch`-POSTs each `bundle.tar.gz` to `http://localhost:8080/api/workflows` with auth disabled via the `GITHUB_USER=__DISABLE_AUTH__` sentinel. It is a developer-only script; no one outside this repo can use it.

At the same time, `@workflow-engine/sdk` and `@workflow-engine/vite-plugin` are marked `"private": true`. External users who want to author workflows against a deployed runtime have no path: they cannot install the SDK from npm, and even if they could, there is no upload tool.

The `@workflow-engine/vite-plugin` currently requires an explicit `workflows: string[]` option; its only caller is `workflows/vite.config.ts`. The `workflows/` directory uses a single-file-per-workflow convention (`cronitor.ts`) that matches what we want to standardize on.

The runtime's `POST /api/workflows` endpoint (`packages/runtime/src/api/upload.ts`) collapses detailed registry errors into a generic `Invalid workflow bundle` 422 body. The registry internally produces useful messages (`missing action module: X`, `invalid manifest: <zod error>`) but `upload.ts` throws them away. Any user who gets a 422 has to SSH into the runtime and read logs to understand why.

## Goals / Non-Goals

**Goals:**
- Publish a CLI (`@workflow-engine/cli` / `wfe`) that lets any external user with a deployed runtime build and upload workflows.
- Publish `@workflow-engine/sdk` and `@workflow-engine/vite-plugin` so external users can author and build workflows against a real npm package graph.
- Standardize on one workflow-project convention (`src/*.ts`, one file per workflow, no user-authored vite config).
- Remove the upload logic from `scripts/dev.ts` and route it through the CLI's programmatic API so the repo's own dev loop and external users share a single code path.
- Surface the runtime's real reason for a 422 so the CLI can show actionable errors.

**Non-Goals:**
- `wfe trigger` / `wfe logs` / `wfe list` — deferred to a later change.
- `wfe dev` or `--watch` flag — the CLI stays one-shot. `scripts/dev.ts` owns the watch loop and only needs the CLI's `upload()` export.
- Multi-environment config (`~/.wfe/config.toml`, profiles, `wfe login`) — YAGNI.
- Build/upload split (`wfe upload <dist>` for pre-built bundles) — can be added later without breaking v1.
- Supporting user-authored `vite.config.ts` — the plugin pipeline is opinionated enough that this adds complexity with no real flexibility.
- `@workflow-engine/runtime` and `@workflow-engine/sandbox` becoming public — the runtime ships as a container image; sandbox is runtime-internal.
- Any new server-side route — `POST /api/workflows` stays the only upload endpoint, only its 422 body is tightened.
- Changes to the sandbox boundary — action code runs identically before and after.

## Decisions

### D1. Three published packages (sdk, vite-plugin, cli)

Minimum publishable set is `sdk` (external users import it in workflow source) and `cli` (external users install it). The plugin could be bundled into the CLI, but publishing it separately keeps the dependency graph honest, matches what pnpm `workspace:*` resolutions expect at publish time, and lets the CLI pin the plugin by semver instead of vendoring source.

**Alternatives considered:**
- **Bundle plugin into CLI**: requires build-time bundling of the plugin's polyfill deps (`abab`, `blob-polyfill`, `mock-xmlhttprequest`, etc.). Non-trivial, and obscures what the user actually gets.
- **Monolithic `@workflow-engine/cli` that re-exports SDK**: breaks the already-published-style import `import { createWorkflow } from "@workflow-engine/sdk"` visible in `workflows/cronitor.ts`. Forces a rename.

### D2. Shared version, manual `pnpm -r publish`

All three published packages bump in lockstep. A breaking change in any one of them is a major bump across all three. `pnpm -r publish` publishes all workspace packages that are not `private`.

**Alternatives considered:**
- **Changesets**: overhead rarely pays off below several contributors or several releases per week; this project has neither today.
- **Independent versions**: would require changesets to track; adds ceremony for a coordinated set of packages that are tightly coupled by shared runtime contracts.

### D3. One CLI command, citty, built-in default URL

`wfe upload [--url <url>]` is the entire v1 surface. citty gives typed argv parsing and room to grow to `trigger/logs/list` later without rework. The built-in default `https://workflow-engine.webredirect.org` points at this project's production instance — acknowledged as not-useful for other deployments; the README will document `--url` as the override and the server already returns 401 clearly on allow-list rejection.

**Alternatives considered:**
- `util.parseArgs`: zero-dep, perfect for one flag; would need manual subcommand dispatch when `trigger/logs/list` land. Chose citty to avoid the later migration.
- commander: 260 KB, zero transitive deps, but TS ergonomics are worse and the API is heavier than the surface needs.
- No default URL: external users would get a clear `--url required` error, which is safer. Owner accepted the tradeoff.

### D4. Plugin auto-discovery of `<root>/src/*.ts`

The plugin drops its `workflows: string[]` option entirely. With no callers left outside the CLI (since users no longer author `vite.config.ts`), there is no need for configurability.

Auto-discovery is **non-recursive** and fixed to `src/*.ts`. Helper files in subdirectories (e.g. `src/shared/util.ts`) are imported normally by workflow entries but are never treated as workflows themselves. The plugin **errors at build time** when the directory is missing or empty — a workflow project with nothing to build is a user error, not a silent no-op.

**Alternatives considered:**
- Recursive `src/**/*.ts`: a helper file accidentally becomes a workflow candidate; `.compile()` fails in an unhelpful place. Rejected.
- Marker-based discovery (files whose default export has `.compile()`): would require importing every `.ts` file in the tree before knowing. Slow and pulls unrelated files through the plugin's nested vite build.
- Keep the `workflows` option as an escape hatch: two code paths, dead flexibility given no remaining callers.

### D5. CLI exports `upload()`; scripts/dev.ts imports it

The `wfe` binary is a thin citty wrapper around an exported `upload(options)` function. The repo's own `scripts/dev.ts` imports that function directly rather than spawning the binary.

```
     @workflow-engine/cli
     ┌──────────────────────────────────┐
     │                                  │
     │  src/upload.ts                   │
     │    export async function         │
     │    upload({cwd, url}): Promise   │
     │            ▲          ▲          │
     │            │          │          │
     │  src/cli.ts│          │          │
     │    citty.run({        │          │
     │      upload: {        │          │
     │        run: ctx =>    │          │
     │        upload(ctx.    │          │
     │           args)       │          │
     │      }                │          │
     │    })                 │          │
     │                       │          │
     └───────────────────────┼──────────┘
                             │
                             │ import { upload }
                             │
                  ┌──────────┴─────────┐
                  │ scripts/dev.ts     │
                  │  tcpPoll(8080) →   │
                  │  upload({          │
                  │    cwd,            │
                  │    url: 'http://…  │
                  │  })                │
                  │  watch(src/**)     │
                  └────────────────────┘
```

**Rationale:**
- Avoids a chicken-and-egg at clean clone: `pnpm dev` would otherwise need the CLI binary built first. With a direct import, `tsx scripts/dev.ts` works from source.
- `upload()` is unit-testable without spawning processes.
- External users who want programmatic access get the same function (useful for custom CI).

**Alternatives considered:**
- `scripts/dev.ts` spawns `wfe` as a subprocess: requires pre-built CLI binary, regression from today's zero-build dev loop.
- `scripts/dev.ts` keeps its own inline upload logic: drift risk as CLI behavior evolves; the whole point was a single code path.

### D6. Auth: `GITHUB_TOKEN` env only, no `gh` fallback, no flag

The CLI reads `GITHUB_TOKEN`, and only `GITHUB_TOKEN`. If set, every upload request sends `Authorization: Bearer <token>`. If unset, no `Authorization` header is sent and the server decides (the `__DISABLE_AUTH__` / `open` mode still works for dev).

**Rationale:**
- `GITHUB_TOKEN` is the standard env var in GitHub Actions and scripts, so CI just works.
- No hidden shell-outs to `gh` → no cross-machine variability.
- No `--token` flag → no accidental leak into shell history.
- In dev, `scripts/dev.ts` sets no token; the runtime already runs in `open` mode via the sentinel.

**Alternatives considered:**
- Fallback chain `--token > env > gh auth token`: more magic and two more failure modes (`gh` missing / not logged in).
- `WFE_TOKEN`-style project-specific env var: no reason to diverge from the ecosystem name.

### D7. Best-effort per-bundle, never retry, non-zero on any failure

Each bundle is an independent POST. The CLI attempts every bundle regardless of earlier outcomes, prints a `✓`/`✗` line per bundle, prints a final summary, and exits `1` if any bundle failed. There is no retry loop — including no "wait for server" retry that the current `scripts/dev.ts` has.

`scripts/dev.ts` absorbs the startup race by **TCP-polling `127.0.0.1:8080`** until the socket accepts, *then* invoking `upload()` once. The poll lives in `scripts/dev.ts`, not the CLI.

**Rationale:**
- CLI failures in CI should be loud and fast; a silent retry masks genuine server problems.
- Dev-only retry logic does not belong in a published tool.
- Separation of concerns: "is the server ready?" is a dev-orchestration concern; "did the upload succeed?" is the CLI's.

### D8. Runtime forwards registry error + zod issues in 422 body

`packages/runtime/src/api/upload.ts` currently does:

```ts
const name = await registry.register(files);
if (!name) return c.json({ error: "Invalid workflow bundle" }, 422);
```

The fix: registry's `register()` already has the structured reason internally; change its return to include it, and forward in the HTTP body.

**New response shape on 422:**

```json
{
  "error": "invalid manifest: <human-readable>",
  "issues": [
    { "path": ["actions", 0, "name"], "message": "Required" }
  ]
}
```

`issues` is present only when the failure is a `ManifestSchema` Zod error. For non-Zod failures (missing file, malformed JSON), only `error` is set.

**Registry surface change:**

```ts
// before
register(files: Map<string, string>): Promise<string | undefined>

// after
register(files: Map<string, string>): Promise<
  | { ok: true, name: string }
  | { ok: false, error: string, issues?: ZodIssue[] }
>
```

This is an internal interface — only `upload.ts` and the storage recover path call it.

### D9. Publish shape decisions defer to the operator

The design assumes the `@workflow-engine` npm scope is available or can be registered by the operator before first publish. If it is taken, the decision to use an alternate scope (e.g., `@stefan-hoelzl/workflow-engine-*`) is a mechanical rename and does not affect this design.

## Risks / Trade-offs

**[Risk]** The built-in default URL (`https://workflow-engine.webredirect.org`) points at the project maintainer's personal instance. An external user who runs `npx @workflow-engine/cli upload` with no `--url` will hit a runtime whose allow-list rejects them (`401`).
→ **Mitigation**: the CLI's error output includes the server's `error` field, so the 401 message is visible. The README on npm must call this out prominently and document `--url`. Acceptable because no sensible "neutral" default exists for a CLI that talks to a user-specific backend.

**[Risk]** Removing the plugin's `workflows: string[]` option is a hard breaking change for anyone who forked the plugin and passed a custom list.
→ **Mitigation**: all in-tree callers (only `workflows/vite.config.ts`) are being removed in the same change. External callers do not exist yet — pre-publish.

**[Risk]** No CI build/upload split means CI pipelines that cache a `dist/` artifact across jobs must re-build on every upload.
→ **Mitigation**: workflow builds are seconds (vite's nested build with nothing external). Can be reintroduced later as `wfe upload <dist>` without breaking v1.

**[Risk]** Publishing three new packages simultaneously increases the surface for first-release bugs (missing `files`, wrong `main`, broken `bin` shebang, transitive deps not listed).
→ **Mitigation**: dogfood via `pnpm pack` + `npx ./wfe-*.tgz upload --url http://localhost:8080` against the local stack before the first real publish. Tasks file lists this explicitly.

**[Risk]** The dev-loop TCP poll can race with the runtime's HTTP readiness (port accepting but app not yet wired).
→ **Mitigation**: retry the whole `upload()` once on connection-refused from inside `scripts/dev.ts` — the retry lives in the dev orchestrator, not the CLI. Hot-reload is forgiving here because any subsequent file change re-triggers the upload.

**[Risk]** Removing user-authored `vite.config.ts` cuts off any user who needs a vite escape hatch (aliases, extra plugins, custom resolver).
→ **Mitigation**: the plugin's own nested `build()` already locks the resolver/polyfill set (it has to, for the QuickJS sandbox). User vite config only ever controlled the workflow list — which the plugin now auto-discovers.

## Migration Plan

1. **Plugin + SDK**: drop `"private": true`, bump to a shared version (e.g. `0.1.0`). These can be published immediately and safely — nothing consumes them externally yet.
2. **Plugin API**: remove `workflows` option, add auto-discovery. Update `workflows/vite.config.ts`'s sole caller (which is being deleted anyway).
3. **CLI**: create `packages/cli/`, implement `upload()`, `build()`, shipped vite config, citty entry.
4. **Runtime**: update `upload.ts` + `workflow-registry.ts` to return structured errors.
5. **In-tree workflow migration**: `mv workflows/cronitor.ts workflows/src/cronitor.ts`; delete `workflows/vite.config.ts`; update `workflows/package.json`.
6. **`scripts/dev.ts` rewrite**: TCP poll → `import { upload } from '@workflow-engine/cli'` → recursive watch of `src/**/*.ts`.
7. **Dogfood**: `pnpm dev` should still work end-to-end. Run the full validate suite.
8. **First publish** (operational, out of scope for this change's tasks but noted): `pnpm -r publish` with `@workflow-engine` scope registered.

**Rollback**: the change is isolated to new code (`packages/cli/`) plus the plugin/runtime/workflows rewrites. A rollback is a `git revert`; no migrations of persistent state.

## Open Questions

- `@workflow-engine` npm scope availability: unverified at design time. If taken, operator picks an alternate scope and renames all three package `name` fields before publishing. No code impact beyond the rename.
- First published version: `0.1.0` vs `1.0.0`? Decision deferred to publish time.
