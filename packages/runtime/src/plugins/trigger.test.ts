import { recordingContext } from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
import { name as TRIGGER_PLUGIN_NAME, worker } from "./trigger.js";

describe("trigger plugin", () => {
	it("has the expected name", () => {
		expect(TRIGGER_PLUGIN_NAME).toBe("trigger");
	});

	it("worker() returns both lifecycle hooks", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		expect(typeof setup.onBeforeRunStarted).toBe("function");
		expect(typeof setup.onRunFinished).toBe("function");
	});

	it("emits trigger.request with type:'open' before the run and returns truthy", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		const kept = setup.onBeforeRunStarted?.({
			name: "doWork",
			input: { foo: "bar" },
		});
		expect(kept).toBe(true);
		expect(ctx.events).toHaveLength(1);
		expect(ctx.events[0]?.kind).toBe("trigger.request");
		expect(ctx.events[0]?.options.name).toBe("doWork");
		expect(ctx.events[0]?.options.input).toEqual({ foo: "bar" });
		expect(ctx.events[0]?.options.type).toBe("open");
	});

	it("emits trigger.response with {close: openCallId} on success", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		setup.onBeforeRunStarted?.({ name: "doWork", input: { foo: "bar" } });
		const openType = ctx.events[0]?.options.type as "open" | { open: number };
		// Captured open callId is what recordingContext returned (0 for first emit).
		const openCallId = 0;
		setup.onRunFinished?.(
			{ ok: true, output: { status: "ok" } },
			{ name: "doWork", input: { foo: "bar" } },
		);
		expect(ctx.events).toHaveLength(2);
		expect(ctx.events[1]?.kind).toBe("trigger.response");
		expect(ctx.events[1]?.options.input).toEqual({ foo: "bar" });
		expect(ctx.events[1]?.options.output).toEqual({ status: "ok" });
		expect(ctx.events[1]?.options.type).toEqual({ close: openCallId });
		// Sanity: the SDK input value of the open was indeed "open" string
		expect(openType).toBe("open");
	});

	it("emits trigger.error with {close: openCallId} on failure, serialising the error", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		setup.onBeforeRunStarted?.({ name: "doWork", input: { foo: "bar" } });
		const err = new Error("fail");
		err.stack = "stack-trace";
		setup.onRunFinished?.(
			{ ok: false, error: err },
			{ name: "doWork", input: { foo: "bar" } },
		);
		expect(ctx.events).toHaveLength(2);
		const evt = ctx.events[1];
		expect(evt?.kind).toBe("trigger.error");
		expect(evt?.options.name).toBe("doWork");
		expect(evt?.options.type).toEqual({ close: 0 });
		expect(evt?.options.input).toEqual({ foo: "bar" });
		expect(evt?.options.error).toEqual({
			message: "fail",
			stack: "stack-trace",
		});
	});

	it("preserves Zod-style `issues` on ValidationError-like thrown objects", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		setup.onBeforeRunStarted?.({ name: "doWork", input: {} });
		const err = new Error("bad") as Error & { issues: unknown };
		err.issues = [{ path: "foo", message: "required" }];
		setup.onRunFinished?.(
			{ ok: false, error: err },
			{ name: "doWork", input: {} },
		);
		const error = ctx.events[1]?.options.error as { issues: unknown };
		expect(error.issues).toEqual([{ path: "foo", message: "required" }]);
	});

	it("handles non-Error failures by stringifying them with empty stack", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		setup.onBeforeRunStarted?.({ name: "doWork", input: {} });
		setup.onRunFinished?.(
			{ ok: false, error: "string-reason" as unknown as Error },
			{ name: "doWork", input: {} },
		);
		const error = ctx.events[1]?.options.error;
		expect(error).toEqual({ message: "string-reason", stack: "" });
	});

	it("captures distinct CallIds across consecutive runs", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		// Run 1
		setup.onBeforeRunStarted?.({ name: "first", input: {} });
		setup.onRunFinished?.(
			{ ok: true, output: null },
			{ name: "first", input: {} },
		);
		// Run 2
		setup.onBeforeRunStarted?.({ name: "second", input: {} });
		setup.onRunFinished?.(
			{ ok: true, output: null },
			{ name: "second", input: {} },
		);
		// Each close should pair with the matching open's CallId (0 then 1).
		expect(ctx.events[1]?.options.type).toEqual({ close: 0 });
		expect(ctx.events[3]?.options.type).toEqual({ close: 1 });
	});
});
