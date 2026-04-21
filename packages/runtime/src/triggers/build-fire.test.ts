import type { WorkflowManifest } from "@workflow-engine/core";
import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../executor/index.js";
import type { HttpTriggerDescriptor } from "../executor/types.js";
import { buildFire } from "./build-fire.js";

// ---------------------------------------------------------------------------
// buildFire unit tests
// ---------------------------------------------------------------------------

function makeWorkflow(): WorkflowManifest {
	return {
		name: "w",
		module: "w.js",
		sha: "0".repeat(64),
		env: {},
		actions: [],
		triggers: [],
	};
}

function makeDescriptor(): HttpTriggerDescriptor {
	return {
		kind: "http",
		type: "http",
		name: "handler",
		workflowName: "w",
		method: "POST",
		body: { type: "object" },
		inputSchema: {
			type: "object",
			properties: {
				body: {
					type: "object",
					properties: { name: { type: "string" } },
					required: ["name"],
				},
			},
			required: ["body"],
		},
		outputSchema: { type: "object" },
	};
}

describe("buildFire", () => {
	it("validates input and dispatches through the executor on success", async () => {
		const invoke = vi
			.fn<Executor["invoke"]>()
			.mockResolvedValue({ ok: true, output: { status: 200 } });
		const executor: Executor = { invoke };
		const descriptor = makeDescriptor();
		const workflow = makeWorkflow();
		const fire = buildFire(
			executor,
			"acme",
			workflow,
			descriptor,
			"bundle-src",
		);

		const input = { body: { name: "alice" } };
		const result = await fire(input);

		expect(result).toEqual({ ok: true, output: { status: 200 } });
		expect(invoke).toHaveBeenCalledTimes(1);
		const call = invoke.mock.calls[0];
		if (!call) {
			throw new Error("invoke was not called");
		}
		expect(call[0]).toBe("acme");
		expect(call[1]).toBe(workflow);
		expect(call[2]).toBe(descriptor);
		expect(call[3]).toEqual(input);
		expect(call[4]).toBe("bundle-src");
	});

	it("returns {ok:false} without calling executor on validation failure", async () => {
		const invoke = vi.fn<Executor["invoke"]>();
		const executor: Executor = { invoke };
		const fire = buildFire(
			executor,
			"acme",
			makeWorkflow(),
			makeDescriptor(),
			"bundle-src",
		);

		const result = await fire({ body: {} }); // missing `name`

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected failure");
		}
		expect(result.error.message).toBe("payload_validation_failed");
		expect(result.error.issues?.length ?? 0).toBeGreaterThan(0);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("propagates executor rejection envelope unchanged", async () => {
		const invoke = vi
			.fn<Executor["invoke"]>()
			.mockResolvedValue({ ok: false, error: { message: "boom" } });
		const executor: Executor = { invoke };
		const fire = buildFire(
			executor,
			"acme",
			makeWorkflow(),
			makeDescriptor(),
			"bundle-src",
		);

		const result = await fire({ body: { name: "alice" } });

		expect(result).toEqual({ ok: false, error: { message: "boom" } });
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("passes the validated (structured-cloned) input, not the raw reference", async () => {
		const invoke = vi
			.fn<Executor["invoke"]>()
			.mockResolvedValue({ ok: true, output: {} });
		const executor: Executor = { invoke };
		const fire = buildFire(
			executor,
			"acme",
			makeWorkflow(),
			makeDescriptor(),
			"bundle-src",
		);

		const input = { body: { name: "alice" } };
		await fire(input);
		const call = invoke.mock.calls[0];
		if (!call) {
			throw new Error("invoke was not called");
		}
		// validator returns a deep clone, so the reference must differ.
		expect(call[3]).toEqual(input);
		expect(call[3]).not.toBe(input);
	});
});
