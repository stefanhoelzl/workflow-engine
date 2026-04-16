import type { HttpTriggerResult } from "@workflow-engine/core";
import { describe, expect, it } from "vitest";
import {
	type BusConsumer,
	createEventBus,
	type InvocationLifecycleEvent,
} from "../event-bus/index.js";
import { createExecutor } from "./index.js";
import type { WorkflowRunner } from "./types.js";

// Capture-all consumer — dispatches are fully synchronous-ordered so each
// entry lands before the executor returns.
function makeRecorder() {
	const events: InvocationLifecycleEvent[] = [];
	const consumer: BusConsumer = {
		async handle(event) {
			events.push(event);
		},
	};
	return { events, consumer };
}

interface BuildRunnerOpts {
	name: string;
	handler: (payload: unknown) => Promise<unknown>;
}

function buildRunner(opts: BuildRunnerOpts): WorkflowRunner {
	return {
		name: opts.name,
		env: Object.freeze({}),
		actions: [],
		triggers: [
			{
				name: "webhook",
				type: "http",
				path: "/",
				method: "POST",
				params: [],
				body: { parse: (d) => d },
			},
		],
		invokeHandler: async (_name, payload) => {
			const raw = await opts.handler(payload);
			return raw as HttpTriggerResult;
		},
	};
}

describe("executor.invoke — result shaping", () => {
	it("returns handler's full response with defaults where missing", async () => {
		const { consumer } = makeRecorder();
		const bus = createEventBus([consumer]);
		const executor = createExecutor({ bus });
		const runner = buildRunner({
			name: "w1",
			handler: async () => ({
				status: 202,
				body: { ok: true },
				headers: { x: "1" },
			}),
		});

		const result = await executor.invoke(runner, "webhook", {});
		expect(result).toEqual({
			status: 202,
			body: { ok: true },
			headers: { x: "1" },
		});
	});

	it("fills defaults for a partial response", async () => {
		const { consumer } = makeRecorder();
		const bus = createEventBus([consumer]);
		const executor = createExecutor({ bus });
		const runner = buildRunner({
			name: "w1",
			handler: async () => ({ status: 204 }),
		});

		const result = await executor.invoke(runner, "webhook", {});
		expect(result).toEqual({ status: 204, body: "", headers: {} });
	});

	it("returns the full default shape when handler returns undefined", async () => {
		const { consumer } = makeRecorder();
		const bus = createEventBus([consumer]);
		const executor = createExecutor({ bus });
		const runner = buildRunner({
			name: "w1",
			handler: async () => undefined,
		});

		const result = await executor.invoke(runner, "webhook", {});
		expect(result).toEqual({ status: 200, body: "", headers: {} });
	});

	it("maps handler throw to 500 + internal_error body", async () => {
		const { consumer } = makeRecorder();
		const bus = createEventBus([consumer]);
		const executor = createExecutor({ bus });
		const runner = buildRunner({
			name: "w1",
			handler: async () => {
				throw new Error("boom");
			},
		});

		const result = await executor.invoke(runner, "webhook", {});
		expect(result).toEqual({
			status: 500,
			body: { error: "internal_error" },
			headers: {},
		});
	});
});

describe("executor.invoke — bus emission", () => {
	it("emits started before dispatching the handler, completed after", async () => {
		const { events, consumer } = makeRecorder();
		const bus = createEventBus([consumer]);
		const executor = createExecutor({ bus });

		const handlerEvents: string[] = [];
		const runner = buildRunner({
			name: "w1",
			handler: async () => {
				handlerEvents.push("handler");
				return { status: 200 };
			},
		});

		await executor.invoke(runner, "webhook", { x: 1 });

		expect(events.map((e) => e.kind)).toEqual(["started", "completed"]);
		expect(events[0]?.id).toBe(events[1]?.id);
		expect(events[0]?.workflow).toBe("w1");
		expect(events[0]?.trigger).toBe("webhook");
		const started = events[0] as Extract<
			InvocationLifecycleEvent,
			{ kind: "started" }
		>;
		expect(started.input).toEqual({ x: 1 });
		expect(handlerEvents).toEqual(["handler"]);
	});

	it("emits failed with serialized error on throw", async () => {
		const { events, consumer } = makeRecorder();
		const bus = createEventBus([consumer]);
		const executor = createExecutor({ bus });
		const runner = buildRunner({
			name: "w1",
			handler: async () => {
				throw new Error("boom");
			},
		});

		await executor.invoke(runner, "webhook", {});

		expect(events.map((e) => e.kind)).toEqual(["started", "failed"]);
		const failed = events[1] as Extract<
			InvocationLifecycleEvent,
			{ kind: "failed" }
		>;
		expect(failed.error.message).toBe("boom");
		expect(typeof failed.error.stack).toBe("string");
	});

	it("propagates Zod-style issues on failure", async () => {
		const { events, consumer } = makeRecorder();
		const bus = createEventBus([consumer]);
		const executor = createExecutor({ bus });
		const runner = buildRunner({
			name: "w1",
			handler: async () => {
				const err = new Error("validation") as Error & { issues: unknown[] };
				err.name = "ZodError";
				err.issues = [{ path: ["foo"], message: "Required" }];
				throw err;
			},
		});

		await executor.invoke(runner, "webhook", {});
		const failed = events[1] as Extract<
			InvocationLifecycleEvent,
			{ kind: "failed" }
		>;
		expect(failed.error.issues).toEqual([
			{ path: ["foo"], message: "Required" },
		]);
	});
});

