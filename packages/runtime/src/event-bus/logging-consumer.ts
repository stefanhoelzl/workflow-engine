import type { InvocationEvent } from "@workflow-engine/core";
import type { Logger } from "../logger.js";
import type { BusConsumer } from "./index.js";

function baseFields(event: InvocationEvent): Record<string, unknown> {
	return {
		id: event.id,
		workflow: event.workflow,
		trigger: event.name,
		ts: event.at,
	};
}

function createLoggingConsumer(logger: Logger): BusConsumer {
	return {
		// biome-ignore lint/suspicious/useAwait: async required by BusConsumer interface; logging itself is synchronous
		async handle(event: InvocationEvent): Promise<void> {
			try {
				if (event.kind === "trigger.request") {
					logger.info("invocation.started", baseFields(event));
					return;
				}
				if (event.kind === "trigger.response") {
					logger.info("invocation.completed", baseFields(event));
					return;
				}
				if (event.kind === "trigger.error") {
					const data = baseFields(event);
					data.error = event.error;
					logger.error("invocation.failed", data);
					return;
				}
				// action.* and system.* are not logged here — too verbose for
				// structured logs. The event store keeps them for the dashboard.
			} catch (err) {
				try {
					// biome-ignore lint/suspicious/noConsole: last-resort fallback when structured logging has itself failed
					console.error(
						"logging-consumer: failed to emit log entry",
						err instanceof Error ? err.message : String(err),
					);
				} catch {
					/* give up */
				}
			}
		},
	};
}

export { createLoggingConsumer };
