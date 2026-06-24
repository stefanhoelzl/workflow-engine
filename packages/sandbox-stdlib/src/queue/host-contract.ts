// Contract module for the queue host-call channel. Values (Zod schemas) are
// imported MAIN-side only — by `packages/runtime/src/queue-host.ts` — which
// wires them through `defineHostMethod`. The worker uses `import type` against
// `QueueHostApi` so no Zod or schema values land in the worker bundle.
//
// Method names use the `queue.*` convention to match the existing system-event
// names (`queue.put`, `queue.get`) emitted via the guest descriptor's
// `log: { request: "system" }` plumbing.

import { z } from "@workflow-engine/core";

// Wire-level args for queue.put. The worker forwards the guest's queue name
// and item plus the per-invocation context it captured from RunInput.extras.
// `queue` is validated only for STRUCTURE here (it's a string); POLICY — is
// this name actually declared by the current manifest — is enforced MAIN-side
// in the handler via declared-set membership (a non-declared name, including
// path-traversal-shaped strings, is rejected as queue.notDeclared). The name
// is a column value, never a path, so no regex guard is needed on the wire.
// `enqueuedAt` is NOT on the wire: the host stamps it at INSERT time so it is
// monotonic with the row's seq.
const queuePutArgsSchema = z.tuple([
	z.object({
		queue: z.string(),
		repo: z.string(),
		invocationId: z.string(),
		triggerKind: z.string(),
		triggerName: z.string(),
		// The item is opaque to the bridge; per-queue schema validation runs
		// MAIN-side inside the handler against the manifest validators.
		item: z.unknown(),
	}),
]);

// queue.put has no payload to return; null on the wire is the no-result marker.
const queuePutResultSchema = z.null();

const queueGetArgsSchema = z.tuple([
	z.object({
		queue: z.string(),
		repo: z.string(),
	}),
]);

// queue.get returns either an empty marker or the popped item value. Producer
// metadata is INTENTIONALLY not surfaced to guest get() (see queues-on-duckdb
// design decision D / G). It IS embedded in the schema-mismatch error payload
// (decision I) — that crosses via SerializedError.data, not via this result.
const queueGetResultSchema = z.discriminatedUnion("found", [
	z.object({ found: z.literal(false) }),
	z.object({ found: z.literal(true), item: z.unknown() }),
]);

const queuePutContract = {
	args: queuePutArgsSchema,
	result: queuePutResultSchema,
} as const;

const queueGetContract = {
	args: queueGetArgsSchema,
	result: queueGetResultSchema,
} as const;

// The HostApi shape the worker sees. The runtime imports the schema VALUES;
// the worker uses `import type { QueueHostApi } from "./host-contract.js"` to
// type `ctx.callHost`. Declared as a `type` (not an interface) so it
// satisfies the `HostApiShape = Record<string, (args: never) => Promise<unknown>>`
// constraint on `PluginContext<HostApi>` (interfaces lack the implicit string
// index that the constraint requires).
// biome-ignore lint/style/useConsistentTypeDefinitions: must be a type alias to satisfy the HostApiShape Record<string, ...> constraint; interfaces do not have an implicit string-index signature
type QueueHostApi = {
	"queue.put": (
		args: z.infer<typeof queuePutArgsSchema>,
	) => Promise<z.infer<typeof queuePutResultSchema>>;
	"queue.get": (
		args: z.infer<typeof queueGetArgsSchema>,
	) => Promise<z.infer<typeof queueGetResultSchema>>;
};

export type { QueueHostApi };
export { queueGetContract, queuePutContract };
