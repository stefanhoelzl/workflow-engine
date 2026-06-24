import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandbox } from "./index.js";
import type { HostHandlers, Sandbox } from "./sandbox.js";
import { TEST_SANDBOX_LIMITS } from "./test-harness.js";

// Test-only plugin exercising the worker→main host-call channel end-to-end.
// Its worker handlers call `ctx.callHost(method, args)`; the matching
// main-side handlers are supplied via the `hostHandlers` factory option. No
// runtime, no real consumer — this proves the transport itself.
const TEST_PLUGIN_SOURCE = `
export default function worker(ctx) {
	return {
		guestFunctions: [
			{
				name: "hostEcho",
				args: [{ kind: "raw" }],
				result: { kind: "raw" },
				handler: (x) => ctx.callHost("test.echo", [x]),
				public: true,
			},
			{
				name: "hostThrows",
				args: [],
				result: { kind: "raw" },
				handler: () => ctx.callHost("test.throws", []),
				public: true,
			},
			{
				name: "hostUnknown",
				args: [],
				result: { kind: "raw" },
				handler: () => ctx.callHost("test.nope", []),
				public: true,
			},
			{
				name: "hostFireAndForget",
				args: [],
				result: { kind: "raw" },
				handler: () => {
					// Fire-and-forget: deliberately NOT awaited. The pending call
					// must be rejected at run end without crashing the worker.
					ctx.callHost("test.slow", []);
					return "fired";
				},
				public: true,
			},
		],
	};
}
`;

function iife(body: string): string {
	return `var __wfe_exports__ = (function(exports) {\n${body}\nreturn exports;\n})({});`;
}

const USER_SOURCE = iife(`
exports.echo = function (input) { return hostEcho(input); };
exports.boom = function () { return hostThrows(); };
exports.unknown = function () { return hostUnknown(); };
exports.fire = function () { return hostFireAndForget(); };
exports.probe = function () { return typeof globalThis.callHost; };
`);

function makeHostHandlers(): HostHandlers {
	return {
		"test.echo": (args) => Promise.resolve(args[0]),
		"test.throws": () => Promise.reject(new Error("boom from host")),
		"test.slow": () =>
			new Promise((resolve) => setTimeout(() => resolve("late"), 50)),
	};
}

describe("worker→main host-call channel", () => {
	let sb: Sandbox;

	beforeEach(async () => {
		sb = await sandbox({
			...TEST_SANDBOX_LIMITS,
			source: USER_SOURCE,
			plugins: [{ name: "host-call-test", workerSource: TEST_PLUGIN_SOURCE }],
			hostHandlers: makeHostHandlers(),
		});
	});

	afterEach(async () => {
		await sb.dispose();
	});

	it("round-trips a host-call result back to the guest", async () => {
		const result = await sb.run("echo", "hello");
		expect(result).toEqual({ ok: true, result: "hello" });
	});

	it("surfaces a handler throw as a guest-visible error", async () => {
		const result = await sb.run("boom", null);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("boom from host");
		}
	});

	it("rejects an unknown method naming it", async () => {
		const result = await sb.run("unknown", null);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("test.nope");
		}
	});

	it("does not expose callHost on the guest globalThis", async () => {
		const result = await sb.run("probe", null);
		expect(result).toEqual({ ok: true, result: "undefined" });
	});

	it("rejects a fire-and-forget call at run end without breaking the sandbox", async () => {
		// Run A fires a call to a slow handler and returns without awaiting it;
		// at run end the pending call is rejected (worker-side) and the map
		// cleared. The slow response arrives later and is dropped (no pending
		// entry), so a subsequent run on the same sandbox is unaffected.
		const fired = await sb.run("fire", null);
		expect(fired).toEqual({ ok: true, result: "fired" });

		await new Promise((resolve) => setTimeout(resolve, 80));

		const after = await sb.run("echo", "again");
		expect(after).toEqual({ ok: true, result: "again" });
	});
});
