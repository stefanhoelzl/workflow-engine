import type { Logger } from "./index.js";
import type { WorkerToMain } from "./protocol.js";

// Routes a WorkerToMain 'log' message to the injected Logger.
// If no logger is provided, the message is silently discarded —
// matches the "zero config, no stray output" contract for direct
// sandbox() callers and tests that don't opt in.
function dispatchLog(
	logger: Logger | undefined,
	msg: Extract<WorkerToMain, { type: "log" }>,
): void {
	if (!logger) {
		return;
	}
	try {
		logger[msg.level](msg.message, msg.meta);
	} catch {
		// Swallow logger errors so a broken logger can't kill the worker listener.
	}
}

export { dispatchLog };
