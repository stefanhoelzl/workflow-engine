import type {
	GuestFunctionDescription,
	PluginContext,
	PluginSetup,
	RunInput,
} from "@workflow-engine/sandbox";
import { Guest } from "@workflow-engine/sandbox";
import { QUEUE_DISPATCHER_NAME } from "./descriptor-name.js";
import type { QueueHostApi } from "./host-contract.js";
import { QueueError } from "./queue-error.js";
import type {
	QueueGetResultWire,
	QueuePutResultWire,
	QueueResultWire,
	QueueRunExtras,
} from "./types.js";

// ---------------------------------------------------------------------------
// Queue worker — config-less pure transport (post queues-on-duckdb).
//
// The worker carries NO per-workflow config. All policy lives MAIN-side
// behind the `queue.put` / `queue.get` host-call handlers
// (packages/runtime/src/queue-host.ts): declared-set membership, the live
// CURRENT-manifest check, per-queue schema validation, the size/depth caps,
// and the `enqueuedAt` stamp. The worker only:
//
//   1. captures per-invocation context (repo, invocationId, triggerKind,
//      triggerName) from RunInput.extras.queue — this is per-run data that
//      cannot live in the per-sandbox host handler closure,
//   2. routes by op to the matching host method and forwards the call,
//   3. translates host-side QueueErrors back into the guest-facing
//      QueueError surface.
//
// There is intentionally no worker-side name/op validation beyond the op
// discriminator needed to pick a host method: a non-declared name (including
// path-traversal-shaped strings) is rejected MAIN-side as `queue.notDeclared`
// via declared-set membership — the name is a column value, never a path, so
// there is nothing to guard against in the worker.
// ---------------------------------------------------------------------------

interface ActiveContext {
	readonly repo: string;
	readonly invocationId: string;
	readonly triggerKind: string;
	readonly triggerName: string;
}

// Module-level per-run context. Safe because the executor serializes runs
// per sandbox (one active run at a time); mirrors the pre-migration
// `activeRepo` pattern.
let activeContext: ActiveContext | null = null;

function onBeforeRunStarted(runInput: RunInput): true | undefined {
	const extras = runInput.extras as QueueRunExtras | undefined;
	const q = extras?.queue;
	if (
		q &&
		typeof q.repo === "string" &&
		q.repo.length > 0 &&
		typeof q.invocationId === "string" &&
		q.invocationId.length > 0 &&
		typeof q.triggerKind === "string" &&
		q.triggerKind.length > 0 &&
		typeof q.triggerName === "string" &&
		q.triggerName.length > 0
	) {
		activeContext = {
			repo: q.repo,
			invocationId: q.invocationId,
			triggerKind: q.triggerKind,
			triggerName: q.triggerName,
		};
	}
	return;
}

function onRunFinished(): void {
	activeContext = null;
}

// ---------------------------------------------------------------------------
// Host-call rejection → QueueError mapping
//
// `ctx.callHost` rejects with an Error reconstructed from SerializedError;
// own JSON-safe properties (.code, .item) are re-attached as own props on
// the Error (see sandbox.ts:errorFromSerialized + serializeHostError).
// QueueErrors thrown by the host carry .name = "QueueError" and a .code in
// the QueueErrorCode union. We re-wrap into the sandbox-side QueueError so
// the guest sees the typed surface.
// ---------------------------------------------------------------------------

const QUEUE_ERROR_CODES = new Set([
	"queue.itemTooLarge",
	"queue.full",
	"queue.schemaMismatch",
	"queue.gone",
	"queue.notDeclared",
]);

function mapHostError(err: unknown): QueueError {
	if (err instanceof Error && err.name === "QueueError") {
		const code = (err as Error & { code?: unknown }).code;
		const item = (err as Error & { item?: unknown }).item;
		if (typeof code === "string" && QUEUE_ERROR_CODES.has(code)) {
			return new QueueError({
				code: code as
					| "queue.itemTooLarge"
					| "queue.full"
					| "queue.schemaMismatch"
					| "queue.gone"
					| "queue.notDeclared",
				message: err.message,
				...(item === undefined ? {} : { item }),
			});
		}
	}
	// Unrecognised host-side failure (host-call channel dropped at run end,
	// a ZodError from contract validation, etc.). Surface as queue.gone so
	// the guest sees a typed error rather than a raw transport error.
	return new QueueError({
		code: "queue.gone",
		message: err instanceof Error ? err.message : String(err),
	});
}

