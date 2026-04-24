import type { InvocationEvent } from "@workflow-engine/core";
import type { EventStore } from "./event-bus/event-store.js";
import type { EventBus } from "./event-bus/index.js";
import { pendingPrefix, scanPending } from "./event-bus/persistence.js";
import type { StorageBackend } from "./storage/index.js";

// ---------------------------------------------------------------------------
// Recovery — one-shot startup sweep
// ---------------------------------------------------------------------------
//
// Runs after the EventStore has bootstrapped from the archive. For each id
// with pending files left behind by a prior process death:
//
//   - if the event store already has events for that id, the archive is
//     authoritative (prior process crashed during pending cleanup). Clear
//     the stale pending prefix; do not replay.
//   - otherwise the prior process crashed mid-invocation. Replay events to
//     the bus in seq order, then emit a synthetic `trigger.error` carrying
//     `{ kind: "engine_crashed" }`. Persistence then archives and cleans up
//     as part of its normal terminal-event handling.

interface RecoveryDeps {
	readonly backend: StorageBackend;
	readonly eventStore: EventStore;
	readonly logger?: {
		info(msg: string, data: Record<string, unknown>): void;
	};
}

async function isArchived(
	eventStore: EventStore,
	id: string,
	owner: string,
): Promise<boolean> {
	const rows = await eventStore
		.query(owner)
		.where("id", "=", id)
		.select("id")
		.limit(1)
		.execute();
	return rows.length > 0;
}

function buildSyntheticTerminal(
	id: string,
	events: InvocationEvent[],
): InvocationEvent {
	const lastEvent = events.at(-1);
	const lastSeq = lastEvent?.seq ?? -1;
	// events.length > 0 is guaranteed by the caller (firstEvent check above).
	// biome-ignore lint/style/noNonNullAssertion: caller guarantees at least one event
	const firstEvent = events[0]!;
	return {
		kind: "trigger.error",
		id,
		seq: lastSeq + 1,
		// Synthetic terminals have no paired request — recovery is not a
		// response to any emitted request. `null` matches the `SandboxEvent`
		// convention for unpaired events; see recovery/spec.md.
		ref: null,
		at: new Date().toISOString(),
		ts: lastEvent?.ts ?? 0,
		owner: firstEvent.owner,
		workflow: firstEvent.workflow,
		workflowSha: firstEvent.workflowSha,
		name: firstEvent.name,
		error: {
			message: "engine crashed before invocation completed",
			stack: "",
			kind: "engine_crashed",
		},
	};
}

async function recover(deps: RecoveryDeps, bus: EventBus): Promise<void> {
	const byId = new Map<string, InvocationEvent[]>();
	for await (const event of scanPending(deps.backend)) {
		const list = byId.get(event.id) ?? [];
		list.push(event);
		byId.set(event.id, list);
	}

	for (const [id, events] of byId) {
		events.sort((a, b) => a.seq - b.seq);
		const firstEvent = events[0];
		if (!firstEvent) {
			continue;
		}

		// ids are globally unique (UUID + (id, seq) PK); scoping isArchived by
		// firstEvent.owner is correctness-equivalent to an unscoped lookup here.
		// biome-ignore lint/performance/noAwaitInLoops: per-id decision must complete before advancing to next id so side effects (bus emits, pending cleanup) stay correctly ordered
		if (await isArchived(deps.eventStore, id, firstEvent.owner)) {
			// Archive is authoritative (crash during pending cleanup). Drop the
			// stale pending files; do not replay.
			deps.logger?.info("runtime.recovery.archive-cleanup", {
				id,
				count: events.length,
			});
			await deps.backend.removePrefix(pendingPrefix(id));
			continue;
		}

		// Crash mid-invocation. Replay pending events through the bus so
		// consumers (event store, persistence) see the full history, then
		// emit a synthetic terminal so persistence archives and cleans up.
		for (const event of events) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential emission preserves seq ordering across consumers
			await bus.emit(event);
		}

		await bus.emit(buildSyntheticTerminal(id, events));
	}
}

export type { RecoveryDeps };
export { recover };
