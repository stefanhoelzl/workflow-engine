import type { Logger } from "./logger.js";

// `setExitFnForTests` is the only knob for tests — production never calls it.
// The default `exitFn` terminates the process; swapping it lets tests assert
// that shutdown was triggered without actually killing the test process.
let exitFn: () => void = () => process.exit(1);

function setExitFnForTests(fn: () => void): void {
	exitFn = fn;
}

async function systemShutdown(
	logger: Logger,
	reason: string,
	context: Record<string, unknown>,
): Promise<never> {
	logger.error("runtime.fatal", { reason, ...context });
	// `setImmediate` lets the current microtask queue drain (logger flush,
	// in-flight HTTP response writes) before the process dies. The surrounding
	// Promise is never resolved — in production exitFn() terminates the
	// process before resolution can happen; in tests with a spy exitFn() the
	// caller's await stays pending forever, matching the production semantics
	// that no further work runs on a doomed process.
	await new Promise<never>((_resolve) => {
		setImmediate(() => exitFn());
	});
	throw new Error("unreachable");
}

export { setExitFnForTests, systemShutdown };
