// Registers testharness result + completion callbacks BEFORE any test
// file runs. Sync test() calls fire add_result_callback DURING file eval,
// and testharness does not re-fire callbacks registered after completion,
// so we register up front. Callbacks buffer results into globalThis.__wpt
// (populated by the preamble); ENTRY flushes the buffer through the
// per-run __wptReport host bridge at sandbox.run() time.
//
// Rollup-bundled into an IIFE string and eval'd after testharness.js.

function statusName(s: number): string {
	if (s === 0) {
		return "PASS";
	}
	if (s === 1) {
		return "FAIL";
	}
	if (s === 2) {
		return "TIMEOUT";
	}
	if (s === 3) {
		return "NOTRUN";
	}
	if (s === 4) {
		return "PRECONDITION_FAILED";
	}
	return "UNKNOWN";
}

add_result_callback((test) => {
	try {
		__wpt.results.push({
			name: String(test.name),
			status: statusName(test.status),
			message: test.message == null ? "" : String(test.message),
		});
	} catch {
		// swallow — testharness shouldn't be able to propagate exceptions here
	}
});

add_completion_callback(() => {
	__wpt.completed = true;
	const resolvers = __wpt.resolvers;
	__wpt.resolvers = [];
	for (const resolver of resolvers) {
		try {
			resolver();
		} catch {
			// swallow
		}
	}
});

export type {};
