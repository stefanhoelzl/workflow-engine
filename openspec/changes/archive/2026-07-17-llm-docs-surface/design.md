## Context

Agents author and deploy workflows through `@workflow-engine/sdk` (published to npm as CalVer, e.g. `2026.6.0`, by `deploy-prod.yml`). Four channels can reach an agent; today all four are empty or absent:

- **TSDoc** on SDK exports — `packages/sdk/src/index.ts` has exactly one TSDoc block, and it documents an *internal* dispatch mechanism, not authoring.
- **npm README** — 28 characters.
- **A worked example** — `workflows/src/demo.ts` exists but lives in a private workspace (not shipped to npm) and is a lean dev fixture, not a teaching artifact.
- **A domain entry point** — the runtime serves only `/static/*`; the root `/` 302-redirects to the auth-gated `/invocations`, so a cold visitor to the domain hits a login wall with no public docs pointer.

Two hard constraints shape the approach, both discovered in the codebase:

1. **`wfe build` ignores the user's tsconfig.** `buildWorkflows()` (`packages/sdk/src/cli/build-workflows.ts:50`) typechecks with hardcoded strict options (`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`). A hand-written project cannot break correctness — but a lax editor tsconfig will *lie*, showing no error for `.optional()` until the build fails.
2. **The runtime does not depend on `@workflow-engine/sdk`,** and the prod image is pruned with `pnpm deploy --prod --filter @workflow-engine/runtime`. Doc files under `packages/sdk/` therefore never reach the image; the runtime cannot serve SDK doc content without new plumbing or a new dependency (which would drag vite/tsx/typescript into prod).

## Goals / Non-Goals

**Goals:**
- Every SDK export carries version-matched guidance an agent sees on hover, with zero opt-in.
- A cold agent (URL only) and an in-repo agent both reach the same comprehensive, always-correct worked example.
- The comprehensive example cannot silently drift from the SDK — CI fails if it stops compiling.
- The domain root offers one thing a cold, unauthenticated visitor can read: a pointer to the docs.

**Non-Goals:**
- A `wfe init` / scaffold command. The agent hand-writes the (small) boilerplate; the build is the guardrail.
- Serving full doc *content* from the runtime. The runtime serves only a tiny index; content lives on npm/unpkg.
- Writing files (`AGENTS.md` etc.) into the user's repo uninvited.
- A docs generator or a doc-snippet drift test. The example is the only copy of comprehensive code, so there is nothing to diff.
- A spec-correct `llms.txt` index-plus-linked-pages tree. One index → the npm docs.

## Decisions

**D1 — Two example files, not one, split by what they validate.**
`example.ts` (new, in `packages/sdk`) exercises the *full* surface and is validated by **bundle** (typecheck + Rolldown, no upload). `demo.ts` (kept in `workflows/`) is the *runnable subset* validated by actually running in `pnpm dev`. This is necessary, not merely tidy: bundling never executes handlers, so `example.ts` can carry `imapTrigger`/`wsTrigger` (which need a mail server / live client to *run*) and still prove they *compile against real SDK types*. `demo.ts`, which actually runs, physically cannot hold those. The two files validate different properties (compiles-against-types vs. runs-end-to-end).
*Alternative rejected:* one file. It would force `demo.ts` to either run infra-dependent triggers (impossible in dev) or omit them from the teaching surface (incomplete docs).

