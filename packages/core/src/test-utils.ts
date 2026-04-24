import type { InvocationEvent } from "./index.js";

const DEFAULT_AT = "2026-04-16T10:00:00.000Z";

function makeEvent(overrides: Partial<InvocationEvent> = {}): InvocationEvent {
	return {
		kind: "trigger.request",
		id: "evt_test",
		seq: 0,
		ref: null,
		at: DEFAULT_AT,
		ts: 0,
		owner: "t0",
		workflow: "w",
		workflowSha: "sha",
		name: "t",
		...overrides,
	};
}

export { makeEvent };
