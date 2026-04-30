import type { InvocationEvent } from "@workflow-engine/core";
import type { Logger } from "../logger.js";

// Emit one structured log line per invocation lifecycle terminal kind.
// Action and system events are too verbose for structured logs and stay
// in the durable events table for the dashboard.
//
// Logging is best-effort: a logger failure MUST NOT propagate. The wrapping
// try/catch with a console.error fallback preserves the contract that
// `eventStore.record` is unaffected by lifecycle logging health.
function logInvocationLifecycle(event: InvocationEvent, logger: Logger): void {
	try {
		const base = {
			id: event.id,
			workflow: event.workflow,
			trigger: event.name,
			ts: event.at,
		};
		if (event.kind === "trigger.request") {
			logger.info("invocation.started", base);
			return;
		}
		if (event.kind === "trigger.response") {
			logger.info("invocation.completed", base);
			return;
		}
		if (event.kind === "trigger.error") {
			logger.error("invocation.failed", { ...base, error: event.error });
			return;
		}
	} catch (err) {
		try {
			// biome-ignore lint/suspicious/noConsole: last-resort fallback when structured logging has itself failed
			console.error(
				"executor.log-lifecycle: failed to emit log entry",
				err instanceof Error ? err.message : String(err),
			);
		} catch {
			/* give up */
		}
	}
}

export { logInvocationLifecycle };