describe("executor.invoke — serialization", () => {
	it("serializes two invocations of the same workflow", async () => {
		const { consumer } = makeRecorder();
		const bus = createEventBus([consumer]);
		const executor = createExecutor({ bus });

		const runStart: string[] = [];
		let resolveFirst: () => void = () => undefined;
		const firstGate = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});

		const runner = buildRunner({
			name: "w1",
			handler: async (payload) => {
				const label = (payload as { label: string }).label;
				runStart.push(label);
				if (label === "a") {
					await firstGate;
				}
				return { status: 200 };
			},
		});

		const p1 = executor.invoke(runner, "webhook", { label: "a" });
		const p2 = executor.invoke(runner, "webhook", { label: "b" });

		// Give the event loop a chance. Only `a` should have started.
		await new Promise((r) => setTimeout(r, 5));
		expect(runStart).toEqual(["a"]);

		resolveFirst();
		await Promise.all([p1, p2]);
		expect(runStart).toEqual(["a", "b"]);
	});

	it("runs two workflows in parallel", async () => {
		const { consumer } = makeRecorder();
		const bus = createEventBus([consumer]);
		const executor = createExecutor({ bus });

		let aStarted = false;
		let bStarted = false;
		let resolveA: () => void = () => undefined;
		const aGate = new Promise<void>((r) => {
			resolveA = r;
		});

		const runnerA = buildRunner({
			name: "wA",
			handler: async () => {
				aStarted = true;
				await aGate;
				return { status: 200 };
			},
		});
		const runnerB = buildRunner({
			name: "wB",
			handler: async () => {
				bStarted = true;
				return { status: 200 };
			},
		});

		const pA = executor.invoke(runnerA, "webhook", {});
		const pB = executor.invoke(runnerB, "webhook", {});

		await new Promise((r) => setTimeout(r, 5));
		expect(aStarted).toBe(true);
		expect(bStarted).toBe(true);

		resolveA();
		await Promise.all([pA, pB]);
	});

	it("a failure does not block the next invocation", async () => {
		const { consumer } = makeRecorder();
		const bus = createEventBus([consumer]);
		const executor = createExecutor({ bus });

		let secondRan = false;
		const runner = buildRunner({
			name: "w1",
			handler: async (payload) => {
				if ((payload as { fail?: boolean }).fail) {
					throw new Error("first fails");
				}
				secondRan = true;
				return { status: 200 };
			},
		});

		const p1 = executor.invoke(runner, "webhook", { fail: true });
		const p2 = executor.invoke(runner, "webhook", {});

		await Promise.all([p1, p2]);
		expect(secondRan).toBe(true);
	});
});

describe("executor.invoke — bus commit-before-observe", () => {
	it("completes bus dispatch before resolving to caller", async () => {
		const order: string[] = [];
		const persistence: BusConsumer = {
			async handle(event) {
				await new Promise((r) => setTimeout(r, 5));
				order.push(`persistence:${event.kind}`);
			},
		};
		const bus = createEventBus([persistence]);
		const executor = createExecutor({ bus });

		const runner = buildRunner({
			name: "w1",
			handler: async () => {
				order.push("handler");
				return { status: 200 };
			},
		});

		await executor.invoke(runner, "webhook", {});
		order.push("caller-returned");

		expect(order).toEqual([
			"persistence:started",
			"handler",
			"persistence:completed",
			"caller-returned",
		]);
	});
});
