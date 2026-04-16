import type { Logger } from "../logger.js";
import type { BusConsumer, InvocationLifecycleEvent } from "./index.js";

function baseFields(event: InvocationLifecycleEvent): Record<string, unknown> {
	return {
		id: event.id,
		workflow: event.workflow,
		trigger: event.trigger,
		kind: event.kind,
		ts: event.ts.toISOString(),
	};
}

function createLoggingConsumer(logger: Logger): BusConsumer {
	return {
		// biome-ignore lint/suspicious/useAwait: async required by BusConsumer interface; logging itself is synchronous
		async handle(event: InvocationLifecycleEvent): Promise<void> {
			try {
				const data = baseFields(event);
				if (event.kind === "started") {
					logger.info("invocation.started", data);
					return;
				}
				if (event.kind === "completed") {
					data.result = event.result;
					logger.info("invocation.completed", data);
					return;
				}
				data.error = event.error;
				logger.error("invocation.failed", data);
			} catch (err) {
				// Never propagate logger failure — the bus would otherwise abort
				// dispatch to subsequent consumers. Best-effort surface to stderr.
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
