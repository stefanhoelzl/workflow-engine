import type { InvocationEvent } from "@workflow-engine/core";
import { makeEvent } from "@workflow-engine/core/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createEventBus, type EventBus } from "../event-bus/index.js";
import { createExecutor } from "./index.js";
import type { WorkflowRunner } from "./types.js";

const EVT_ID_RE = /^evt_/;

function makeRunner(
	overrides: Partial<WorkflowRunner> & Pick<WorkflowRunner, "name">,
): WorkflowRunner {
	const base: WorkflowRunner = {
		tenant: "t0",
		name: overrides.name,
		env: Object.freeze({}),
		actions: [],
		triggers: [],
		invokeHandler: async () => ({ status: 200 }),
		onEvent: () => {
			/* no-op */
		},
	};
	return { ...base, ...overrides };
}

describe("executor", () => {
	it("generates an invocation id and passes it to invokeHandler", async () => {
		const handler = vi.fn().mockResolvedValue({ status: 200 });
		const runner = makeRunner({
			name: "wf",
			invokeHandler: handler as WorkflowRunner["invokeHandler"],
		});
		const bus = createEventBus([]);
		const executor = createExecutor({ bus });

		await executor.invoke(runner, "trig", { hello: "world" });

		expect(handler).toHaveBeenCalledTimes(1);
		const args = handler.mock.calls[0];
		if (!args) {
			throw new Error("expected at least one call");
		}
		expect(typeof args[0]).toBe("string");
		expect(args[0]).toMatch(EVT_ID_RE);
		expect(args[1]).toBe("trig");
		expect(args[2]).toEqual({ hello: "world" });
	});

	it("wires onEvent → bus.emit on first invoke and reuses the wiring", async () => {
		const registrations: ((e: InvocationEvent) => void)[] = [];
		const runner = makeRunner({
			name: "wf",
			onEvent: (cb) => {
				registrations.push(cb);
			},
		});
		const seen: InvocationEvent[] = [];
		const bus: EventBus = {
			emit: async (e) => {
				seen.push(e);
			},
		};
		const executor = createExecutor({ bus });

		await executor.invoke(runner, "t", null);
		await executor.invoke(runner, "t", null);

		// onEvent should be wired exactly once across multiple invocations.
		expect(registrations).toHaveLength(1);

		const evt: InvocationEvent = makeEvent({
			kind: "trigger.request",
			id: "evt_x",
			seq: 0,
			ref: null,
			ts: 1,
			workflow: "wf",
		});
		const cb = registrations[0];
		if (!cb) {
			throw new Error("expected onEvent to have been called");
		}
		cb(evt);
		await new Promise((r) => setImmediate(r));
		expect(seen).toContain(evt);
	});

	it("shapes a missing return value into a default 200 response", async () => {
		const runner = makeRunner({
			name: "wf",
			invokeHandler: async () => undefined as unknown as never,
		});
		const bus = createEventBus([]);
		const executor = createExecutor({ bus });
		const result = await executor.invoke(runner, "t", null);
		expect(result.status).toBe(200);
	});

	it("returns a 500 response when invokeHandler throws", async () => {
		const runner = makeRunner({
			name: "wf",
			invokeHandler: async () => {
				throw new Error("boom");
			},
		});
		const bus = createEventBus([]);
		const executor = createExecutor({ bus });
		const result = await executor.invoke(runner, "t", null);
		expect(result.status).toBe(500);
		expect(result.body).toEqual({ error: "internal_error" });
	});

	it("serializes invocations of the same workflow via the runQueue", async () => {
		const callOrder: string[] = [];
		let active = 0;
		let maxActive = 0;
		const runner = makeRunner({
			name: "wf",
			invokeHandler: async (id) => {
				active++;
				maxActive = Math.max(maxActive, active);
				callOrder.push(`start:${id}`);
				await new Promise((r) => setTimeout(r, 5));
				callOrder.push(`end:${id}`);
				active--;
				return { status: 200 };
			},
		});
		const bus = createEventBus([]);
		const executor = createExecutor({ bus });

		await Promise.all([
			executor.invoke(runner, "t", null),
			executor.invoke(runner, "t", null),
			executor.invoke(runner, "t", null),
		]);

		expect(maxActive).toBe(1);
		expect(callOrder.length).toBe(6);
	});
});
