import type { BusConsumer, RuntimeEvent } from "./index.js";
import type { Logger } from "../logger.js";

function createLoggingConsumer(logger: Logger): BusConsumer {
	return {
		// biome-ignore lint/suspicious/useAwait: synchronous logging, async required by BusConsumer interface
		async handle(event: RuntimeEvent): Promise<void> {
			const data: Record<string, unknown> = {
				correlationId: event.correlationId,
				eventId: event.id,
				type: event.type,
				state: event.state,
			};
			if (event.targetAction !== undefined) {
				data.targetAction = event.targetAction;
			}
			if (event.state === "done") {
				data.result = event.result;
				if (event.result === "failed") {
					data.error = event.error;
					logger.error("event.failed", data);
					return;
				}
			}
			if (event.state === "pending") {
				logger.info("event.created", data);
			} else if (event.state === "processing") {
				logger.trace("event.processing", data);
			} else {
				logger.trace("event.done", data);
			}
		},

		// biome-ignore lint/suspicious/useAwait: synchronous logging, async required by BusConsumer interface
		async bootstrap(
			_events: RuntimeEvent[],
			options?: { pending?: boolean; finished?: boolean; total?: number },
		): Promise<void> {
			if (options?.finished) {
				logger.info("events.recovered", { count: options.total ?? 0 });
			}
		},
	};
}

export { createLoggingConsumer };
