import { describe, expect, it } from "vitest";
import { EVT_ID_RE, newInvocation } from "./invocation.js";

describe("newInvocation", () => {
	it("produces an id with evt_ prefix and sufficient length", () => {
		const inv = newInvocation({
			workflow: "w",
			trigger: "t",
			payload: {},
		});
		expect(inv.id).toMatch(EVT_ID_RE);
	});

	it("builds a startedEvent carrying id/workflow/trigger/input/ts", () => {
		const fixedTs = new Date("2026-01-01T00:00:00.000Z");
		const inv = newInvocation({
			workflow: "wf",
			trigger: "tr",
			payload: { foo: 1 },
			id: "evt_fixed001",
			now: () => fixedTs,
		});
		expect(inv.startedEvent).toEqual({
			kind: "started",
			id: "evt_fixed001",
			workflow: "wf",
			trigger: "tr",
			ts: fixedTs,
			input: { foo: 1 },
		});
	});

	it("complete(result) builds the completed event", () => {
		const inv = newInvocation({
			workflow: "w",
			trigger: "t",
			payload: {},
			id: "evt_abcdef01",
		});
		const completed = inv.complete(
			{ status: 202, body: { ok: true }, headers: {} },
			new Date("2026-01-01T00:00:01.000Z"),
		);
		expect(completed).toEqual({
			kind: "completed",
			id: "evt_abcdef01",
			workflow: "w",
			trigger: "t",
			ts: new Date("2026-01-01T00:00:01.000Z"),
			result: { status: 202, body: { ok: true }, headers: {} },
		});
	});

	it("fail(error) builds the failed event", () => {
		const inv = newInvocation({
			workflow: "w",
			trigger: "t",
			payload: {},
			id: "evt_abcdef01",
		});
		const failed = inv.fail(
			{ message: "boom", stack: "" },
			new Date("2026-01-01T00:00:01.000Z"),
		);
		expect(failed.kind).toBe("failed");
		expect(failed.id).toBe("evt_abcdef01");
		expect(failed.error).toEqual({ message: "boom", stack: "" });
	});
});
