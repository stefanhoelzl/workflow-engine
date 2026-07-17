# @workflow-engine/sdk

SDK for authoring **workflow-engine** workflows: define triggers and actions as
TypeScript, wire them with direct typed function calls, and deploy with the
bundled `wfe` CLI. User action code runs in a sandboxed QuickJS WASM context —
one sandbox per workflow. For HTTP triggers the handler's return value IS the
HTTP response.

> **Writing workflows with an LLM agent?** The complete, always-current
> reference is [`example.ts`](./example.ts) — a single file that exercises
> every SDK surface with explanatory comments. Read it from your installed copy
> at `node_modules/@workflow-engine/sdk/example.ts` (exactly version-matched to
> the SDK you're building against), or over HTTP at
> `https://unpkg.com/@workflow-engine/sdk@latest/example.ts`.

## Bootstrapping a workflows project

A workflows project is a tiny npm package. Minimal `package.json`:

```json
{
  "name": "workflows",
  "type": "module",
  "private": true,
  "scripts": { "build": "wfe build" },
  "dependencies": { "@workflow-engine/sdk": "latest" }
}
```

Minimal `tsconfig.json` (for your editor; see the gotcha below):

```json
{
  "compilerOptions": {
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2025",
    "noEmit": true
  },
  "include": ["src"]
}
```

Put one workflow per file under `src/`. Each file exports exactly one
`defineWorkflow(...)`, zero or more `action(...)`, and one or more triggers.

## Defining a workflow

```typescript
// src/orders.ts
import { action, defineWorkflow, env, httpTrigger, z } from "@workflow-engine/sdk";

export const workflow = defineWorkflow({
  env: { API_URL: env() },
});

export const processOrder = action({
  input: z.object({ orderId: z.string() }),
  output: z.object({ orderId: z.string(), total: z.number() }),
  handler: async ({ orderId }) => {
    const res = await fetch(`${workflow.env.API_URL}/orders/${orderId}`);
    const data = (await res.json()) as { total: number };
    return { orderId, total: data.total };
  },
});

export const order = httpTrigger({
  method: "POST",
  request: { body: z.object({ orderId: z.string() }) },
  response: { body: z.object({ orderId: z.string(), total: z.number() }) },
  handler: async ({ body }) => {
    const result = await processOrder({ orderId: body.orderId });
    return { status: 202, body: result };
  },
});
```

See [`example.ts`](./example.ts) for every trigger kind (`httpTrigger`,
`cronTrigger`, `manualTrigger`, `imapTrigger`, `wsTrigger`), action composition,
`env`/`secret`, `defineQueue`, `executeSql`, `sendMail`, and the sandbox-stdlib
globals (`fetch`, `crypto`, `setTimeout`, `URL`, `EventTarget`,
`AbortController`, `scheduler`, `Observable`).

## Authoring rules the build enforces

**`wfe build` uses its own strict TypeScript options and ignores your
`tsconfig.json`.** Your editor reads your tsconfig; the build does not. If your
editor config is laxer than the build's, code can look fine in the editor and
then fail `wfe build`. The build always enforces:

- **`z.exactOptional(...)`, not `.optional()`**, for optional object fields
  (`exactOptionalPropertyTypes` is on).
- **`z.unknown()` (not `z.void()`/`z.undefined()`)** for actions with no return
  value — `z.void()` has no JSON Schema representation and is rejected.
- **Explicit `.js` extensions** on all relative imports (`verbatimModuleSyntax`).
- `strict` + `noUncheckedIndexedAccess`.

## Building and deploying

```bash
wfe build                 # typecheck + bundle each src/*.ts to dist/<name>.js
wfe upload --owner <name> # bundle in-memory, seal secrets, POST to the server
```

`wfe build` writes per-workflow `dist/<name>.js` and never uploads. `wfe upload`
produces the deployable tarball in-memory (sealed against the server's public
key) and POSTs it — no unsealed bundle ever touches disk. Authenticate with
`--token <ghp_…>` (or `GITHUB_TOKEN`), or `--user <name>` against a
local-provider server. See `wfe upload --help` for target-URL and auth flags.

**Deploying from CI:** the common shape is a CI job that runs `wfe build` on
every PR (as a validation gate) and `wfe upload` on merge to your deploy branch,
with the auth token supplied as a CI secret. If you don't deploy from CI, run
`wfe upload` from a trusted machine.

## Programmatic CLI

`@workflow-engine/sdk/cli` exposes `build` and `upload` for custom dev/release
scripts.
