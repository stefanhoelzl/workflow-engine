import type {
	EmitOptions,
	EventExtra,
	SandboxContext,
} from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
import { name as TRIGGER_PLUGIN_NAME, worker } from "./trigger.js";

interface EmittedEvent {
	kind: string;
	name: string;
	extra: EventExtra;
	options?: EmitOptions;
}

function recordingContext(): SandboxContext & {
	readonly events: EmittedEvent[];
} {
	const events: EmittedEvent[] = [];
	return {
		events,
		emit(kind, name, extra, options) {
			events.push({
				kind,
				name,
				extra,
				...(options === undefined ? {} : { options }),
			});
		},
		request(_prefix, _name, _extra, fn) {
			return fn();
		},
	};
}

describe("trigger plugin (§10 shape)", () => {
	it("has the expected name", () => {
		expect(TRIGGER_PLUGIN_NAME).toBe("trigger");
	});

	it("worker() returns both lifecycle hooks", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		expect(typeof setup.onBeforeRunStarted).toBe("function");
		expect(typeof setup.onRunFinished).toBe("function");
	});

	it("emits trigger.request with createsFrame:true before the run and returns truthy to preserve the frame", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		const kept = setup.onBeforeRunStarted?.({
			name: "doWork",
			input: { foo: "bar" },
		});
		expect(kept).toBe(true);
		expect(ctx.events).toEqual([
			{
				kind: "trigger.request",
				name: "doWork",
				extra: { input: { foo: "bar" } },
				options: { createsFrame: true },
			},
		]);
	});

	it("emits trigger.response with closesFrame:true on a successful run, carrying both input and output", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		setup.onRunFinished?.(
			{ ok: true, output: { status: "ok" } },
			{ name: "doWork", input: { foo: "bar" } },
		);
		expect(ctx.events).toEqual([
			{
				kind: "trigger.response",
				name: "doWork",
				extra: { input: { foo: "bar" }, output: { status: "ok" } },
				options: { closesFrame: true },
			},
		]);
	});

	it("emits trigger.error with closesFrame:true on failure, serialising the error to {message, stack}", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		const err = new Error("fail");
		err.stack = "stack-trace";
		setup.onRunFinished?.(
			{ ok: false, error: err },
			{ name: "doWork", input: { foo: "bar" } },
		);
		expect(ctx.events).toHaveLength(1);
		const [evt] = ctx.events;
		expect(evt?.kind).toBe("trigger.error");
		expect(evt?.name).toBe("doWork");
		expect(evt?.options).toEqual({ closesFrame: true });
		const extra = evt?.extra as { input: unknown; error: unknown };
		expect(extra.input).toEqual({ foo: "bar" });
		expect(extra.error).toEqual({ message: "fail", stack: "stack-trace" });
	});

	it("preserves Zod-style `issues` on ValidationError-like thrown objects", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		const err = new Error("bad") as Error & { issues: unknown };
		err.issues = [{ path: "foo", message: "required" }];
		setup.onRunFinished?.(
			{ ok: false, error: err },
			{ name: "doWork", input: {} },
		);
		const extra = ctx.events[0]?.extra as { error: { issues: unknown } };
		expect(extra.error.issues).toEqual([{ path: "foo", message: "required" }]);
	});

	it("handles non-Error failures by stringifying them with empty stack", () => {
		const ctx = recordingContext();
		const setup = worker(ctx);
		setup.onRunFinished?.(
			{ ok: false, error: "string-reason" as unknown as Error },
			{ name: "doWork", input: {} },
		);
		const extra = ctx.events[0]?.extra as { error: unknown };
		expect(extra.error).toEqual({ message: "string-reason", stack: "" });
	});
});
