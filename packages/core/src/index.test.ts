import { describe, expect, it } from "vitest";
import type { EventKind, InvocationEvent } from "./index.js";
import { IIFE_NAMESPACE } from "./index.js";

describe("IIFE_NAMESPACE", () => {
	it("is the shared constant used by plugin, runtime, and sandbox", () => {
		expect(IIFE_NAMESPACE).toBe("__wfe_exports__");
	});
});

describe("EventKind", () => {
	it("includes the five timer kinds", () => {
		// The `satisfies` clause is a compile-time assertion that each literal is
		// a member of the EventKind union. A `timer.tick` (not in the union) would
		// fail compilation here, covering the negative case at the type level.
		const timerKinds = [
			"timer.set",
			"timer.request",
			"timer.response",
			"timer.error",
			"timer.clear",
		] as const satisfies readonly EventKind[];
		expect(timerKinds).toHaveLength(5);
	});

	it("InvocationEvent accepts timer kinds with the expected fields", () => {
		const setEvent: InvocationEvent = {
			kind: "timer.set",
			id: "evt_1",
			seq: 0,
			ref: 1,
			ts: 1,
			workflow: "w",
			workflowSha: "sha",
			name: "setTimeout",
			input: { delay: 100, timerId: 7 },
		};
		const requestEvent: InvocationEvent = {
			kind: "timer.request",
			id: "evt_1",
			seq: 1,
			ref: null,
			ts: 2,
			workflow: "w",
			workflowSha: "sha",
			name: "setTimeout",
			input: { timerId: 7 },
		};
		const responseEvent: InvocationEvent = {
			kind: "timer.response",
			id: "evt_1",
			seq: 2,
			ref: 1,
			ts: 3,
			workflow: "w",
			workflowSha: "sha",
			name: "setTimeout",
			input: { timerId: 7 },
			output: "ok",
		};
		const errorEvent: InvocationEvent = {
			kind: "timer.error",
			id: "evt_1",
			seq: 3,
			ref: 1,
			ts: 4,
			workflow: "w",
			workflowSha: "sha",
			name: "setTimeout",
			input: { timerId: 7 },
			error: { message: "boom", stack: "stack" },
		};
		const clearEvent: InvocationEvent = {
			kind: "timer.clear",
			id: "evt_1",
			seq: 4,
			ref: null,
			ts: 5,
			workflow: "w",
			workflowSha: "sha",
			name: "clearTimeout",
			input: { timerId: 7 },
		};
		expect(setEvent.kind).toBe("timer.set");
		expect(requestEvent.ref).toBeNull();
		expect(responseEvent.output).toBe("ok");
		expect(errorEvent.error?.message).toBe("boom");
		expect(clearEvent.name).toBe("clearTimeout");
	});
});
