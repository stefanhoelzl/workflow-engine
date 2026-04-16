import type { InvocationEvent } from "@workflow-engine/core";
import { describe, expect, it } from "vitest";
import { type RunResult, sandbox } from "./index.js";

const ONLY_ACTION_RE = /only action.\* allowed/;

const RUN_OPTS = {
	invocationId: "evt_test",
	workflow: "wf",
	workflowSha: "sha-abc",
};

async function runSource(
	source: string,
	options: {
		exportName?: string;
		ctx?: unknown;
		methods?: Record<string, (...args: unknown[]) => Promise<unknown>>;
		methodEventNames?: Record<string, string>;
	} = {},
): Promise<{ result: RunResult; events: InvocationEvent[] }> {
	const sb = await sandbox(
		source,
		options.methods ?? {},
		options.methodEventNames
			? { methodEventNames: options.methodEventNames }
			: {},
	);
	const events: InvocationEvent[] = [];
	sb.onEvent((e) => events.push(e));
	try {
		const result = await sb.run(
			options.exportName ?? "default",
			options.ctx ?? {},
			RUN_OPTS,
		);
		return { result, events };
	} finally {
		sb.dispose();
	}
}

describe("sandbox isolation", () => {
	it("guest cannot access process", async () => {
		const { result } = await runSource(
			"export default async () => { process.exit(1); }",
		);
		expect(result.ok).toBe(false);
	});

	it("RunResult has no logs field", async () => {
		const { result } = await runSource("export default async () => 42");
		expect(result.ok).toBe(true);
		expect((result as { logs?: unknown }).logs).toBeUndefined();
	});

	it("invokes named exports with the ctx argument", async () => {
		const { result } = await runSource(
			"export const handler = async (ctx) => ctx.x * 2",
			{ exportName: "handler", ctx: { x: 21 } },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toBe(42);
		}
	});

	it("returns ok=false with serialized error for missing export", async () => {
		const { result } = await runSource("export const a = 1", {
			exportName: "missing",
		});
		expect(result.ok).toBe(false);
	});
});

