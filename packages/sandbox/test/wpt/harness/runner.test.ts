import { describe, expect, it } from "vitest";
import { sandbox } from "../../../src/index.js";
import { findMissingSkips } from "./runner.js";

describe("findMissingSkips", () => {
	it("returns empty list when no declared skips", () => {
		expect(findMissingSkips(undefined, [])).toEqual([]);
		expect(findMissingSkips({}, [])).toEqual([]);
	});

	it("returns empty list when every declared skip was observed", () => {
		const declared = { a: "r1", b: "r2" };
		const observed = [
			{ name: "a", status: "PASS", message: "" },
			{ name: "b", status: "PASS", message: "" },
			{ name: "c", status: "PASS", message: "" },
		];
		expect(findMissingSkips(declared, observed)).toEqual([]);
	});

	it("returns names of declared skips that were not observed (drift signal)", () => {
		const declared = {
			"renamed upstream": "stale",
			"still here": "kept",
		};
		const observed = [{ name: "still here", status: "FAIL", message: "" }];
		expect(findMissingSkips(declared, observed)).toEqual(["renamed upstream"]);
	});

	it("returns all declared names when nothing was observed", () => {
		const declared = { x: "r1", y: "r2" };
		expect(findMissingSkips(declared, [])).toEqual(["x", "y"]);
	});
});

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
						workflow: "wpt",
						workflowSha: "",
					},
				),
			).rejects.toThrow(/Sandbox is disposed|worker/i);
			const elapsed = Date.now() - started;
			// Should settle within deadlineMs + a small margin for Worker.terminate().
			expect(elapsed).toBeLessThan(deadlineMs + 2000);
		} finally {
			clearTimeout(watchdog);
			sb.dispose();
		}
	});
});
