import type { InvocationEvent } from "@workflow-engine/core";
import { describe, expect, it, vi } from "vitest";
import { type BusConsumer, createEventBus } from "./index.js";

function makeEvent(seq: number): InvocationEvent {
	return {
		kind: "system.request",
		id: "evt_test",
		seq,
		ref: null,
		ts: 1000 + seq,
		workflow: "wf",
		workflowSha: "sha",
		name: "console.log",
		input: ["hello"],
	};
}

describe("createEventBus", () => {
	it("fans out one event to every consumer", async () => {
		const a: BusConsumer = { handle: vi.fn().mockResolvedValue(undefined) };
		const b: BusConsumer = { handle: vi.fn().mockResolvedValue(undefined) };
		const bus = createEventBus([a, b]);

		const event = makeEvent(0);
		await bus.emit(event);

		expect(a.handle).toHaveBeenCalledWith(event);
		expect(b.handle).toHaveBeenCalledWith(event);
	});

	it("awaits consumers in registration order", async () => {
		const calls: string[] = [];
		const first: BusConsumer = {
			handle: async () => {
				await new Promise((r) => setTimeout(r, 5));
				calls.push("first");
			},
		};
		const second: BusConsumer = {
			handle: async () => {
				calls.push("second");
			},
		};
		const bus = createEventBus([first, second]);

		await bus.emit(makeEvent(0));

		expect(calls).toEqual(["first", "second"]);
	});

	it("propagates a consumer error and skips subsequent consumers", async () => {
		const boom = new Error("boom");
		const failing: BusConsumer = {
			handle: vi.fn().mockRejectedValue(boom),
		};
		const after: BusConsumer = { handle: vi.fn() };
		const bus = createEventBus([failing, after]);

		await expect(bus.emit(makeEvent(0))).rejects.toThrow("boom");
		expect(after.handle).not.toHaveBeenCalled();
	});

	it("emits with no consumers as a no-op", async () => {
		const bus = createEventBus([]);
		await expect(bus.emit(makeEvent(0))).resolves.toBeUndefined();
	});
});
