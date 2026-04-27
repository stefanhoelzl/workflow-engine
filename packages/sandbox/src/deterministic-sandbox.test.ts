import { afterEach, beforeEach, describe, expect, it } from "vitest";
import consolePlugin from "../../sandbox-stdlib/src/console/index.ts?sandbox-plugin";
import timersPlugin from "../../sandbox-stdlib/src/timers/index.ts?sandbox-plugin";
import webPlatformPlugin from "../../sandbox-stdlib/src/web-platform/index.ts?sandbox-plugin";
import { sandbox } from "./index.js";
import wasiPlugin from "./plugins/wasi-plugin.ts?sandbox-plugin";
import { TEST_SANDBOX_LIMITS } from "./test-harness.js";

// Tests for the `deterministic-sandbox` change: guest-visible state does
// not persist across runs (snapshot-restore per run), and a restore
// failure fires `onTerminated` via the existing worker-death path.

function iife(body: string): string {
	return `var __wfe_exports__ = (function(exports) {\n${body}\nreturn exports;\n})({});`;
}

describe("deterministic sandbox — guest state does not persist across runs", () => {
	it("a mutated `let` module-level binding resets between runs", async () => {
		const source = iife(
			"let count = 0; exports.tick = async function() { return ++count; };",
		);
		const sb = await sandbox({ ...TEST_SANDBOX_LIMITS, source, plugins: [] });
		try {
			const results: unknown[] = [];
			for (let i = 0; i < 3; i++) {
				// biome-ignore lint/performance/noAwaitInLoops: runs MUST be sequential — the point is to observe state reset between runs
				const r = await sb.run("tick", {});
				if (!r.ok) {
					throw new Error(`run ${i} failed: ${r.error.message}`);
				}
				results.push(r.result);
			}
			expect(results).toEqual([1, 1, 1]);
		} finally {
			sb.dispose();
		}
	});

	it("`globalThis` writes do not leak between runs", async () => {
		const source = iife(
			"exports.probe = async function() { const prev = globalThis.__leak || 0; globalThis.__leak = prev + 1; return prev; };",
		);
		const sb = await sandbox({ ...TEST_SANDBOX_LIMITS, source, plugins: [] });
		try {
			const results: unknown[] = [];
			for (let i = 0; i < 3; i++) {
				// biome-ignore lint/performance/noAwaitInLoops: runs MUST be sequential — the point is to observe state reset between runs
				const r = await sb.run("probe", {});
				if (!r.ok) {
					throw new Error(`run ${i} failed: ${r.error.message}`);
				}
				results.push(r.result);
			}
			expect(results).toEqual([0, 0, 0]);
		} finally {
			sb.dispose();
		}
	});
});

describe("deterministic sandbox — restore failure marks sandbox dead", () => {
	beforeEach(() => {
		// biome-ignore lint/style/noProcessEnv: scoped test-only seam, see worker.ts
		process.env.WFE_TEST_SANDBOX_RESTORE_FAIL = "1";
	});
	afterEach(() => {
		// biome-ignore lint/style/noProcessEnv: scoped test-only seam, see worker.ts
		process.env.WFE_TEST_SANDBOX_RESTORE_FAIL = undefined;
	});

	it("fires onTerminated after the first run and rejects subsequent runs", async () => {
		const source = iife("exports.ping = async function() { return 'pong'; };");
		const sb = await sandbox({ ...TEST_SANDBOX_LIMITS, source, plugins: [] });
		const died = new Promise<import("./index.js").TerminationCause>((resolve) =>
			sb.onTerminated(resolve),
		);
		const firstRun = await sb.run("ping", {});
		expect(firstRun.ok).toBe(true);
		const cause = await died;
		expect(cause.kind).toBe("crash");
		if (cause.kind === "crash") {
			expect(String(cause.err.message)).toContain("injected restore failure");
		}
		await expect(sb.run("ping", {})).rejects.toThrow();
	});
});

describe("deterministic sandbox — plugin stack survives multiple restores", () => {
	it("web-platform, timers, console + sync guest functions work across 3 runs", async () => {
		const source = iife(`
			exports.run = async function() {
				const uuid = crypto.randomUUID();
				const buf = new TextEncoder().encode(uuid);
				await new Promise((resolve) => setTimeout(resolve, 0));
				console.log("run", uuid);
				return { uuid, bytes: buf.length };
			};
		`);
		const plugins = [
			{ ...wasiPlugin },
			{ ...webPlatformPlugin },
			{ ...timersPlugin },
			{ ...consolePlugin },
		];
		const sb = await sandbox({
			...TEST_SANDBOX_LIMITS,
			source,
			plugins,
		});
		try {
			const uuids: string[] = [];
			for (let i = 0; i < 3; i++) {
				// biome-ignore lint/performance/noAwaitInLoops: runs MUST be sequential — the point is to observe state reset between runs
				const r = await sb.run("run", {});
				if (!r.ok) {
					throw new Error(`run ${i} failed: ${r.error.message}`);
				}
				const result = r.result as { uuid: string; bytes: number };
				uuids.push(result.uuid);
				expect(result.bytes).toBeGreaterThan(0);
			}
			// Each run's crypto/web-platform bindings produce distinct uuids.
			// If rebind dropped any descriptor, the guest call would throw and
			// the run would be `ok: false`.
			expect(new Set(uuids).size).toBe(3);
		} finally {
			sb.dispose();
		}
	});
});
