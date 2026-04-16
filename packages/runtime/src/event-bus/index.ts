import type { InvocationEvent } from "@workflow-engine/core";

interface BusConsumer {
	handle(event: InvocationEvent): Promise<void>;
}

interface EventBus {
	emit(event: InvocationEvent): Promise<void>;
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

export type { BusConsumer, EventBus };
export { createEventBus };
