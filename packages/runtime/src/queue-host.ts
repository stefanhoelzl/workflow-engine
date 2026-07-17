import type { z } from "@workflow-engine/core";
import type { HostHandlers } from "@workflow-engine/sandbox";
import {
	queueGetContract,
	queuePutContract,
} from "../../sandbox-stdlib/src/queue/host-contract.js";
import { defineHostMethod } from "./host-call.js";
import {
	MAX_KEY_BYTES,
	QueueError,
	type QueueScope,
	type QueueStore,
} from "./queue-store.js";

// Reject an over-long partition key before any statement touches the store.
// The key is a column value (never a path), so only the length bound applies;
// it is independent of the per-item size cap. Enforced host-side so a tampered
// guest cannot bypass it.
function assertKeyWithinCap(queue: string, key: string): void {
	if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
		throw new QueueError(
			"queue.keyTooLarge",
			`queue "${queue}" key exceeds size cap: ${String(Buffer.byteLength(key, "utf8"))} > ${String(MAX_KEY_BYTES)} bytes`,
		);
	}
}

// ---------------------------------------------------------------------------
// queue-host — per-sandbox host handlers for `queue.put` and `queue.get`.
//
// Per R-15 (SECURITY.md): handler closures bind `(owner, workflow)` at
// sandbox construction; `repo` and producer metadata are caller-supplied per
// invocation (forwarded from the executor via RunInput.extras). The handler
// does NOT widen the closure-captured scope from caller args.
//
// There is NO runtime queue-name gate. The queue name is the only
// guest-controlled component of the storage key; `owner`/`repo`/`workflow`
// are host-stamped, so a guest can only ever address its own tenant's
// partition. Confidentiality/cross-tenant isolation therefore does not
// depend on a name check. Total storage is bounded MAIN-side by the
// workflow-wide depth cap in queue-store (see MAX_WORKFLOW_QUEUE_DEPTH), so
// a tampered guest inventing undeclared names cannot amplify storage.
//
// Schema validation is applied only to DECLARED queues — those with a
// validator in the per-sandbox `validators` map (keyed by name, rehydrated
// from the manifest at construction). The SDK statically binds authors to
// declared handles, so every legitimate put/get hits a declared queue and
// is validated. A name with no validator is reachable only by a tampered
// guest; such items are stored/returned without schema validation (they
// pollute only the guest's own partition, bounded by the cap, GC'd by boot
// reconciliation).
//
// QueueError flows unchanged across the worker→main→worker host-call
// boundary: own enumerable properties (`code`, `item?`) are captured by
// sandbox.ts:serializeHostError into SerializedError.data and re-attached on
// the worker side.
// ---------------------------------------------------------------------------

interface BuildQueueHostHandlersOptions {
	readonly owner: string;
	readonly workflow: string;
	// Per-queue Zod validators rehydrated from the manifest's JSON schemas,
	// keyed by queue name. A name absent from this map is "undeclared" — it
	// is accepted (no gate) but stored/returned without schema validation.
	readonly validators: ReadonlyMap<string, z.ZodType<unknown>>;
	readonly queueStore: QueueStore;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups the two host-method handlers that share the closure-captured (owner, workflow, validators, queueStore) — splitting would force the trust-boundary fields into module state
function buildQueueHostHandlers(
	options: BuildQueueHostHandlersOptions,
): HostHandlers {
	const { owner, workflow, validators, queueStore } = options;

	const putHandler = defineHostMethod(
		"queue.put",
		queuePutContract,
		async ([args]) => {
			assertKeyWithinCap(args.queue, args.key);
			// Schema validation for declared queues only. An undeclared name
			// (tampered guest) has no validator; store the item as-is.
			const validator = validators.get(args.queue);
			let data: unknown = args.item;
			if (validator) {
				const parsed = validator.safeParse(args.item);
				if (!parsed.success) {
					throw new QueueError(
						"queue.schemaMismatch",
						`queue "${args.queue}" put: schema validation failed`,
					);
				}
				data = parsed.data;
			}

			const scope: QueueScope = {
				owner,
				repo: args.repo,
				workflow,
				queue: args.queue,
			};
			// queueStore.put stamps enqueuedAt at INSERT and enforces the
			// workflow-wide depth cap; it may throw QueueError (cap/size) —
			// let it propagate, same class, same wire round-trip.
			await queueStore.put(scope, data, args.key, {
				enqueuedAt: new Date(),
				invocationId: args.invocationId,
				triggerKind: args.triggerKind,
				triggerName: args.triggerName,
			});
			return null;
		},
	);

	const getHandler = defineHostMethod(
		"queue.get",
		queueGetContract,
		async ([args]) => {
			assertKeyWithinCap(args.queue, args.key);
			const scope: QueueScope = {
				owner,
				repo: args.repo,
				workflow,
				queue: args.queue,
			};
			const popped = await queueStore.get(scope, args.key);
			if (popped === undefined) {
				return { found: false as const };
			}

			// Schema-on-get for declared queues only. Validation runs AFTER
			// the DELETE commits (spec: bad item dropped); the row is gone
			// regardless of outcome. Undeclared names have no validator —
			// return the popped item as-is.
			const validator = validators.get(args.queue);
			if (validator) {
				const parsed = validator.safeParse(popped.item);
				if (!parsed.success) {
					throw new QueueError(
						"queue.schemaMismatch",
						`queue "${args.queue}" get: popped item failed schema validation`,
						popped.item,
					);
				}
				return { found: true as const, item: parsed.data };
			}
			return { found: true as const, item: popped.item };
		},
	);

	return { ...putHandler, ...getHandler };
}

export type { BuildQueueHostHandlersOptions };
export { buildQueueHostHandlers };
