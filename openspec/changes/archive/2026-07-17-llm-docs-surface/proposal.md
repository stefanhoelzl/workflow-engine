## Why

Agents are increasingly the ones authoring and deploying workflows, but the SDK's npm README is effectively empty (28 chars) and there is no agent-facing entry point at all: nothing on hover, nothing at the domain root, no comprehensive worked example. An agent handed only a URL, or dropped into a fresh workflows repo, has to reverse-engineer the SDK surface, the strict-typecheck gotchas, and the deploy path from scratch — and gets them subtly wrong.

## What Changes

- **Comprehensive `example.ts` shipped in the SDK tarball.** A single, heavily-docstring'd workflow that exercises every SDK surface (all trigger kinds, action composition, `env`/`secret`, `defineQueue`, `executeSql`, `sendMail`, sandbox-stdlib globals). It is **bundle-validated in CI (never uploaded)** — `wfe build` typechecks + bundles it against the real SDK types, so it can hold surfaces that cannot *run* without infra (`imapTrigger`, `wsTrigger`) yet are proven to *compile*.
- **Agent-facing SDK `README.md`.** Fills the empty npm page with bootstrapping content: minimal `package.json`, install, `wfe build`/`upload`, the CI deploy path, and the non-code gotchas — chief among them that `wfe build` **ignores the user's tsconfig** and enforces its own strict options, so a lax editor config passes locally then fails the build.
- **TSDoc + `@example` on every SDK export.** The one channel that reaches an agent with zero opt-in (LSP hover/completion), ships automatically in the `.d.ts`, and is exactly version-matched. Kept terse — one line of purpose per symbol plus a pointer to `example.ts`, not a second copy of it.
- **Runtime `GET /llms.txt` index.** A tiny, static, public index served at the domain root that points agents at the version-matched docs on unpkg (`@latest`) and tells an already-installed agent to prefer its `node_modules/@workflow-engine/sdk/` copy.
- **`demo.ts` narrows to the runnable subset.** The `pnpm dev` fixture drops the triggers that cannot execute in local dev; the "exercises every SDK surface" responsibility migrates to `example.ts`. `demo.ts` remains a CI build gate.

## Capabilities

### New Capabilities
- `llm-docs`: The agent-facing documentation surface — the shipped `example.ts` (comprehensive, bundle-validated, never uploaded), the agent-facing SDK `README.md`, TSDoc-on-exports, and the content + placement contract for the `/llms.txt` index. Owns *what the docs are and how they stay true*; the HTTP-route mechanics live in the modified capabilities below.

### Modified Capabilities
- `http-server`: new requirement — serve `GET /llms.txt` as a public, static route, mounted ahead of the 404 catch-all and not shadowed by the root redirect or `/static/*`.
- `http-security`: `/llms.txt` joins the enumerated public route-family list that the baseline-header integration test asserts against; it inherits the standard header set and satisfies `default-src 'none'` trivially (loads no resources).
- `ci-workflow`: new gate — `example.ts` is bundle-validated (typecheck + bundle, no upload) and a broken `example.ts` fails the build; `demo.ts` remains a build gate as the runnable subset.

## Impact

- **New/changed files:** `packages/sdk/example/example.ts` (new), `packages/sdk/README.md` (rewrite), `packages/sdk/src/index.ts` (TSDoc on exports), `packages/sdk/package.json` (`files` includes the example + README), `packages/runtime/src/**` (a `/llms.txt` handler + its content), `workflows/src/demo.ts` (narrowed), CI workflow (example bundle gate).
- **Governance:** `CLAUDE.md`'s `## Example workflows` section and its "SDK surface change must update demo.ts" rule re-point at `example.ts`; `openspec/project.md` gains a note on the example/demo split.
- **Security:** one new public-by-design route in the `None / Intentional / Must stay non-sensitive` class (§4 route table). The load-bearing invariant is that the handler returns a static constant — no request-input reflection, no owner/repo params, no tenant data, no auth-header reads — which makes every §4 threat N/A by construction.
- **Release cadence:** doc-only edits cut a CalVer patch of `@workflow-engine/sdk` (accepted) so the npm/unpkg copies never lag.
- **No sandbox-boundary, EventBus, or manifest-format changes.**
