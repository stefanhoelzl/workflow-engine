import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
	let active = false;
	return {
		run: vi.fn<Sandbox["run"]>().mockImplementation(async (exportName, ctx) => {
			active = true;
			try {
				const result = options.onRun
					? await options.onRun(exportName, ctx)
					: { status: 200 };
				return { ok: true, result };
			} finally {
				active = false;
			}
		}),
		onEvent: vi.fn<Sandbox["onEvent"]>().mockImplementation((cb) => {
			options.capture?.eventCallbacks.push(cb);
		}),
		dispose: vi.fn(),
		onDied: vi.fn(),
		get isActive() {
			return active;
		},
	};
}

function makeStore(sandbox: Sandbox): SandboxStore {
	return {
		get: vi.fn<SandboxStore["get"]>().mockResolvedValue(sandbox),
		dispose: vi.fn<SandboxStore["dispose"]>().mockResolvedValue(undefined),
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
		const executor = createExecutor({
			bus,
			sandboxStore: makeStore(sandbox),
		});

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
			"r0",
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
		expect(first.owner).toBe("t0");
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
		const executor = createExecutor({
			bus,
			sandboxStore: makeStore(sandbox),
		});
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

		await executor.invoke("t0", "r0", wf, makeDescriptor("t"), null, {
			bundleSource: "source",
		});
		await executor.invoke("t0", "r0", wf, makeDescriptor("t"), null, {
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
			"r0",
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
			isActive: false,
		};
		const executor = createExecutor({
			bus: createEventBus([]),
			sandboxStore: makeStore(sandbox),
		});
		const result = await executor.invoke(
			"t0",
			"r0",
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
			executor.invoke("t0", "r0", wf, makeDescriptor("t"), null, {
				bundleSource: "source",
			}),
			executor.invoke("t0", "r0", wf, makeDescriptor("t"), null, {
				bundleSource: "source",
			}),
			executor.invoke("t0", "r0", wf, makeDescriptor("t"), null, {
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

		await executor.invoke(
			"t0",
			"r0",
			makeManifest("wf"),
			makeDescriptor("t"),
			null,
			{
				bundleSource: "source",
				dispatch: {
					source: "manual",
					user: { login: "Jane", mail: "jane@example.com" },
				},
			},
		);

		expect(seen).toHaveLength(4);
		const [req, act, actResp, resp] = seen;
		expect(req?.kind).toBe("trigger.request");
		expect(req?.meta).toEqual({
			dispatch: {
				source: "manual",
				user: { login: "Jane", mail: "jane@example.com" },
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

		await executor.invoke(
			"t0",
			"r0",
			makeManifest("wf"),
			makeDescriptor("t"),
			null,
			{
				bundleSource: "source",
			},
		);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.meta).toEqual({ dispatch: { source: "trigger" } });
		expect(
			(seen[0]?.meta?.dispatch as { user?: unknown } | undefined)?.user,
		).toBeUndefined();
	});
});

describe("executor.fail (trigger.exception emission)", () => {
	function setup() {
		const seen: InvocationEvent[] = [];
		const bus: EventBus = {
			emit: async (e) => {
				seen.push(e);
			},
		};
		const sandbox = makeSandbox();
		const store = makeStore(sandbox);
		const executor = createExecutor({ bus, sandboxStore: store });
		return { executor, sandbox, store, seen };
	}

	it("emits one fully-stamped trigger.exception leaf event", async () => {
		const { executor, seen } = setup();
		const workflow = makeManifest("wf", "a".repeat(64));
		const descriptor = makeDescriptor("inbound");

		await executor.fail("acme", "billing", workflow, descriptor, {
			name: "imap.poll-failed",
			error: { message: "ECONNREFUSED" },
			details: { stage: "connect", failedUids: [] },
		});

		expect(seen).toHaveLength(1);
		const evt = seen[0];
		if (!evt) {
			throw new Error("expected one event");
		}
		expect(evt.kind).toBe("trigger.exception");
		expect(evt.name).toBe("imap.poll-failed");
		expect(evt.seq).toBe(0);
		expect(evt.ref).toBe(0);
		expect(evt.ts).toBe(0);
		expect(evt.id).toMatch(EVT_ID_RE);
		expect(evt.owner).toBe("acme");
		expect(evt.repo).toBe("billing");
		expect(evt.workflow).toBe("wf");
		expect(evt.workflowSha).toBe(workflow.sha);
		expect(evt.error).toEqual({ message: "ECONNREFUSED" });
		expect(evt.error?.stack).toBeUndefined();
		expect(evt.meta).toBeUndefined();
		// Trigger declaration name lives under input.trigger so the dashboard
		// query can reconstruct synthetic invocation rows without a
		// trigger.request to join against.
		expect((evt.input as Record<string, unknown> | undefined)?.trigger).toBe(
			"inbound",
		);
		expect((evt.input as Record<string, unknown> | undefined)?.stage).toBe(
			"connect",
		);
	});

	it("does not touch the SandboxStore or run queue", async () => {
		const { executor, store } = setup();
		await executor.fail(
			"acme",
			"billing",
			makeManifest("wf"),
			makeDescriptor("inbound"),
			{ name: "imap.poll-failed", error: { message: "boom" } },
		);
		expect(store.get).not.toHaveBeenCalled();
	});

	it("mints a fresh evt_* invocation id on each call", async () => {
		const { executor, seen } = setup();
		const workflow = makeManifest("wf");
		const descriptor = makeDescriptor("t");
		await executor.fail("o", "r", workflow, descriptor, {
			name: "imap.poll-failed",
			error: { message: "x" },
		});
		await executor.fail("o", "r", workflow, descriptor, {
			name: "imap.poll-failed",
			error: { message: "y" },
		});
		expect(seen).toHaveLength(2);
		expect(seen[0]?.id).not.toBe(seen[1]?.id);
		expect(seen[0]?.id).toMatch(EVT_ID_RE);
		expect(seen[1]?.id).toMatch(EVT_ID_RE);
	});

	it("strips the stack trace even when the caller passes one", async () => {
		const { executor, seen } = setup();
		await executor.fail(
			"o",
			"r",
			makeManifest("wf"),
			makeDescriptor("t"),
			// @ts-expect-error — TriggerExceptionParams.error is `{ message }`
			// only by contract; verifying runtime defense in depth.
			{ name: "imap.poll-failed", error: { message: "boom", stack: "x:1" } },
		);
		const evt = seen[0];
		if (!evt) {
			throw new Error("expected event");
		}
		expect(evt.error?.message).toBe("boom");
		expect(evt.error?.stack).toBeUndefined();
	});
});

// Decrypt coverage moved to packages/runtime/src/secrets/decrypt-workflow.test.ts
// — sandbox-store now owns the decrypt step at construction time, not the
// executor. Executor is crypto-agnostic after workflow-secrets.

describe("executor: structural invariants", () => {
	it("executor source has no string-keyed runQueue map", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(resolve(here, "index.ts"), "utf8");
		// Old shape: `new Map<string, RunQueue>()` or `queues: Map<...`.
		expect(src).not.toMatch(/Map<string,\s*RunQueue>/);
		expect(src).not.toMatch(/\bqueueFor\s*\(/);
		// Consolidated shape.
		expect(src).toMatch(/WeakMap<Sandbox,\s*SandboxState>/);
	});
});

describe("executor: per-sandbox state consolidation", () => {
	it("uses a distinct runQueue per sandbox instance — re-emerging (owner, sha) after eviction gets a fresh queue", async () => {
		// Simulate eviction: two distinct Sandbox instances returned across
		// two store.get() calls for the same (owner, workflow.sha) key. The
		// executor must treat them as independent sandboxes (no cross-queue
		// serialization), which would be impossible under the old
		// string-keyed `queues: Map<string, RunQueue>`.
		const sandboxA = makeSandbox();
		const sandboxB = makeSandbox();
		const store: SandboxStore = {
			get: vi
				.fn<SandboxStore["get"]>()
				.mockResolvedValueOnce(sandboxA)
				.mockResolvedValueOnce(sandboxB),
			dispose: vi.fn<SandboxStore["dispose"]>().mockResolvedValue(undefined),
		};
		const bus: EventBus = { emit: vi.fn().mockResolvedValue(undefined) };
		const executor = createExecutor({ bus, sandboxStore: store });
		const workflow = makeManifest("w");
		const descriptor = makeDescriptor("t", "w");
		const r1 = await executor.invoke("o", "r", workflow, descriptor, null, {
			bundleSource: "x",
		});
		const r2 = await executor.invoke("o", "r", workflow, descriptor, null, {
			bundleSource: "x",
		});
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		// Each sandbox was subscribed to exactly once — no double-wire and no
		// shared subscription across instances.
		expect(
			(sandboxA.onEvent as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBe(1);
		expect(
			(sandboxB.onEvent as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBe(1);
		expect((sandboxA.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
			1,
		);
		expect((sandboxB.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
			1,
		);
	});

	it("stamping still runs after the state refactor (R-8/R-9)", async () => {
		const capture = { eventCallbacks: [] as ((e: SandboxEvent) => void)[] };
		const sandbox = makeSandbox({
			capture,
			onRun: () => {
				// Fire a synthetic event during the run — the widener on the
				// state-side onEvent must stamp invocation metadata onto it.
				const event: SandboxEvent = {
					kind: "trigger.request",
					seq: 1,
					ref: null,
					at: "host",
					ts: Date.now(),
					name: "t",
					input: { body: {} },
				};
				for (const cb of capture.eventCallbacks) {
					cb(event);
				}
				return { status: 200 };
			},
		});
		const seen: InvocationEvent[] = [];
		const bus: EventBus = {
			emit: async (e) => {
				seen.push(e);
			},
		};
		const executor = createExecutor({
			bus,
			sandboxStore: makeStore(sandbox),
		});
		await executor.invoke(
			"acme",
			"demo",
			makeManifest("w", "abc"),
			makeDescriptor("t", "w"),
			null,
			{
				bundleSource: "x",
				dispatch: {
					source: "manual",
					user: { login: "alice", mail: "a@x" },
				},
			},
		);
		expect(seen).toHaveLength(1);
		const e = seen[0];
		expect(e?.id).toMatch(EVT_ID_RE);
		expect(e?.owner).toBe("acme");
		expect(e?.repo).toBe("demo");
		expect(e?.workflow).toBe("w");
		expect(e?.workflowSha).toBe("abc");
		// `trigger.request` carries `meta.dispatch`.
		expect(e?.meta?.dispatch).toEqual({
			source: "manual",
			user: { login: "alice", mail: "a@x" },
		});
	});
});
