import { sandbox } from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
// NOOP_PLUGINS lives in the sandbox package's test-plugins module which has no
// package subpath export — use a relative workspace path to pull it in for
// this harness unit test. (The harness package is a sibling workspace, so
// the relative path is stable as long as both remain under packages/.)
import { TEST_SANDBOX_LIMITS } from "../../../../sandbox/src/test-harness.js";
import { NOOP_PLUGINS } from "../../../../sandbox/src/test-plugins.js";

describe("watchdog force-kill pattern", () => {
	// The WPT runner's watchdog: setTimeout(deadlineMs) → sb.dispose() →
	// dispose() rejects pending runs AND terminates the worker thread. This
	// verifies the pattern without requiring a real WPT file.
	it("force-kills a CPU-bound guest via setTimeout + sb.dispose()", async () => {
		const source = `
			var __wfe_exports__ = (function(exports) {
				exports.__wptEntry = async function() {
					while (true) { /* infinite loop */ }
				};
				return exports;
			})({});
		`;
		const sb = await sandbox({
			...TEST_SANDBOX_LIMITS,
			source,
			plugins: NOOP_PLUGINS,
		});
		const deadlineMs = 300;
		const started = Date.now();
		const watchdog = setTimeout(() => {
			sb.dispose();
		}, deadlineMs);

		try {
			await expect(sb.run("__wptEntry", {})).rejects.toThrow(
				/Sandbox is disposed|worker/i,
			);
			const elapsed = Date.now() - started;
			expect(elapsed).toBeLessThan(deadlineMs + 2000);
		} finally {
			clearTimeout(watchdog);
			sb.dispose();
		}
	});
});
