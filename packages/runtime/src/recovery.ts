import type { EventBus, FailedEvent } from "./event-bus/index.js";
import { scanPending } from "./event-bus/persistence.js";
import type { StorageBackend } from "./storage/index.js";

// ---------------------------------------------------------------------------
// Recovery — one-shot startup sweep
// ---------------------------------------------------------------------------
//
// For each file in `pending/` left behind by a prior process death, emit a
// `failed` lifecycle event carrying `{ kind: "engine_crashed" }`. The
// persistence consumer moves the pending record to the archive; the
// event-store consumer updates its index; the logging consumer logs it.
// Once this returns, the HTTP server may bind — no webhook traffic should
// be admitted before this completes (D13).

interface RecoveryDeps {
	readonly backend: StorageBackend;
}

async function recover(
	persistence: RecoveryDeps,
	bus: EventBus,
): Promise<void> {
	for await (const record of scanPending(persistence.backend)) {
		const startedAt = parseIsoDate(record.startedAt);
		const failedEvent: FailedEvent = {
			kind: "failed",
			id: record.id,
			workflow: record.workflow,
			trigger: record.trigger,
			ts: startedAt,
			error: { kind: "engine_crashed" },
		};
		// Sequential emission so persistence's `remove(pending)` sees the
		// pending file exist for each iteration — a parallel fan-out would
		// race with `scanPending`'s iteration in some backends.
		await bus.emit(failedEvent);
	}
}

function parseIsoDate(iso: string): Date {
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) {
		return new Date();
	}
	return parsed;
}

export type { RecoveryDeps };
export { recover };
