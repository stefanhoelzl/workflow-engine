import type { HttpTriggerResult } from "@workflow-engine/sdk";

// ---------------------------------------------------------------------------
// Invocation lifecycle events
// ---------------------------------------------------------------------------
//
// The bus carries a single discriminated union of lifecycle events — one
// member per transition (started / completed / failed). These events are the
// only thing that flows through the bus in v1; RuntimeEvent (the v0 append-
// only state-transition record) is gone.

interface SerializedErrorPayload {
	// Normal handler failures carry { message, stack } (plus optional structured
	// extras like Zod `issues`); recovery sweeps produce { kind: "engine_crashed" }
	// for pending invocations left behind by a prior process death. The union
	// stays open to admit future error shapes without widening the type.
	readonly kind?: string;
	readonly message?: string;
	readonly stack?: string;
	readonly issues?: unknown;
	readonly [extra: string]: unknown;
}

interface StartedEvent {
	readonly kind: "started";
	readonly id: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly ts: Date;
	readonly input: unknown;
}

interface CompletedEvent {
	readonly kind: "completed";
	readonly id: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly ts: Date;
	readonly result: HttpTriggerResult;
}

interface FailedEvent {
	readonly kind: "failed";
	readonly id: string;
	readonly workflow: string;
	readonly trigger: string;
	readonly ts: Date;
	readonly error: SerializedErrorPayload;
}

type InvocationLifecycleEvent = StartedEvent | CompletedEvent | FailedEvent;

// ---------------------------------------------------------------------------
// Bus + consumer interfaces
// ---------------------------------------------------------------------------

interface BusConsumer {
	handle(event: InvocationLifecycleEvent): Promise<void>;
}

interface EventBus {
	emit(event: InvocationLifecycleEvent): Promise<void>;
}

function createEventBus(consumers: BusConsumer[]): EventBus {
	return {
		async emit(event) {
			for (const consumer of consumers) {
				// biome-ignore lint/performance/noAwaitInLoops: sequential fan-out by design — persistence must commit before observers see the event
				await consumer.handle(event);
			}
		},
	};
}

export type {
	BusConsumer,
	CompletedEvent,
	EventBus,
	FailedEvent,
	InvocationLifecycleEvent,
	SerializedErrorPayload,
	StartedEvent,
};
export { createEventBus };
