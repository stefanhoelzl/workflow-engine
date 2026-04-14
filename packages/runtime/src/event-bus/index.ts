import { z } from "@workflow-engine/sdk";

// Each sandbox bridge call (console.*, fetch/xhr.send, crypto.*, emit,
// timers) produces one of these entries. Populated on action events when the
// scheduler transitions them to `done`, so the timeline UI can show what the
// action did while it ran.
const LogEntrySchema = z.object({
	method: z.string(),
	args: z.array(z.unknown()),
	status: z.enum(["ok", "failed"]),
	result: z.unknown().optional(),
	error: z.string().optional(),
	ts: z.number(),
	durationMs: z.number().optional(),
});

const baseFields = {
	id: z.string(),
	type: z.string(),
	payload: z.unknown(),
	targetAction: z.exactOptional(z.string()),
	correlationId: z.string(),
	parentEventId: z.exactOptional(z.string()),
	logs: z.array(LogEntrySchema).optional(),
	createdAt: z.coerce.date(),
	sourceType: z.enum(["trigger", "action"]),
	sourceName: z.string(),
	emittedAt: z.coerce.date(),
	startedAt: z.coerce.date().optional(),
	doneAt: z.coerce.date().optional(),
};

const ActiveEventSchema = z.object({
	...baseFields,
	state: z.enum(["pending", "processing"]),
});

const SucceededEventSchema = z.object({
	...baseFields,
	state: z.literal("done"),
	result: z.literal("succeeded"),
});

const SkippedEventSchema = z.object({
	...baseFields,
	state: z.literal("done"),
	result: z.literal("skipped"),
});

const FailedEventSchema = z.object({
	...baseFields,
	state: z.literal("done"),
	result: z.literal("failed"),
	error: z.unknown(),
});

const RuntimeEventSchema = z.union([
	ActiveEventSchema,
	SucceededEventSchema,
	SkippedEventSchema,
	FailedEventSchema,
]);

type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

interface BusConsumer {
	handle(event: RuntimeEvent): Promise<void>;
	bootstrap(
		events: RuntimeEvent[],
		options?: { pending?: boolean; finished?: boolean; total?: number },
	): Promise<void>;
}

interface EventBus {
	emit(event: RuntimeEvent): Promise<void>;
	bootstrap(
		events: RuntimeEvent[],
		options?: { pending?: boolean; finished?: boolean; total?: number },
	): Promise<void>;
}

function createEventBus(consumers: BusConsumer[]): EventBus {
	return {
		async emit(event) {
			for (const consumer of consumers) {
				// biome-ignore lint/performance/noAwaitInLoops: sequential fan-out by design — consumers must execute in order
				await consumer.handle(event);
			}
		},
		async bootstrap(events, options) {
			for (const consumer of consumers) {
				// biome-ignore lint/performance/noAwaitInLoops: sequential fan-out by design — consumers must execute in order
				await consumer.bootstrap(events, options);
			}
		},
	};
}

export type { BusConsumer, EventBus, RuntimeEvent };
export { createEventBus, RuntimeEventSchema };
