import type { InvocationEvent } from "@workflow-engine/core";
import type { Logger } from "../logger.js";
import { systemShutdown } from "../system-shutdown.js";

interface BusConsumer {
	readonly name: string;
	readonly strict: boolean;
	handle(event: InvocationEvent): Promise<void>;
}

interface EventBus {
	emit(event: InvocationEvent): Promise<void>;
}

interface CreateEventBusOptions {
	readonly logger: Logger;
}

function createEventBus(
	consumers: BusConsumer[],
	opts: CreateEventBusOptions,
): EventBus {
	return {
		async emit(event) {
			for (const consumer of consumers) {
				try {
					// biome-ignore lint/performance/noAwaitInLoops: sequential fan-out by design — persistence must commit before observers see the event
					await consumer.handle(event);
				} catch (err) {
					const error =
						err instanceof Error
							? { message: err.message, stack: err.stack }
							: { message: String(err) };
					opts.logger.error("bus.consumer-failed", {
						consumer: consumer.name,
						error,
					});
					if (consumer.strict) {
						// The bus owns the fatal-exit contract: a strict consumer
						// failure terminates the runtime. systemShutdown logs
						// runtime.fatal, schedules process.exit(1), and returns a
						// Promise that never resolves — so this emit() never
						// resolves either, callers' awaits park forever, and no
						// further work runs on the doomed process.
						await systemShutdown(opts.logger, "bus-strict-consumer-failed", {
							consumer: consumer.name,
							id: event.id,
							kind: event.kind,
							seq: event.seq,
							owner: event.owner,
							workflowSha: event.workflowSha,
							error,
						});
					}
				}
			}
		},
	};
}

export type { BusConsumer, CreateEventBusOptions, EventBus };
export { createEventBus };
