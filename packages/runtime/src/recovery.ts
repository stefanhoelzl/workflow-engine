import type { InvocationEvent } from "@workflow-engine/core";
import type { EventBus } from "./event-bus/index.js";
import { scanPending } from "./event-bus/persistence.js";
import type { StorageBackend } from "./storage/index.js";

// ---------------------------------------------------------------------------
// Recovery — one-shot startup sweep
// ---------------------------------------------------------------------------
//
// For each invocation id with files in `pending/` left behind by a prior
// process death, replay the existing events to the bus, then synthesize a
// `trigger.error` carrying `{ kind: "engine_crashed" }` so persistence moves
// the files to the archive and the event store records a terminal state.

interface RecoveryDeps {
	readonly backend: StorageBackend;
}

async function recover(
	persistence: RecoveryDeps,
	bus: EventBus,
): Promise<void> {
	// Collect all pending events grouped by invocation id.
	const byId = new Map<string, InvocationEvent[]>();
	for await (const event of scanPending(persistence.backend)) {
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

		// Replay each existing event to the bus so consumers (event store) see
		// the full history before the synthetic terminal event.
		for (const event of events) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential emission preserves seq ordering across consumers
			await bus.emit(event);
		}

		const lastSeq = events.at(-1)?.seq ?? -1;
		const synthetic: InvocationEvent = {
			kind: "trigger.error",
			id,
			seq: lastSeq + 1,
			ref: 0,
			ts: Date.now(),
			workflow: firstEvent.workflow,
			workflowSha: firstEvent.workflowSha,
			name: firstEvent.name,
			error: {
				message: "engine crashed before invocation completed",
				stack: "",
				...({ kind: "engine_crashed" } as Record<string, unknown>),
			},
		};
		await bus.emit(synthetic);
	}
}

export type { RecoveryDeps };
export { recover };
