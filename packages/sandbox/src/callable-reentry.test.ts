import { describe, expect, it } from "vitest";
import timersPlugin from "../../sandbox-stdlib/src/timers/index.ts?sandbox-plugin";
import { sandbox } from "./index.js";
import { TEST_SANDBOX_LIMITS } from "./test-harness.js";

// F-1 regression: a guest workflow that does
//   `let id = setInterval(() => clearInterval(id), 0);`
// previously crashed the worker with `RuntimeError: memory access out of
// bounds` because the timers plugin's `cancel()` synchronously disposed
// the guest Callable while QuickJS was still executing inside the same
// handle. With re-entry-safe Callable disposal in
// `guest-function-install.ts:makeCallable`, the underlying handle release
// is deferred until invocation depth returns to 0, the guest frame
// unwinds cleanly, and the sandbox stays alive for subsequent runs.

function iife(body: string): string {
	return `var __wfe_exports__ = (function(exports) {\n${body}\nreturn exports;\n})({});`;
}

describe("F-1 — setInterval self-clear does not crash the worker", () => {
	it("self-clearing setInterval completes the run cleanly and the sandbox remains usable", async () => {
		// The guest body has to stay alive long enough for the setInterval
		// callback to fire at least once: that is the path that hits the
		// cancel-during-fire shape. A bare `setInterval(...)` with no await
		// would let the run-body return synchronously, and `onRunFinished`'s
		// `clearAll()` would dispose the timer before any fire — bypassing
		// the bug. We sleep ~50ms to guarantee the interval fires under
		// real-VM scheduling.
		const source = iife(
			`exports.probe = async function() {
				let id = setInterval(() => clearInterval(id), 0);
				await new Promise(function (resolve) { setTimeout(resolve, 50); });
				return "ok";
			};`,
		);
		const sb = await sandbox({
			...TEST_SANDBOX_LIMITS,
			source,
			plugins: [{ ...timersPlugin }],
		});
		try {
			const first = await sb.run("probe", {});
			expect(first.ok).toBe(true);
			if (first.ok) {
				expect(first.result).toBe("ok");
			}
			// Sandbox must remain usable for another run — i.e. the worker
			// did not die from a WASM trap and `SandboxStore` does not need
			// to respawn it.
			const second = await sb.run("probe", {});
			expect(second.ok).toBe(true);
		} finally {
			await sb.dispose();
		}
	});

	it("self-clearing setTimeout (latent double-dispose path) completes cleanly", async () => {
		// Companion case: a self-clearing setTimeout used to take both the
		// re-entrant dispose hazard AND a downstream double-dispose in
		// `fire`'s post-callback epilogue. With idempotent + re-entry-safe
		// dispose in the Callable layer, both are neutralised.
		const source = iife(
			`exports.probe = async function() {
				let id = setTimeout(() => clearTimeout(id), 0);
				await new Promise(function (resolve) { setTimeout(resolve, 50); });
				return "ok";
			};`,
		);
		const sb = await sandbox({
			...TEST_SANDBOX_LIMITS,
			source,
			plugins: [{ ...timersPlugin }],
		});
		try {
			const result = await sb.run("probe", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.result).toBe("ok");
			}
		} finally {
			await sb.dispose();
		}
	});
});