**D2 — Docs live in `packages/sdk`, shipped to npm; version-matching is free.**
`example.ts` and `README.md` go in the SDK `files` list. An agent that ran `npm install` reads them from `node_modules/@workflow-engine/sdk/` off disk; a cold agent reads the identical bytes from `unpkg.com/@workflow-engine/sdk@<ver>/`. Same source, two access paths, no drift. Doc-only edits cut a CalVer patch (accepted — a doc change *is* a surface change from an agent's view, and it keeps the published copy true).
*Alternative rejected:* serve docs from the runtime image. Blocked by the no-SDK-dependency + prune constraint above; would also describe prod's version, not the agent's installed version.

**D3 — The runtime serves only a static `/llms.txt` index that points outward.**
The runtime cannot know which SDK version an agent installed, so the index links to `@latest` and instructs an installed agent to prefer its own `node_modules` copy (exactly version-matched). The response is a hardcoded constant — this is the load-bearing security property (D5).
*Alternative rejected:* no runtime route at all. Then nothing at the bare domain points an agent anywhere; the one unauthenticated discovery path is lost.

**D4 — Division of labor across channels prevents three-way drift.**
TSDoc = one-line purpose per symbol + "see `example.ts`" (no example copy). README = the non-code material (bootstrapping, deploy, gotchas). `example.ts` = the single, CI-verified copy of comprehensive code. No two channels hold the same snippet, so there is no drift surface and no drift test to maintain.

**D5 — `/llms.txt` slots into the existing `None / Intentional / Must stay non-sensitive` route class.**
It is the same security class as `/livez`. The single invariant — *the handler returns a static constant; it never reflects request input, reads owner/repo params, touches tenant data, or reads auth headers* — makes every §4 threat (cross-owner leak A12/A14, reflection, forged headers A13, auth bypass A4, DoS) N/A by construction. It inherits the baseline header set via `secureHeadersMiddleware` and satisfies `default-src 'none'` because it loads no resources. The security review is: one §4 route-table row, one §6 route-family test entry, one routing scenario — not a threat-model expansion.

**D6 — The "exercises every SDK surface" contract migrates from `demo.ts` to `example.ts`.**
`CLAUDE.md`'s `## Example workflows` section and its "SDK surface change must update demo.ts" rule are re-pointed at `example.ts`, so new surfaces land on the file that ships and is meant to be exhaustive, not on the file being narrowed. `demo.ts`'s remaining contract is "runs the runnable subset in dev + still builds."

## Risks / Trade-offs

- **`example.ts` becomes stale against the SDK surface** → CI bundle gate (D1) fails the build the moment it stops compiling; the migrated CLAUDE.md rule (D6) makes updating it part of any SDK-surface change.
- **`/llms.txt` handler is later made dynamic** (interpolating version/env) → reintroduces an information-disclosure surface. Mitigation: the spec pins it to a static constant; any dynamic content requires re-review under §4.
- **Doc-only npm churn** (CalVer patch per typo) → accepted; patches are free and nobody pins exact. The alternative (docs out of the publish gate) lets unpkg/node_modules lag, which is worse.
- **`demo.ts` narrowing drops coverage of infra-triggers from the dev fixture** → intended; those triggers move to `example.ts` where they are compile-validated. No spec currently requires `demo.ts` to exercise the full surface (the CI gate only requires it to build), so nothing breaks.
- **`/llms.txt` earns little if no agent lands on the bare domain** → it is nearly free (a static string on an existing server), so marginal benefit still clears the marginal cost.

## Migration Plan

1. Land `example.ts` + its CI bundle gate first (proves the teaching artifact compiles before anything points at it).
2. Rewrite `README.md`, add TSDoc, extend the SDK `files` list — all ship on the next SDK CalVer publish.
3. Narrow `demo.ts` and re-point the CLAUDE.md governance rule in the same change so the surface responsibility never sits nowhere.
4. Add the runtime `/llms.txt` route + its `SECURITY.md`/`http-security` test entry.
5. No rollback complexity: every artifact is additive or content-only; reverting is a plain revert with no data or schema migration.

## Open Questions

- Exact on-disk shape for `example.ts` validation: its own `src/` dir under `packages/sdk/example/` (so `buildWorkflows({cwd})` discovers it) vs. passing it explicitly via `opts.workflows`. Mechanical; resolved during apply.
- Placeholder-env wiring for the `example.ts` bundle (mirrors `demo.ts`'s build script, which sets `WEBHOOK_TOKEN`/`IMAP_USER`/`IMAP_PASSWORD` placeholders). Mechanical.
