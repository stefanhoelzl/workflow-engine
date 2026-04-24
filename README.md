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
  body: z.object({ orderId: z.string() }),
  responseBody: z.object({ orderId: z.string(), total: z.number() }),
  handler: async ({ body }) => {
    const result = await processOrder({ orderId: body.orderId });
    return { status: 202, body: result };
  },
});
```

`defineWorkflow({env})` declares the workflow's environment contract; values are injected at runtime and read via `workflow.env.*`. `action({input, output, handler})` defines a typed callable that other actions or triggers can invoke directly (e.g. `await processOrder({orderId})`). Trigger factories (`httpTrigger`, `cronTrigger`, `manualTrigger`) wire ingress into the workflow.

The optional `responseBody: z.ZodSchema` on `httpTrigger` makes the response `body` field required and validates it against the schema. Without `responseBody`, the handler may return any partial `{status?, body?, headers?}` shape — for example `handler: async () => ({status: 202})` is valid for fire-and-forget webhooks.

The canonical reference workflow lives at [`workflows/src/demo.ts`](workflows/src/demo.ts) and exercises every SDK surface (`httpTrigger` GET/POST, `cronTrigger`, `manualTrigger`, action composition, environment variables, and the sandbox-stdlib `fetch` / `crypto` / `setTimeout` / `URL` / `console` globals).

### SDK subpath exports

`@workflow-engine/sdk` ships three additional entry points alongside the root DSL:

| Subpath | Purpose | Typical caller |
|---------|---------|----------------|
| `@workflow-engine/sdk` | Authoring DSL: `defineWorkflow`, `action`, `httpTrigger`, `cronTrigger`, `manualTrigger`, `env`, `z` | Workflow source files |
| `@workflow-engine/sdk/plugin` | Vite plugin (`workflowPlugin`) used to bundle workflows into a tarball | `vite.config.ts` (built-in via `wfe upload`) |
| `@workflow-engine/sdk/cli` | Programmatic CLI: `build`, `upload`, `NoWorkflowsFoundError`, `UploadOptions`, `UploadResult` | Custom dev/release scripts (e.g. `scripts/dev.ts`) |
| `@workflow-engine/sdk/sdk-support` | Sandbox plugin (`createSdkSupportPlugin`) that wires the action dispatcher inside the guest | Runtime sandbox composition |

## Getting Started

```bash
pnpm install
pnpm build
pnpm start
```

This builds the runtime and starts the server. Workflows no longer bootstrap from disk — upload your tenant's bundle with the `wfe` CLI once the server is reachable.

```bash
# Local dev (built-in local auth provider, no GitHub token required):
pnpm exec wfe upload --tenant <name> --url http://localhost:8080 --user <name>

# Production (default URL https://workflow-engine.webredirect.org):
GITHUB_TOKEN=<gh-token> pnpm exec wfe upload --tenant <name>
```

CLI options:

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <name>` | `$WFE_TENANT` | Target tenant. Required (flag or env var). |
| `--url <url>` | `https://workflow-engine.webredirect.org` | Runtime base URL. Pass `http://localhost:8080` for local dev. |
| `--user <name>` | — | Local-provider user. Mutually exclusive with `GITHUB_TOKEN`. |
| `GITHUB_TOKEN` (env) | — | GitHub personal access token for the prod GitHub auth provider. Mutually exclusive with `--user`. |

Trigger an HTTP workflow:

```bash
curl -X POST http://localhost:8080/webhooks/<tenant>/<workflow-name>/<trigger-export-name> \
  -H 'Content-Type: application/json' \
  -d '{"orderId": "abc-123"}'
```

`<trigger-export-name>` is the JavaScript export name of the `httpTrigger` in the workflow source. For the example above (`export const order = httpTrigger({...})` in `workflows/src/orders.ts`) the URL would be `/webhooks/<tenant>/orders/order`. Webhook routes are derived mechanically from the export name; `httpTrigger` does not accept a `path` config field.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `PERSISTENCE_PATH` | — | Filesystem persistence directory (also hosts tenant bundles at `workflows/<tenant>.tar.gz`) |
| `PERSISTENCE_S3_BUCKET` | — | S3 bucket for persistence |
| `LOG_LEVEL` | `info` | Log level (trace/debug/info/warn/error) |

`PERSISTENCE_PATH` and `PERSISTENCE_S3_BUCKET` are mutually exclusive — exactly one SHALL be set. See `openspec/project.md` for the full runtime-config surface (all env vars, their defaults, and cross-references to the runtime-config spec) and `docs/infrastructure.md` ("Storage backend selection") for the S3 credential-injection flow.

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
├── sdk/             # Workflow DSL + types + vite plugin + sdk-support plugin
├── sandbox/         # QuickJS host + plugin composition
├── sandbox-stdlib/  # Web-platform / fetch / timers / console plugins
└── runtime/         # HTTP server + executor + workflow registry + sandbox store
workflows/           # User-defined workflows
infrastructure/      # OpenTofu IaC (modules + local/persistence/cluster/prod/staging environments)
```
