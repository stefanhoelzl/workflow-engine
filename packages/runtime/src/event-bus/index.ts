import { z } from "@workflow-engine/sdk";

const RuntimeEventSchema = z.object({
	id: z.string(),
	type: z.string(),
	payload: z.unknown(),
	targetAction: z.exactOptional(z.string()),
	correlationId: z.string(),
	parentEventId: z.exactOptional(z.string()),
	createdAt: z.coerce.date(),
	state: z.enum(["pending", "processing", "done", "failed", "skipped"]),
	error: z.exactOptional(z.unknown()),
});

type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

interface BusConsumer {
	handle(event: RuntimeEvent): Promise<void>;
	bootstrap(
		events: RuntimeEvent[],
		options?: { finished?: boolean },
	): Promise<void>;
}

interface EventBus {
	emit(event: RuntimeEvent): Promise<void>;
	bootstrap(
		events: RuntimeEvent[],
		options?: { finished?: boolean },
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
