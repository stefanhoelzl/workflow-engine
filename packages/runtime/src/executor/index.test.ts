import type {
	InvocationEvent,
	SandboxEvent,
	WorkflowManifest,
} from "@workflow-engine/core";
import type { Sandbox } from "@workflow-engine/sandbox";
import { describe, expect, it, vi } from "vitest";
import { createEventBus, type EventBus } from "../event-bus/index.js";
import type { SandboxStore } from "../sandbox-store.js";
import { createExecutor } from "./index.js";
import type { HttpTriggerDescriptor } from "./types.js";

const EVT_ID_RE = /^evt_/;

function makeManifest(name: string, sha = "0".repeat(64)): WorkflowManifest {
	return {
		name,
		module: `${name}.js`,
		sha,
		env: {},
		actions: [],
		triggers: [],
	};
}

function makeDescriptor(
	name: string,
	workflowName = "w",
): HttpTriggerDescriptor {
	return {
		kind: "http",
		type: "http",
		name,
		workflowName,
		method: "POST",
		body: { type: "object" },
		inputSchema: { type: "object" },
		outputSchema: { type: "object" },
	};
}

interface FakeSandboxOptions {
	onRun?: (exportName: string, ctx: unknown) => unknown | Promise<unknown>;
	capture?: {
		readonly eventCallbacks: ((e: SandboxEvent) => void)[];
	};
}

function makeSandbox(options: FakeSandboxOptions = {}): Sandbox {
	return {
		run: vi.fn<Sandbox["run"]>().mockImplementation(async (exportName, ctx) => {
			const result = options.onRun
				? await options.onRun(exportName, ctx)
				: { status: 200 };
			return { ok: true, result };
		}),
		onEvent: vi.fn<Sandbox["onEvent"]>().mockImplementation((cb) => {
			options.capture?.eventCallbacks.push(cb);
		}),
		dispose: vi.fn(),
		onDied: vi.fn(),
	};
}

function makeStore(sandbox: Sandbox): SandboxStore {
	return {
		get: vi.fn<SandboxStore["get"]>().mockResolvedValue(sandbox),
		dispose: vi.fn(),
	};
}

