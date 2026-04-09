import { z } from "@workflow-engine/sdk";

const baseFields = {
	id: z.string(),
	type: z.string(),
	payload: z.unknown(),
	targetAction: z.exactOptional(z.string()),
	correlationId: z.string(),
	parentEventId: z.exactOptional(z.string()),
	createdAt: z.coerce.date(),
	sourceType: z.enum(["trigger", "action"]),
	sourceName: z.string(),
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
		options?: { pending?: boolean },
	): Promise<void>;
}

interface EventBus {
	emit(event: RuntimeEvent): Promise<void>;
	bootstrap(
		events: RuntimeEvent[],
		options?: { pending?: boolean },
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

export { RuntimeEventSchema, createEventBus };
export type { BusConsumer, EventBus, RuntimeEvent };