describe("sandbox event streaming", () => {
	it("emits trigger.request first and trigger.response last on success", async () => {
		const { events } = await runSource(
			"export default async (ctx) => ({ status: 200, body: 'ok' })",
		);
		expect(events.length).toBeGreaterThanOrEqual(2);
		expect(events[0]?.kind).toBe("trigger.request");
		expect(events.at(-1)?.kind).toBe("trigger.response");
	});

	it("emits trigger.error as the last event on handler throw", async () => {
		const { events } = await runSource(
			"export default async () => { throw new Error('boom') }",
		);
		expect(events.at(-1)?.kind).toBe("trigger.error");
		const err = events.at(-1) as InvocationEvent;
		expect(err.error?.message).toContain("boom");
	});

	it("stamps every event with id, workflow, workflowSha", async () => {
		const { events } = await runSource("export default async () => 1");
		for (const e of events) {
			expect(e.id).toBe("evt_test");
			expect(e.workflow).toBe("wf");
			expect(e.workflowSha).toBe("sha-abc");
		}
	});

	it("assigns monotonic seq starting at 0", async () => {
		const { events } = await runSource("export default async () => 1");
		const seqs = events.map((e) => e.seq);
		const sorted = [...seqs].sort((a, b) => a - b);
		expect(seqs).toEqual(sorted);
		expect(seqs[0]).toBe(0);
	});

	it("trigger.request has ref=null; matching trigger.response has ref=0", async () => {
		const { events } = await runSource("export default async () => 1");
		const req = events.find((e) => e.kind === "trigger.request");
		const resp = events.find((e) => e.kind === "trigger.response");
		expect(req?.ref).toBeNull();
		expect(resp?.ref).toBe(req?.seq);
	});

	it("emits paired system.request/system.response for console.log", async () => {
		const { events } = await runSource(
			"export default async () => { console.log('hi', 42); return 1 }",
		);
		const sysReqs = events.filter(
			(e) => e.kind === "system.request" && e.name === "console.log",
		);
		const sysResps = events.filter(
			(e) => e.kind === "system.response" && e.name === "console.log",
		);
		expect(sysReqs).toHaveLength(1);
		expect(sysResps).toHaveLength(1);
		expect(sysResps[0]?.ref).toBe(sysReqs[0]?.seq);
		expect(sysReqs[0]?.input).toEqual(["hi", 42]);
	});

	it("uses methodEventNames override for the system event name", async () => {
		const { events } = await runSource(
			"export default async () => { await myMethod('arg') }",
			{
				methods: { myMethod: async () => undefined },
				methodEventNames: { myMethod: "host.custom" },
			},
		);
		const sysReq = events.find(
			(e) => e.kind === "system.request" && e.name === "host.custom",
		);
		expect(sysReq).toBeDefined();
	});

	it("__emitEvent is callable from guest and stamps action.* events", async () => {
		const { events } = await runSource(
			`export default async () => {
        __emitEvent({ kind: "action.request", name: "notify", input: { ch: "ops" } });
        __emitEvent({ kind: "action.response", name: "notify", output: { sent: true } });
        return 1;
      }`,
		);
		const actionReqs = events.filter((e) => e.kind === "action.request");
		const actionResps = events.filter((e) => e.kind === "action.response");
		expect(actionReqs).toHaveLength(1);
		expect(actionResps).toHaveLength(1);
		expect(actionReqs[0]?.name).toBe("notify");
		expect(actionResps[0]?.ref).toBe(actionReqs[0]?.seq);
	});

	it("__emitEvent does NOT itself appear as a system.request", async () => {
		const { events } = await runSource(
			`export default async () => {
        __emitEvent({ kind: "action.request", name: "n" });
        __emitEvent({ kind: "action.response", name: "n" });
        return 1;
      }`,
		);
		const emitSysEvents = events.filter(
			(e) =>
				(e.kind === "system.request" || e.kind === "system.response") &&
				e.name === "__emitEvent",
		);
		expect(emitSysEvents).toHaveLength(0);
	});

	it("__emitEvent rejects non-action kinds", async () => {
		const { events } = await runSource(
			`export default async () => {
        try { __emitEvent({ kind: "system.request", name: "x" }); return "no-throw" }
        catch (e) { return e.message }
      }`,
		);
		const trigResp = events.find((e) => e.kind === "trigger.response");
		expect(String(trigResp?.output)).toMatch(ONLY_ACTION_RE);
	});

	it("nested action and system events have correct refs forming a tree", async () => {
		const { events } = await runSource(
			`export default async () => {
        __emitEvent({ kind: "action.request", name: "outer", input: 1 });
        console.log("inside outer");
        __emitEvent({ kind: "action.response", name: "outer", output: 2 });
        return 0;
      }`,
		);
		// trigger.request seq=0 (ref null)
		// action.request "outer" seq=1 (ref 0)
		// system.request console.log seq=2 (ref 1)
		// system.response console.log seq=3 (ref 2)
		// action.response "outer" seq=4 (ref 1)
		// trigger.response seq=5 (ref 0)
		const byKindName = (k: string, n?: string) =>
			events.find((e) => e.kind === k && (!n || e.name === n));
		expect(byKindName("trigger.request")?.ref).toBeNull();
		expect(byKindName("action.request", "outer")?.ref).toBe(0);
		expect(byKindName("system.request", "console.log")?.ref).toBe(1);
		expect(byKindName("system.response", "console.log")?.ref).toBe(2);
		expect(byKindName("action.response", "outer")?.ref).toBe(1);
		expect(byKindName("trigger.response")?.ref).toBe(0);
	});
});

describe("sandbox dispose", () => {
	it("rejects subsequent run calls after dispose", async () => {
		const sb = await sandbox("export default async () => 1", {});
		sb.dispose();
		await expect(sb.run("default", null, RUN_OPTS)).rejects.toThrow();
	});
});