function requireContext(): ActiveContext {
	if (activeContext === null) {
		// The runtime always stamps extras.queue for invocations that may
		// touch queues; reaching here means the run was started without that
		// stamping (e.g. a test harness that omits it).
		throw new QueueError({
			code: "queue.notDeclared",
			message: "queue ops are unavailable in this run context",
		});
	}
	return activeContext;
}

// ---------------------------------------------------------------------------
// Dispatch — forward to the matching host method. No name/op validation
// beyond routing; the host is the sole policy authority.
// ---------------------------------------------------------------------------

async function dispatchPut(
	ctx: PluginContext<QueueHostApi>,
	active: ActiveContext,
	name: string,
	item: unknown,
): Promise<QueuePutResultWire> {
	try {
		await ctx.callHost("queue.put", [
			{
				queue: name,
				item,
				repo: active.repo,
				invocationId: active.invocationId,
				triggerKind: active.triggerKind,
				triggerName: active.triggerName,
			},
		]);
	} catch (err) {
		throw mapHostError(err);
	}
	return null;
}

async function dispatchGet(
	ctx: PluginContext<QueueHostApi>,
	active: ActiveContext,
	name: string,
): Promise<QueueGetResultWire> {
	let reply: Awaited<ReturnType<QueueHostApi["queue.get"]>>;
	try {
		reply = await ctx.callHost("queue.get", [
			{ queue: name, repo: active.repo },
		]);
	} catch (err) {
		throw mapHostError(err);
	}
	if (reply.found === false) {
		return { found: false };
	}
	return { found: true, item: reply.item };
}

// ---------------------------------------------------------------------------
// Descriptor + plugin setup
// ---------------------------------------------------------------------------

function queueDispatcherDescriptor(
	ctx: PluginContext<QueueHostApi>,
): GuestFunctionDescription {
	return {
		name: QUEUE_DISPATCHER_NAME,
		publicName: "queue",
		args: [Guest.raw()],
		result: Guest.raw(),
		handler: (async (raw: unknown) => {
			const input = (raw ?? {}) as {
				op?: unknown;
				name?: unknown;
				item?: unknown;
			};
			const name = typeof input.name === "string" ? input.name : "";
			let result: QueueResultWire;
			if (input.op === "get") {
				result = await dispatchGet(ctx, requireContext(), name);
			} else if (input.op === "put") {
				result = await dispatchPut(ctx, requireContext(), name, input.item);
			} else {
				// Tampered guest: our guest glue only ever sends put/get.
				throw new QueueError({
					code: "queue.notDeclared",
					message: 'queue input.op must be "put" or "get"',
				});
			}
			return result as unknown as Record<string, unknown>;
		}) as unknown as GuestFunctionDescription["handler"],
		log: { request: "system" },
		logName: (args) => {
			const input = args[0] as { op?: string } | undefined;
			if (input?.op === "put") {
				return "queue.put";
			}
			if (input?.op === "get") {
				return "queue.get";
			}
			return "queue";
		},
		logInput: (args) => {
			const input = args[0] as
				| { op?: string; name?: string; item?: unknown }
				| undefined;
			if (!input || typeof input !== "object") {
				return args;
			}
			const picked: Record<string, unknown> = {};
			if (typeof input.op === "string") {
				picked.op = input.op;
			}
			if (typeof input.name === "string") {
				picked.name = input.name;
			}
			// Item payloads are author-domain and intentionally NOT logged.
			// Producer metadata is not in queue.* success events; it IS in the
			// error path's SerializedError.data on queue.schemaMismatch.
			return picked;
		},
		public: false,
	};
}

function worker(ctx: PluginContext<QueueHostApi>): PluginSetup {
	return {
		guestFunctions: [queueDispatcherDescriptor(ctx)],
		onBeforeRunStarted,
		onRunFinished,
	};
}

export type { ActiveContext };
export { dispatchGet, dispatchPut, mapHostError, worker };
