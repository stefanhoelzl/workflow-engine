import type { SandboxEvent } from "@workflow-engine/core";
import { describe, expect, it } from "vitest";
import { type RunResult, sandbox } from "./index.js";
import type { PluginDescriptor } from "./plugin.js";
import { NOOP_PLUGINS } from "./test-plugins.js";

// Note: `SandboxEvent` is imported purely for the `events` array type in the
// runSource helper's return signature. Lifecycle event assertions
// (trigger.request / trigger.response / trigger.error) live in the trigger
// plugin's own tests — with NOOP_PLUGINS the sandbox emits no events.

// Wrap a body of `exports.X = ...; exports.Y = ...;` statements in an IIFE
// that assigns to `globalThis.__wfe_exports__` — the fixed namespace the
// sandbox reads exports from (see IIFE_NAMESPACE in @workflow-engine/core).
function iife(body: string): string {
	return `var __wfe_exports__ = (function(exports) {\n${body}\nreturn exports;\n})({});`;
}

// Convenience: a single default export shaped like `async (ctx) => <body>`.
function defaultHandler(handlerBody: string): string {
	return iife(`exports.default = async function(ctx) { ${handlerBody} };`);
}

async function runSource(
	source: string,
	options: {
		exportName?: string;
		ctx?: unknown;
		plugins?: readonly PluginDescriptor[];
	} = {},
): Promise<{ result: RunResult; events: SandboxEvent[] }> {
	const sb = await sandbox({
		source,
		plugins: options.plugins ?? NOOP_PLUGINS,
	});
	const events: SandboxEvent[] = [];
	sb.onEvent((e) => events.push(e));
	try {
		const result = await sb.run(
			options.exportName ?? "default",
			options.ctx ?? {},
		);
		return { result, events };
	} finally {
		sb.dispose();
	}
}

describe("sandbox isolation", () => {
	it("guest cannot access process", async () => {
		const { result } = await runSource(defaultHandler("process.exit(1);"));
		expect(result.ok).toBe(false);
	});

	it("RunResult has no logs field", async () => {
		const { result } = await runSource(defaultHandler("return 42;"));
		expect(result.ok).toBe(true);
		expect((result as { logs?: unknown }).logs).toBeUndefined();
	});

	it("invokes named exports with the ctx argument", async () => {
		const { result } = await runSource(
			iife("exports.handler = async (ctx) => ctx.x * 2;"),
			{ exportName: "handler", ctx: { x: 21 } },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toBe(42);
		}
	});

	it("returns ok=false with serialized error for missing export", async () => {
		const { result } = await runSource(iife("exports.a = 1;"), {
			exportName: "missing",
		});
		expect(result.ok).toBe(false);
	});

	// The missing-export error must identify the requested export but must NOT
	// leak the IIFE namespace identifier across the sandbox boundary — operators
	// recover workflow identity via log prefix / stack-frame filename instead
	// (see openspec/changes/simplify-iife-namespace/specs/sandbox/spec.md).
	it("missing-export error names the export but does not leak the namespace identifier", async () => {
		const { result } = await runSource(iife("exports.a = 1;"), {
			exportName: "missing",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("missing");
			expect(result.error.message).not.toContain("__wfe_exports__");
			expect(result.error.message).not.toContain("__wf_");
			expect(result.error.message).not.toContain("__workflowExports");
		}
	});
});

describe("sandbox dispose", () => {
	it("rejects subsequent run calls after dispose", async () => {
		const sb = await sandbox({
			source: defaultHandler("return 1;"),
			plugins: NOOP_PLUGINS,
		});
		sb.dispose();
		await expect(sb.run("default", null)).rejects.toThrow();
	});
});

// Sandbox emits `SandboxEvent` — intrinsic fields only (kind/seq/ref/at/ts/
// name/input/output/error). Runtime metadata (id/owner/workflow/workflowSha)
// is added by the runtime executor in its `sb.onEvent` handler, not by the
// sandbox. See SECURITY.md §2 R-8.
describe("sandbox onEvent — emits SandboxEvent intrinsic fields", () => {
	const STAMP_PLUGIN_SOURCE = `
		export default (ctx) => ({
			onBeforeRunStarted: (runInput) => {
				ctx.emit("test.ping", runInput.name, { input: { tag: "hi" } });
				return false;
			},
		});
	`;
	const STAMP_PLUGIN: PluginDescriptor = Object.freeze({
		name: "stamp-emitter",
		workerSource: STAMP_PLUGIN_SOURCE,
	});

	it("delivers events with intrinsic fields and no runtime metadata", async () => {
		const { events } = await runSource(defaultHandler("return 'ok';"), {
			plugins: [STAMP_PLUGIN],
		});
		expect(events.length).toBeGreaterThan(0);
		const e = events[0];
		expect(e?.kind).toBe("test.ping");
		expect(typeof e?.seq).toBe("number");
		expect(typeof e?.ts).toBe("number");
		expect(typeof e?.at).toBe("string");
		// Runtime metadata must NOT be present — the sandbox has no owner
		// concept. The runtime adds those fields at its boundary.
		expect(e).not.toHaveProperty("id");
		expect(e).not.toHaveProperty("owner");
		expect(e).not.toHaveProperty("workflow");
		expect(e).not.toHaveProperty("workflowSha");
	});
});

describe("sandbox memory limit", () => {
	it("rejects allocation-heavy code when memoryLimit is set", async () => {
		// 1 MB limit — allocating a huge typed array should fail.
		const sb = await sandbox({
			source: defaultHandler(
				`try {
					const arr = new Uint8Array(8 * 1024 * 1024);
					return { ok: true, len: arr.length };
				} catch (e) {
					return { ok: false, err: String(e && e.message) };
				}`,
			),
			plugins: NOOP_PLUGINS,
			memoryLimit: 1024 * 1024,
		});
		try {
			const result = await sb.run("default", null);
			// The guest either returns { ok: false } from its catch, or the
			// whole run fails with an OOM — both are acceptable evidence that
			// the limit is enforced.
			if (result.ok) {
				const inner = result.result as { ok?: boolean };
				expect(inner.ok).toBe(false);
			} else {
				expect(result.ok).toBe(false);
			}
		} finally {
			sb.dispose();
		}
	});
});
