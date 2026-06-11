import { describe, expect, it } from "vitest";
import { sandbox } from "./index.js";
import { TEST_SANDBOX_LIMITS } from "./test-harness.js";

// Spec: sandbox-plugin "Plugin worker module identity in stack traces" —
// scenario "Emitted error event payload is blob-free". The worker loads
// plugin workerSource via data: import with an appended `//# sourceURL`,
// so a host-side throw from inside the plugin module must surface on the
// `.error` lifecycle event with `sandbox-plugin:<name>` frames — never the
// base64 data: URL, which once inflated a ~30-byte fetch error into a
// multi-MB stored payload (staging EventStore incident). The throw happens
// inside a real worker_threads worker where V8's default stack formatter
// applies, so this asserts the production-shaped serialization end-to-end.

const BOOMER_WORKER_SOURCE = `function detonate() { throw new Error("host-boom"); }
export default () => ({
	guestFunctions: [{
		name: "hostBoom",
		public: true,
		args: [],
		result: { kind: "void" },
		handler: () => detonate(),
	}],
});`;

function iife(body: string): string {
	return `var __wfe_exports__ = (function(exports) {\n${body}\nreturn exports;\n})({});`;
}

describe("plugin worker module identity at the event boundary", () => {
	it("host-module throw emits .error event with sandbox-plugin:<name> frames and no data: blob", async () => {
		const source = iife(
			`exports.probe = async function() {
				try { hostBoom(); } catch (e) {}
				return "ok";
			};`,
		);
		const sb = await sandbox({
			...TEST_SANDBOX_LIMITS,
			source,
			plugins: [{ name: "boomer", workerSource: BOOMER_WORKER_SOURCE }],
		});
		const errors: unknown[] = [];
		sb.onEvent((event) => {
			if (event.kind.endsWith(".error") && "error" in event) {
				errors.push((event as { error: unknown }).error);
			}
		});
		try {
			const result = await sb.run("probe", {});
			expect(result.ok).toBe(true);
			expect(errors).toHaveLength(1);
			const payload = errors[0] as { message?: string; stack?: string };
			expect(payload.message).toBe("host-boom");
			expect(payload.stack).toMatch(
				/at detonate \(sandbox-plugin:boomer:\d+:\d+\)/,
			);
			expect(JSON.stringify(payload)).not.toContain("data:text/javascript");
		} finally {
			await sb.dispose();
		}
	});
});