describe("executor", () => {
	it("stamps invocation metadata onto sandbox events before emitting to the bus", async () => {
		const capture = { eventCallbacks: [] as ((e: SandboxEvent) => void)[] };
		const sandbox = makeSandbox({ capture });
		const runSpy = sandbox.run as ReturnType<typeof vi.fn>;
		const seen: InvocationEvent[] = [];
		const bus: EventBus = {
			emit: async (e) => {
				seen.push(e);
			},
		};
		const executor = createExecutor({ bus, sandboxStore: makeStore(sandbox) });

		// Drive an event from the sandbox mid-invocation by intercepting `run`
		// and firing the captured onEvent callback synchronously before
		// returning.
		runSpy.mockImplementationOnce(async (_exportName, _ctx) => {
			const cb = capture.eventCallbacks[0];
			if (!cb) {
				throw new Error("expected onEvent wired before run");
			}
			cb({
				kind: "trigger.request",
				seq: 0,
				ref: null,
				at: "2026-01-01T00:00:00.000Z",
				ts: 1,
				name: "trig",
			});
			return { ok: true, result: { status: 200 } };
		});

		await executor.invoke(
			"t0",
			makeManifest("wf"),
			makeDescriptor("trig"),
			{ hello: "world" },
			{ bundleSource: "source" },
		);

		expect(runSpy).toHaveBeenCalledTimes(1);
		const call = runSpy.mock.calls[0];
		if (!call) {
			throw new Error("expected at least one call");
		}
		expect(call[0]).toBe("trig");
		expect(call[1]).toEqual({ hello: "world" });
		// sb.run takes no 3rd arg — runtime metadata lives on bus events only
		expect(call).toHaveLength(2);

		expect(seen).toHaveLength(1);
		const first = seen[0];
		if (!first) {
			throw new Error("expected bus emission");
		}
		expect(first.id).toMatch(EVT_ID_RE);
		expect(first.tenant).toBe("t0");
		expect(first.workflow).toBe("wf");
		expect(first.workflowSha).toBe("0".repeat(64));
	});

	it("wires onEvent → bus.emit on first invoke and reuses the wiring", async () => {
		const capture = { eventCallbacks: [] as ((e: SandboxEvent) => void)[] };
		const sandbox = makeSandbox({ capture });
		const runSpy = sandbox.run as ReturnType<typeof vi.fn>;
		const seen: InvocationEvent[] = [];
		const bus: EventBus = {
			emit: async (e) => {
				seen.push(e);
			},
		};
		const executor = createExecutor({ bus, sandboxStore: makeStore(sandbox) });
		const wf = makeManifest("wf");

		// Fire one event per invocation via the captured callback while a run
		// is active — the executor's activeMeta slot is populated then.
		runSpy.mockImplementation(async (_exportName, _ctx) => {
			const cb = capture.eventCallbacks[0];
			if (!cb) {
				throw new Error("expected onEvent wired before run");
			}
			cb({
				kind: "trigger.request",
				seq: 0,
				ref: null,
				at: "2026-01-01T00:00:00.000Z",
				ts: 1,
				name: "t",
			});
			return { ok: true, result: { status: 200 } };
		});

		await executor.invoke("t0", wf, makeDescriptor("t"), null, {
			bundleSource: "source",
		});
		await executor.invoke("t0", wf, makeDescriptor("t"), null, {
			bundleSource: "source",
		});

		// onEvent should be wired exactly once across multiple invocations.
		expect(capture.eventCallbacks).toHaveLength(1);
		expect(seen).toHaveLength(2);
		expect(seen[0]?.workflow).toBe("wf");
		expect(seen[1]?.workflow).toBe("wf");
	});

	it("returns { ok: true, output } when the handler returns normally", async () => {
		const sandbox = makeSandbox({
			onRun: async () => ({ status: 202, body: { ok: true } }),
		});
		const executor = createExecutor({
			bus: createEventBus([]),
			sandboxStore: makeStore(sandbox),
		});
		const result = await executor.invoke(
			"t0",
			makeManifest("wf"),
			makeDescriptor("t"),
			null,
			{ bundleSource: "source" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.output).toEqual({ status: 202, body: { ok: true } });
		}
	});

	it("returns { ok: false, error } when sandbox.run reports an error", async () => {
		const sandbox: Sandbox = {
			run: vi.fn().mockResolvedValue({
				ok: false,
				error: { message: "boom", stack: "s" },
			}),
			onEvent: vi.fn(),
			dispose: vi.fn(),
			onDied: vi.fn(),
		};
		const executor = createExecutor({
			bus: createEventBus([]),
			sandboxStore: makeStore(sandbox),
		});
		const result = await executor.invoke(
			"t0",
			makeManifest("wf"),
			makeDescriptor("t"),
			null,
			{ bundleSource: "source" },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe("boom");
		}
	});

	it("serializes invocations of the same workflow via the runQueue", async () => {
		const callOrder: string[] = [];
		let active = 0;
		let maxActive = 0;
		let seq = 0;
		const sandbox = makeSandbox({
			onRun: async (_name, _ctx) => {
				const id = `run${++seq}`;
				active++;
				maxActive = Math.max(maxActive, active);
				callOrder.push(`start:${id}`);
				await new Promise((r) => setTimeout(r, 5));
				callOrder.push(`end:${id}`);
				active--;
				return { status: 200 };
			},
		});
		const executor = createExecutor({
			bus: createEventBus([]),
			sandboxStore: makeStore(sandbox),
		});
		const wf = makeManifest("wf");

		await Promise.all([
			executor.invoke("t0", wf, makeDescriptor("t"), null, {
				bundleSource: "source",
			}),
			executor.invoke("t0", wf, makeDescriptor("t"), null, {
				bundleSource: "source",
			}),
			executor.invoke("t0", wf, makeDescriptor("t"), null, {
				bundleSource: "source",
			}),
		]);

		expect(maxActive).toBe(1);
		expect(callOrder.length).toBe(6);
	});

	it("stamps meta.dispatch only onto trigger.request events", async () => {
		const capture = { eventCallbacks: [] as ((e: SandboxEvent) => void)[] };
		const sandbox = makeSandbox({ capture });
		const runSpy = sandbox.run as ReturnType<typeof vi.fn>;
		const seen: InvocationEvent[] = [];
		const bus: EventBus = {
			emit: async (e) => {
				seen.push(e);
			},
		};
		const executor = createExecutor({ bus, sandboxStore: makeStore(sandbox) });

		// Emit four sandbox events across kinds mid-run so the widener sees
		// all of them under the same active invocation.
		runSpy.mockImplementation(async () => {
			const cb = capture.eventCallbacks[0];
			if (!cb) {
				throw new Error("expected onEvent wired before run");
			}
			const base = {
				seq: 0,
				ref: null,
				at: "2026-01-01T00:00:00.000Z",
				ts: 1,
				name: "t",
			} as const;
			cb({ ...base, kind: "trigger.request" });
			cb({ ...base, seq: 1, kind: "action.request", name: "doThing" });
			cb({ ...base, seq: 2, kind: "action.response", name: "doThing" });
			cb({ ...base, seq: 3, kind: "trigger.response" });
			return { ok: true, result: { status: 200 } };
		});

		await executor.invoke("t0", makeManifest("wf"), makeDescriptor("t"), null, {
			bundleSource: "source",
			dispatch: {
				source: "manual",
				user: { name: "Jane", mail: "jane@example.com" },
			},
		});

		expect(seen).toHaveLength(4);
		const [req, act, actResp, resp] = seen;
		expect(req?.kind).toBe("trigger.request");
		expect(req?.meta).toEqual({
			dispatch: {
				source: "manual",
				user: { name: "Jane", mail: "jane@example.com" },
			},
		});
		expect(act?.kind).toBe("action.request");
		expect(act?.meta).toBeUndefined();
		expect(actResp?.kind).toBe("action.response");
		expect(actResp?.meta).toBeUndefined();
		expect(resp?.kind).toBe("trigger.response");
		expect(resp?.meta).toBeUndefined();
	});

	it("defaults dispatch to {source:'trigger'} when options omits it", async () => {
		const capture = { eventCallbacks: [] as ((e: SandboxEvent) => void)[] };
		const sandbox = makeSandbox({ capture });
		const runSpy = sandbox.run as ReturnType<typeof vi.fn>;
		const seen: InvocationEvent[] = [];
		const bus: EventBus = {
			emit: async (e) => {
				seen.push(e);
			},
		};
		const executor = createExecutor({ bus, sandboxStore: makeStore(sandbox) });

		runSpy.mockImplementation(async () => {
			const cb = capture.eventCallbacks[0];
			if (!cb) {
				throw new Error("expected onEvent wired before run");
			}
			cb({
				kind: "trigger.request",
				seq: 0,
				ref: null,
				at: "2026-01-01T00:00:00.000Z",
				ts: 1,
				name: "t",
			});
			return { ok: true, result: { status: 200 } };
		});

		await executor.invoke("t0", makeManifest("wf"), makeDescriptor("t"), null, {
			bundleSource: "source",
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]?.meta).toEqual({ dispatch: { source: "trigger" } });
		expect(
			(seen[0]?.meta?.dispatch as { user?: unknown } | undefined)?.user,
		).toBeUndefined();
	});
});
