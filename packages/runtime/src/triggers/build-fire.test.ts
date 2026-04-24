import type { WorkflowManifest } from "@workflow-engine/core";
import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../executor/index.js";
import type {
	CronTriggerDescriptor,
	HttpTriggerDescriptor,
} from "../executor/types.js";
import type { Logger } from "../logger.js";
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

function makeDescriptor(
	outputSchema: Record<string, unknown> = { type: "object" },
): HttpTriggerDescriptor {
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
		outputSchema,
	};
}

function makeCronDescriptor(): CronTriggerDescriptor {
	return {
		kind: "cron",
		type: "cron",
		name: "tick",
		workflowName: "w",
		schedule: "* * * * *",
		tz: "UTC",
		inputSchema: { type: "object" },
		outputSchema: {}, // z.unknown() emits as empty schema — matches anything
	};
}

function makeSilentLogger(): Logger & {
	readonly warnings: Array<{ msg: string; data?: Record<string, unknown> }>;
} {
	const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
	const base = {
		info: vi.fn(),
		warn: vi.fn((msg: string, data?: Record<string, unknown>) =>
			warnings.push({ msg, ...(data ? { data } : {}) }),
		),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
	const logger = {
		...base,
		child: vi.fn(() => logger),
	} as unknown as Logger;
	(logger as unknown as { warnings: typeof warnings }).warnings = warnings;
	return logger as Logger & {
		readonly warnings: typeof warnings;
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
		expect(call[4]).toEqual({ bundleSource: "bundle-src" });
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

	it("passes handler output through when it matches descriptor.outputSchema", async () => {
		const outputSchema = {
			type: "object",
			additionalProperties: false,
			properties: {
				status: { type: "number" },
				body: {},
				headers: {
					type: "object",
					additionalProperties: { type: "string" },
				},
			},
		};
		const invoke = vi
			.fn<Executor["invoke"]>()
			.mockResolvedValue({ ok: true, output: { status: 202 } });
		const executor: Executor = { invoke };
		const logger = makeSilentLogger();
		const fire = buildFire(
			executor,
			"acme",
			makeWorkflow(),
			makeDescriptor(outputSchema),
			"bundle-src",
			logger,
		);

		const result = await fire({ body: { name: "alice" } });

		expect(result).toEqual({ ok: true, output: { status: 202 } });
		expect(logger.warnings).toEqual([]);
	});

	it("turns output-schema mismatch into a no-issues failure (routes to 500) and logs structured issues", async () => {
		const outputSchema = {
			type: "object",
			additionalProperties: false,
			properties: {
				status: { type: "number" },
				body: {},
				headers: {
					type: "object",
					additionalProperties: { type: "string" },
				},
			},
		};
		const invoke = vi
			.fn<Executor["invoke"]>()
			.mockResolvedValue({ ok: true, output: { statusCode: 202 } }); // typo for `status`
		const executor: Executor = { invoke };
		const logger = makeSilentLogger();
		const fire = buildFire(
			executor,
			"acme",
			makeWorkflow(),
			makeDescriptor(outputSchema),
			"bundle-src",
			logger,
		);

		const result = await fire({ body: { name: "alice" } });

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected failure");
		}
		expect(result.error.message).toMatch(/^output validation:/);
		// IMPORTANT: no `issues` field on the error envelope → HTTP source
		// maps this to 500, not 422.
		expect(result.error.issues).toBeUndefined();
		// Structured issues survive through the logger path for observability.
		expect(logger.warnings.length).toBe(1);
		const warn = logger.warnings[0];
		expect(warn?.msg).toBe("trigger.output-validation-failed");
		expect(
			(warn?.data as { issues?: unknown[] } | undefined)?.issues?.length ?? 0,
		).toBeGreaterThan(0);
	});

	it("does not run output validation when the executor returns a failure envelope", async () => {
		const outputSchema = { type: "string" }; // would reject any non-string
		const invoke = vi.fn<Executor["invoke"]>().mockResolvedValue({
			ok: false,
			error: { message: "boom", stack: "trace" },
		});
		const executor: Executor = { invoke };
		const logger = makeSilentLogger();
		const fire = buildFire(
			executor,
			"acme",
			makeWorkflow(),
			makeDescriptor(outputSchema),
			"bundle-src",
			logger,
		);

		const result = await fire({ body: { name: "alice" } });

		expect(result).toEqual({
			ok: false,
			error: { message: "boom", stack: "trace" },
		});
		expect(logger.warnings).toEqual([]);
	});

	it("cron handler output validates trivially against z.unknown-style empty schema", async () => {
		const invoke = vi
			.fn<Executor["invoke"]>()
			.mockResolvedValue({ ok: true, output: undefined });
		const executor: Executor = { invoke };
		const logger = makeSilentLogger();
		const fire = buildFire(
			executor,
			"acme",
			makeWorkflow(),
			makeCronDescriptor(),
			"bundle-src",
			logger,
		);

		const result = await fire({});

		expect(result).toEqual({ ok: true, output: undefined });
		expect(logger.warnings).toEqual([]);
	});

	it("forwards dispatch arg to executor.invoke via the options bag", async () => {
		const invoke = vi
			.fn<Executor["invoke"]>()
			.mockResolvedValue({ ok: true, output: { status: 200 } });
		const executor: Executor = { invoke };
		const fire = buildFire(
			executor,
			"acme",
			makeWorkflow(),
			makeDescriptor(),
			"bundle-src",
		);

		await fire(
			{ body: { name: "alice" } },
			{ source: "manual", user: { login: "Jane", mail: "jane@ex.com" } },
		);

		expect(invoke).toHaveBeenCalledTimes(1);
		const call = invoke.mock.calls[0];
		if (!call) {
			throw new Error("invoke was not called");
		}
		expect(call[4]).toEqual({
			bundleSource: "bundle-src",
			dispatch: {
				source: "manual",
				user: { login: "Jane", mail: "jane@ex.com" },
			},
		});
	});

	it("omits dispatch from options when fire is called without it", async () => {
		const invoke = vi
			.fn<Executor["invoke"]>()
			.mockResolvedValue({ ok: true, output: { status: 200 } });
		const executor: Executor = { invoke };
		const fire = buildFire(
			executor,
			"acme",
			makeWorkflow(),
			makeDescriptor(),
			"bundle-src",
		);

		await fire({ body: { name: "alice" } });

		const call = invoke.mock.calls[0];
		if (!call) {
			throw new Error("invoke was not called");
		}
		expect(call[4]).toEqual({ bundleSource: "bundle-src" });
	});

	it("does not call executor (and thus does not stamp dispatch) on validation failure", async () => {
		const invoke = vi.fn<Executor["invoke"]>();
		const executor: Executor = { invoke };
		const fire = buildFire(
			executor,
			"acme",
			makeWorkflow(),
			makeDescriptor(),
			"bundle-src",
		);

		const result = await fire(
			{ body: {} }, // missing required `name`
			{ source: "manual", user: { login: "Jane", mail: "jane@ex.com" } },
		);

		expect(result.ok).toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});
});
