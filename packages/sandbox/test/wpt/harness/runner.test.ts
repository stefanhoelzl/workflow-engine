import { describe, expect, it } from "vitest";
import { sandbox } from "../../../src/index.js";

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
		const sb = await sandbox(source, {});
		const deadlineMs = 300;
		const started = Date.now();
		const watchdog = setTimeout(() => {
			sb.dispose();
		}, deadlineMs);

		try {
			await expect(
				sb.run(
					"__wptEntry",
					{},
					{
						invocationId: "wpt_watchdog",
						tenant: "wpt",
						workflow: "wpt",
						workflowSha: "",
					},
				),
			).rejects.toThrow(/Sandbox is disposed|worker/i);
			const elapsed = Date.now() - started;
			expect(elapsed).toBeLessThan(deadlineMs + 2000);
		} finally {
			clearTimeout(watchdog);
			sb.dispose();
		}
	});
});
