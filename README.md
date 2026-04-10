# Workflow Engine

A lightweight, event-driven workflow automation service. Define workflows as TypeScript, wire triggers to actions, and let the engine handle event routing, fan-out, and persistence. User code runs in a sandboxed QuickJS WASM context.

## Defining a Workflow

```typescript
// workflows/example.ts
import { createWorkflow, z, http, env } from "@workflow-engine/sdk";

const workflow = createWorkflow()
  .trigger("webhook.order", http({
    path: "order",
    body: z.object({ orderId: z.string() }),
    response: { status: 202 },
  }))
  .event("order.processed", z.object({
    orderId: z.string(),
    total: z.number(),
  }));

export const processOrder = workflow.action({
  on: "webhook.order",
  emits: ["order.processed"],
  env: { API_URL: env() },
  handler: async (ctx) => {
    const { body } = ctx.event.payload;
    const res = await ctx.fetch(`${ctx.env.API_URL}/orders/${body.orderId}`);
    const data = await res.json();
    await ctx.emit("order.processed", {
      orderId: body.orderId,
      total: data.total,
    });
  },
});

export default workflow;
```

Triggers receive HTTP requests and emit typed events. Actions subscribe to events and may emit new ones. Zod schemas provide compile-time type safety and runtime validation.

## Getting Started

```bash
pnpm install
pnpm build
pnpm start
```

This builds the runtime and workflows, then starts the server with `WORKFLOW_DIR` pointing at the built output.

Trigger a workflow:

```bash
curl -X POST http://localhost:8080/webhooks/order \
  -H 'Content-Type: application/json' \
  -d '{"orderId": "abc-123"}'
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `WORKFLOW_DIR` | — | Path to built workflow artifacts |
| `PERSISTENCE_PATH` | — | Filesystem persistence directory |
| `PERSISTENCE_S3_BUCKET` | — | S3 bucket for persistence |
| `LOG_LEVEL` | `info` | Log level (trace/debug/info/warn/error) |

## Development

```bash
pnpm lint      # Biome linter
pnpm check     # TypeScript type checking
pnpm test      # Vitest test suite
pnpm build     # Build runtime + workflows
pnpm start     # Build workflows and start
```

## Project Structure

```
packages/
├── sdk/          # Workflow DSL + types
├── vite-plugin/  # Build-time workflow compiler
└── runtime/      # Event bus, scheduler, sandbox
workflows/        # User-defined workflows
```
