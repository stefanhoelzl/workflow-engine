# Workflow Engine

A lightweight workflow automation service for service wiring. Define workflows as TypeScript; wire triggers to actions via direct typed function calls (no events, no `emit()`, no fan-out at the engine level). User-provided action code runs in a sandboxed QuickJS WASM context — one sandbox per workflow, reused across invocations. For HTTP triggers the handler's return value IS the HTTP response.

## Defining a Workflow

```typescript
// workflows/src/orders.ts
import {
  action,
  defineWorkflow,
  env,
  httpTrigger,
  z,
} from "@workflow-engine/sdk";

export const workflow = defineWorkflow({
  env: {
    API_URL: env(),
  },
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
  request: {
    body: z.object({ orderId: z.string() }),
  },
  response: {
    body: z.object({ orderId: z.string(), total: z.number() }),
  },
  handler: async ({ body }) => {
    const result = await processOrder({ orderId: body.orderId });
    return { status: 202, body: result };
  },
});
```

`defineWorkflow({env})` declares the workflow's environment contract; values are injected at runtime and read via `workflow.env.*`. `action({input, output, handler})` defines a typed callable that other actions or triggers can invoke directly (e.g. `await processOrder({orderId})`). Trigger factories (`httpTrigger`, `cronTrigger`, `manualTrigger`) wire ingress into the workflow.

`httpTrigger` config is grouped: `request: {body, headers}` validates ingress, `response: {body, headers}` validates egress. When `response.body` is set the handler MUST return a `body` matching the schema; without it the handler may return any partial `{status?, body?, headers?}` shape — for example `handler: async () => ({status: 202})` is valid for fire-and-forget webhooks. `@workflow-engine/sdk` also exposes a programmatic CLI at `@workflow-engine/sdk/cli` (`build`, `upload`) for custom dev/release scripts.

The canonical full-surface reference workflow lives at [`packages/sdk/example.ts`](packages/sdk/example.ts) and exercises every SDK surface — `httpTrigger` (GET/POST), `cronTrigger`, `manualTrigger`, `imapTrigger`, `wsTrigger`, action composition, `defineQueue`, `executeSql`, `secret()`, `sendMail()`, environment variables, and the sandbox-stdlib `fetch` / `crypto` / `setTimeout` / `URL` / `console` / `EventTarget` / `AbortController` / `scheduler` / `Observable` globals. It ships in the npm package (readable at `unpkg.com/@workflow-engine/sdk@latest/example.ts`) and is bundle-validated in CI. [`workflows/src/demo.ts`](workflows/src/demo.ts) is the runnable `pnpm dev` fixture — the same surface minus `imapTrigger` (dev starts no IMAP server).

## Getting Started

```bash
pnpm install
pnpm build
pnpm dev
```

`pnpm dev` boots the runtime on a random port (or `PORT`), watches sources, and auto-uploads `workflows/src/demo.ts` so the dashboard has data on first boot. Workflows do not bootstrap from disk — upload your tenant's bundle with the `wfe` CLI.

```bash
# Uploads the bundle for the current `git remote get-url origin` repo.
GITHUB_TOKEN=<gh-token> pnpm exec wfe upload
```

The CLI defaults to `https://workflow-engine.stho.net` and infers `--repo <owner>/<name>` from `git remote get-url origin`. CLI options:

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <owner>/<name>` | parsed from `origin` remote | Target repo. Required if not in a github.com checkout. |
| `--url <url>` | `https://workflow-engine.stho.net` | Runtime base URL. Pass `http://localhost:8080` for local dev. |
| `--token <ghp_…>` | `$GITHUB_TOKEN` | GitHub personal access token. |

For local-provider auth (against a server with `LOCAL_DEPLOYMENT=1`) substitute `--user <name>` for `--token`. `--user`, `--token`, and `GITHUB_TOKEN` are mutually exclusive — see `SECURITY.md` §4 "CLI authentication".

Trigger an HTTP workflow:

```bash
curl -X POST http://localhost:8080/webhooks/<owner>/<repo>/<workflow-name>/<trigger-export-name> \
  -H 'Content-Type: application/json' \
  -d '{"orderId": "abc-123"}'
```

`<trigger-export-name>` is the JavaScript export name of the `httpTrigger` in the workflow source. For the example above (`export const order = httpTrigger({...})` in `workflows/src/orders.ts`) the URL is `/webhooks/<owner>/<repo>/orders/order`. Webhook routes are derived mechanically from the export name; `httpTrigger` does not accept a `path` config field.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `PERSISTENCE_PATH` | — | Filesystem persistence directory (also hosts tenant bundles at `workflows/<owner>/<repo>.tar.gz`) |
| `LOG_LEVEL` | `info` | Log level (trace/debug/info/warn/error) |

See `openspec/project.md` for the full runtime-config surface (all env vars, defaults, and cross-references to the runtime-config spec) and `docs/infrastructure.md` for the deployment topology.

## Development

```bash
pnpm lint             # Biome linter
pnpm check            # TypeScript type checking
pnpm test             # Vitest test suite (unit + integration, excludes WPT)
pnpm test:wpt         # WPT compliance suite (separate from `pnpm test`)
pnpm test:wpt:refresh # Regenerate packages/sandbox-stdlib/test/wpt/vendor/ from upstream WPT
pnpm build            # Build workspaces (runtime + sandbox via vite, sdk via tsc)
pnpm start            # pnpm build && pnpm dev (builds, then boots dev runtime)
pnpm validate         # lint + type check + test + tofu fmt/validate (run before commit; excludes WPT)
```

## Project Structure

```
packages/
├── core/            # Shared contract types (manifest schemas, trigger payloads, event types, Zod v4 re-export)
├── sdk/             # Workflow DSL + types + `wfe` CLI (`./` and `./cli` exports)
├── sandbox/         # QuickJS host + plugin composition
├── sandbox-stdlib/  # Web-platform / fetch / timers / console plugins
├── runtime/         # HTTP server + executor + workflow registry + sandbox store + action-dispatch plugin
└── tests/           # End-to-end suite (real runtime spawn + CLI upload)
workflows/           # User-defined workflows (canonical demo at `src/demo.ts`)
infrastructure/      # OpenTofu IaC — single flat project: prod & staging on bunny.net Magic Containers (state on Scaleway Object Storage)
```
