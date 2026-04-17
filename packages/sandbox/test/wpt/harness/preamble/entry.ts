// Defines __wptEntry — the per-test entry function invoked by the
// sandbox at run time. Waits for add_completion_callback to fire (or
// immediately if it already did during sync eval), then flushes buffered
// results through the per-run __wptReport host bridge.
//
// Rollup-bundled into an IIFE string and eval'd last.

const G = globalThis as any;

G.__wptEntry = async () => {
	// Force microtask drain (ShellTestEnvironment sets all_loaded after a
	// microtask), then call done() to trigger end_wait → complete →
	// add_completion_callback. No-op for files that already completed.
	try {
		await Promise.resolve();
		if (typeof done === "function") {
			done();
		}
	} catch {
		// swallow
	}

	if (!__wpt.completed) {
		await new Promise<void>((resolve) => {
			__wpt.resolvers.push(() => resolve());
		});
	}

	// Flush buffered results through the per-run __wptReport bridge.
	const results = __wpt.results;
	__wpt.results = [];
	for (const result of results) {
		try {
			__wptReport(result.name, result.status, result.message);
		} catch {
			// swallow
		}
	}
};

export type {};
