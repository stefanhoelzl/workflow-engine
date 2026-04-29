import { describe, expect, it } from "vitest";
import timersPlugin from "../../sandbox-stdlib/src/timers/index.ts?sandbox-plugin";
import { CALLABLE_RESULT_BRAND, isCallableResult, sandbox } from "./index.js";
import { TEST_SANDBOX_LIMITS } from "./test-harness.js";

// F-3 regression: a guest workflow that schedules
//   `setTimeout(() => { throw new Error("late") }, 0)`
// and then awaits a non-trivial timer before resolving previously caused
// the worker thread to die via Node's `unhandledRejection` escalation,
// flipping a successful run into "worker exited with code N". With the
// Callable envelope contract (Guest→host boundary opacity), the rejection
// path no longer escapes; the run resolves with the handler's success
// value and the dashboard records a `system.error` close on the timer's
// frame.

function iife(body: string): string {
	return `var __wfe_exports__ = (function(exports) {\n${body}\nreturn exports;\n})({});`;
}

describe("F-3 — guest→host boundary opacity (Callable envelope contract)", () => {
	it("setTimeout callback throw surfaces as system.error close, run resolves OK, worker survives", async () => {
		const source = iife(
			`exports.probe = async function() {
				setTimeout(() => { throw new Error("late") }, 0);
				await new Promise(function (resolve) { setTimeout(resolve, 50); });
				return "ok";
			};`,
		);
		const sb = await sandbox({
			...TEST_SANDBOX_LIMITS,
			source,
			plugins: [{ ...timersPlugin }],
		});
		const events: { kind: string; name: string; error?: unknown }[] = [];
		sb.onEvent((event) => {
			events.push({
				kind: event.kind,
				name: event.name,
				...(event.kind === "system.error" && "error" in event
					? { error: (event as { error: unknown }).error }
					: {}),
			});
		});
		try {
			const first = await sb.run("probe", {});
			expect(first.ok).toBe(true);
			if (first.ok) {
				expect(first.result).toBe("ok");
			}
			// One paired system.request / system.error from the deferred throw.
			const errors = events.filter(
				(e) => e.kind === "system.error" && e.name === "setTimeout",
			);
			expect(errors).toHaveLength(1);
			const errPayload = errors[0]?.error as
				| { name?: string; message?: string }
				| undefined;
			expect(errPayload?.name).toBe("Error");
			expect(errPayload?.message).toBe("late");
			// Worker survival: a subsequent run completes on the same sandbox.
			const second = await sb.run("probe", {});
			expect(second.ok).toBe(true);
		} finally {
			await sb.dispose();
		}
	});

	it("setInterval throws on every tick, run resolves OK, worker survives", async () => {
		const source = iife(
			`exports.probe = async function() {
				let id = setInterval(() => { throw new Error("tick-fail") }, 5);
				await new Promise(function (resolve) { setTimeout(resolve, 50); });
				clearInterval(id);
				return "ok";
			};`,
		);
		const sb = await sandbox({
			...TEST_SANDBOX_LIMITS,
			source,
			plugins: [{ ...timersPlugin }],
		});
		const errEvents: { name: string }[] = [];
		sb.onEvent((event) => {
			if (event.kind === "system.error") {
				errEvents.push({ name: event.name });
			}
		});
		try {
			const result = await sb.run("probe", {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.result).toBe("ok");
			}
			// At least one interval throw observed under the timer's frame.
			expect(
				errEvents.filter((e) => e.name === "setInterval").length,
			).toBeGreaterThan(0);
			// Worker still alive.
			const second = await sb.run("probe", {});
			expect(second.ok).toBe(true);
		} finally {
			await sb.dispose();
		}
	});

	it("envelope brand is non-enumerable: not present in JSON.stringify, Object.keys", () => {
		const env: { ok: true; value: number } = { ok: true, value: 42 };
		Object.defineProperty(env, CALLABLE_RESULT_BRAND, { value: true });
		expect(isCallableResult(env)).toBe(true);
		expect(Object.keys(env).sort()).toEqual(["ok", "value"]);
		expect(JSON.stringify(env)).toBe('{"ok":true,"value":42}');
		// Brand IS visible via getOwnPropertySymbols (intentional — host-side
		// discrimination requires the symbol to be reachable somehow).
		expect(Object.getOwnPropertySymbols(env)).toContain(CALLABLE_RESULT_BRAND);
	});

	it("isCallableResult discriminates branded envelopes from look-alike literals", () => {
		const branded = { ok: true, value: 1 };
		Object.defineProperty(branded, CALLABLE_RESULT_BRAND, { value: true });
		const lookAlike = { ok: true, value: 1 };
		expect(isCallableResult(branded)).toBe(true);
		expect(isCallableResult(lookAlike)).toBe(false);
		expect(isCallableResult(null)).toBe(false);
		expect(isCallableResult(undefined)).toBe(false);
		expect(isCallableResult(42)).toBe(false);
		expect(isCallableResult("string")).toBe(false);
	});
});
