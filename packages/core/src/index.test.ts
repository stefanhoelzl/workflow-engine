import { describe, expect, it } from "vitest";
import { IIFE_NAMESPACE as IIFE_NAMESPACE_FROM_CONSTANTS } from "./constants.js";
import type { EventKind, InvocationEvent } from "./index.js";
import {
	computeKeyId,
	formatIssue,
	IIFE_NAMESPACE,
	isReservedResponseHeader,
	ManifestSchema,
	RESERVED_RESPONSE_HEADERS,
	SECRETS_KEY_ID_BYTES,
	workflowManifestSchema,
} from "./index.js";
import { makeEvent } from "./test-utils.js";

describe("IIFE_NAMESPACE", () => {
	it("is the shared constant used by plugin, runtime, and sandbox", () => {
		expect(IIFE_NAMESPACE).toBe("__wfe_exports__");
	});

	// `index.ts` and `constants.ts` each declare the literal independently —
	// `constants.ts` is a zero-dep subpath module the sandbox worker imports
	// without pulling in zod, while `index.ts` keeps its inline declaration so
	// Node's TS-strip mode doesn't have to resolve a relative `.js` → `.ts`
	// import at runtime (which broke `node packages/sdk/dist/cli/cli.js
	// build`). This test pins them to the same value.
	it("matches the literal exported from @workflow-engine/core/constants", () => {
		expect(IIFE_NAMESPACE).toBe(IIFE_NAMESPACE_FROM_CONSTANTS);
	});
});

describe("EventKind", () => {
	it("includes the consolidated system.* kinds", () => {
		// The `satisfies` clause is a compile-time assertion that each literal
		// is a member of the EventKind union. After the bridge-main-sequencing
		// prefix consolidation, all host-call kinds (formerly fetch.*, mail.*,
		// sql.*, timer.*, console.*, wasi.*, uncaught-error) collapse into the
		// `system.*` family with the operation identity carried in the event's
		// `name` field.
		const systemKinds = [
			"system.request",
			"system.response",
			"system.error",
			"system.call",
			"system.exception",
		] as const satisfies readonly EventKind[];
		expect(systemKinds).toHaveLength(5);
	});

	it("includes trigger.exception as a leaf kind for author-fixable pre-dispatch failures", () => {
		// `trigger.exception` is host-emitted (no sandbox involvement), has no
		// paired `trigger.request`, and is the sole kind allowed to bypass the
		// sandbox/sequencer stamping path via the runtime's `emitTriggerException`
		// helper. See SECURITY.md §2 R-8 stamping boundary.
		const triggerKinds = [
			"trigger.request",
			"trigger.response",
			"trigger.error",
			"trigger.exception",
		] as const satisfies readonly EventKind[];
		expect(triggerKinds).toHaveLength(4);
	});

	it("InvocationEvent accepts system.* timer-callback kinds with the expected fields", () => {
		const setEvent: InvocationEvent = makeEvent({
			kind: "system.call",
			id: "evt_1",
			seq: 0,
			ref: 1,
			ts: 1,
			name: "setTimeout",
			input: { delay: 100, timerId: 7 },
		});
		const requestEvent: InvocationEvent = makeEvent({
			kind: "system.request",
			id: "evt_1",
			seq: 1,
			ref: null,
			ts: 2,
			name: "setTimeout",
			input: { timerId: 7 },
		});
		const responseEvent: InvocationEvent = makeEvent({
			kind: "system.response",
			id: "evt_1",
			seq: 2,
			ref: 1,
			ts: 3,
			name: "setTimeout",
			input: { timerId: 7 },
			output: "ok",
		});
		const errorEvent: InvocationEvent = makeEvent({
			kind: "system.error",
			id: "evt_1",
			seq: 3,
			ref: 1,
			ts: 4,
			name: "setTimeout",
			input: { timerId: 7 },
			error: { message: "boom", stack: "stack" },
		});
		const clearEvent: InvocationEvent = makeEvent({
			kind: "system.call",
			id: "evt_1",
			seq: 4,
			ref: null,
			ts: 5,
			name: "clearTimeout",
			input: { timerId: 7 },
		});
		expect(setEvent.name).toBe("setTimeout");
		expect(requestEvent.ref).toBeNull();
		expect(responseEvent.output).toBe("ok");
		expect(errorEvent.error?.message).toBe("boom");
		expect(clearEvent.name).toBe("clearTimeout");
	});
});

describe("ManifestSchema cron trigger", () => {
	const base = (triggers: unknown[]) => ({
		workflows: [
			{
				name: "wf",
				module: "wf.js",
				sha: "sha",
				env: {},
				actions: [],
				triggers,
			},
		],
	});
	const validCron = {
		name: "daily",
		type: "cron" as const,
		schedule: "0 9 * * *",
		tz: "UTC",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		outputSchema: {},
	};

	it("accepts a valid cron descriptor", () => {
		const parsed = ManifestSchema.parse(base([validCron]));
		const trigger = parsed.workflows[0]?.triggers[0];
		if (trigger?.type !== "cron") {
			throw new Error("expected cron");
		}
		expect(trigger.schedule).toBe("0 9 * * *");
		expect(trigger.tz).toBe("UTC");
	});

	it("rejects an empty schedule", () => {
		const bad = { ...validCron, schedule: "" };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow();
	});

	it("accepts a 6-field schedule (delegates parsing to cron-parser)", () => {
		const ok = { ...validCron, schedule: "* * * * * *" };
		const parsed = ManifestSchema.parse(base([ok]));
		const trigger = parsed.workflows[0]?.triggers[0];
		if (trigger?.type !== "cron") {
			throw new Error("expected cron");
		}
		expect(trigger.schedule).toBe("* * * * * *");
	});

	it("accepts an arbitrary non-empty schedule string at the manifest layer", () => {
		// Genuinely malformed schedules surface at runtime via the cron source's
		// `CronExpressionParser.parse` catch, not at manifest validation time.
		const ok = { ...validCron, schedule: "not-a-cron" };
		const parsed = ManifestSchema.parse(base([ok]));
		const trigger = parsed.workflows[0]?.triggers[0];
		if (trigger?.type !== "cron") {
			throw new Error("expected cron");
		}
		expect(trigger.schedule).toBe("not-a-cron");
	});

	it("rejects an unknown timezone", () => {
		const bad = { ...validCron, tz: "Not/AZone" };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow();
	});

	it("rejects an empty timezone", () => {
		const bad = { ...validCron, tz: "" };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow();
	});

	it("rejects a missing schedule", () => {
		const { schedule: _schedule, ...rest } = validCron;
		expect(() => ManifestSchema.parse(base([rest]))).toThrow();
	});

	it("rejects a missing tz", () => {
		const { tz: _tz, ...rest } = validCron;
		expect(() => ManifestSchema.parse(base([rest]))).toThrow();
	});

	it("rejects an unknown type discriminant", () => {
		const bad = { ...validCron, type: "mystery" };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow();
	});
});

describe("ManifestSchema manual trigger", () => {
	const base = (triggers: unknown[]) => ({
		workflows: [
			{
				name: "wf",
				module: "wf.js",
				sha: "sha",
				env: {},
				actions: [],
				triggers,
			},
		],
	});
	const validManual = {
		name: "rerun",
		type: "manual" as const,
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		outputSchema: {},
	};

	it("accepts a valid manual descriptor", () => {
		const parsed = ManifestSchema.parse(base([validManual]));
		const trigger = parsed.workflows[0]?.triggers[0];
		if (trigger?.type !== "manual") {
			throw new Error("expected manual");
		}
		expect(trigger.name).toBe("rerun");
	});

	it("rejects http-only fields on a manual entry", () => {
		const bad = { ...validManual, method: "POST", body: {} };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow(/Unrecognized key/);
	});

	it("rejects cron-only fields on a manual entry", () => {
		const bad = { ...validManual, schedule: "0 9 * * *", tz: "UTC" };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow(/Unrecognized key/);
	});

	it("rejects a manual entry missing inputSchema", () => {
		const { inputSchema: _i, ...rest } = validManual;
		expect(() => ManifestSchema.parse(base([rest]))).toThrow();
	});

	it("rejects a manual entry missing outputSchema", () => {
		const { outputSchema: _o, ...rest } = validManual;
		expect(() => ManifestSchema.parse(base([rest]))).toThrow();
	});

	it("rejects a manual entry with a non-URL-safe name", () => {
		const bad = { ...validManual, name: "$weird" };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow();
	});
});

describe("ManifestSchema imap trigger", () => {
	const base = (triggers: unknown[]) => ({
		workflows: [
			{
				name: "wf",
				module: "wf.js",
				sha: "sha",
				env: {},
				actions: [],
				triggers,
			},
		],
	});
	const validImap = {
		name: "inbound",
		type: "imap" as const,
		host: "imap.example.com",
		port: 993,
		tls: "required" as const,
		insecureSkipVerify: false,
		user: "alice",
		password: "hunter2",
		folder: "INBOX",
		search: "UNSEEN",
		onError: {},
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: true,
		},
		outputSchema: {},
	};

	it("accepts a valid imap descriptor", () => {
		const parsed = ManifestSchema.parse(base([validImap]));
		const trigger = parsed.workflows[0]?.triggers[0];
		if (trigger?.type !== "imap") {
			throw new Error("expected imap");
		}
		expect(trigger.host).toBe("imap.example.com");
		expect(trigger.port).toBe(993);
		expect(trigger.tls).toBe("required");
		expect(trigger.folder).toBe("INBOX");
	});

	it("accepts an imap descriptor with sentinel in password", () => {
		const withSentinel = {
			...validImap,
			password: "\x00secret:IMAP_PASSWORD\x00",
		};
		const parsed = ManifestSchema.parse(base([withSentinel]));
		const trigger = parsed.workflows[0]?.triggers[0];
		if (trigger?.type !== "imap") {
			throw new Error("expected imap");
		}
		expect(trigger.password).toBe("\x00secret:IMAP_PASSWORD\x00");
	});

	it("accepts an imap descriptor with onError command list", () => {
		const withOnError = {
			...validImap,
			onError: { command: ["UID STORE 1 +FLAGS (\\Seen)"] },
		};
		const parsed = ManifestSchema.parse(base([withOnError]));
		const trigger = parsed.workflows[0]?.triggers[0];
		if (trigger?.type !== "imap") {
			throw new Error("expected imap");
		}
		expect(trigger.onError.command).toEqual(["UID STORE 1 +FLAGS (\\Seen)"]);
	});

	it("rejects an imap descriptor with port as string", () => {
		const bad = { ...validImap, port: "993" };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow();
	});

	it("rejects an imap descriptor with unknown tls mode", () => {
		const bad = { ...validImap, tls: "ssl" };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow();
	});

	it("rejects an imap descriptor missing password", () => {
		const { password: _p, ...rest } = validImap;
		expect(() => ManifestSchema.parse(base([rest]))).toThrow();
	});

	it("rejects an imap descriptor missing onError", () => {
		const { onError: _o, ...rest } = validImap;
		expect(() => ManifestSchema.parse(base([rest]))).toThrow();
	});

	it("rejects an imap entry with a non-URL-safe name", () => {
		const bad = { ...validImap, name: "$weird" };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow();
	});
});

describe("ManifestSchema ws trigger", () => {
	const base = (triggers: unknown[]) => ({
		workflows: [
			{
				name: "wf",
				module: "wf.js",
				sha: "sha",
				env: {},
				actions: [],
				triggers,
			},
		],
	});
	const validWs = {
		name: "chat",
		type: "ws" as const,
		request: {
			type: "object",
			properties: { greet: { type: "string" } },
			required: ["greet"],
			additionalProperties: false,
		},
		response: {},
		inputSchema: {
			type: "object",
			properties: {
				data: {
					type: "object",
					properties: { greet: { type: "string" } },
					required: ["greet"],
					additionalProperties: false,
				},
			},
			required: ["data"],
			additionalProperties: false,
		},
		outputSchema: {},
	};

	it("accepts a valid ws descriptor", () => {
		const parsed = ManifestSchema.parse(base([validWs]));
		const trigger = parsed.workflows[0]?.triggers[0];
		if (trigger?.type !== "ws") {
			throw new Error("expected ws");
		}
		expect(trigger.name).toBe("chat");
	});

	it("rejects http-only fields on a ws entry", () => {
		const bad = { ...validWs, method: "POST", body: {} };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow(/Unrecognized key/);
	});

	it("rejects cron-only fields on a ws entry", () => {
		const bad = { ...validWs, schedule: "0 9 * * *", tz: "UTC" };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow(/Unrecognized key/);
	});

	it("rejects a ws entry missing request", () => {
		const { request: _r, ...rest } = validWs;
		expect(() => ManifestSchema.parse(base([rest]))).toThrow();
	});

	it("rejects a ws entry missing response", () => {
		const { response: _r, ...rest } = validWs;
		expect(() => ManifestSchema.parse(base([rest]))).toThrow();
	});

	it("rejects a ws entry with a non-URL-safe name", () => {
		const bad = { ...validWs, name: "$weird" };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow();
	});
});

describe("ManifestSchema secrets + secretsKeyId", () => {
	const minimalTrigger = {
		name: "rerun",
		type: "manual" as const,
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		outputSchema: {},
	};
	const base = (overrides: Record<string, unknown> = {}) => ({
		workflows: [
			{
				name: "wf",
				module: "wf.js",
				sha: "sha",
				env: { REGION: "us-east-1" },
				actions: [],
				triggers: [minimalTrigger],
				...overrides,
			},
		],
	});
	const validKeyId = "a1b2c3d4e5f60718";
	const cipher = "Y3Q="; // base64("ct")

	it("accepts a manifest with matching secrets and secretsKeyId", () => {
		const parsed = ManifestSchema.parse(
			base({ secrets: { TOKEN: cipher }, secretsKeyId: validKeyId }),
		);
		expect(parsed.workflows[0]?.secrets?.TOKEN).toBe(cipher);
		expect(parsed.workflows[0]?.secretsKeyId).toBe(validKeyId);
	});

	it("accepts a manifest with neither secrets nor secretsKeyId", () => {
		const parsed = ManifestSchema.parse(base());
		expect(parsed.workflows[0]?.secrets).toBeUndefined();
		expect(parsed.workflows[0]?.secretsKeyId).toBeUndefined();
	});

	it("rejects a manifest with secrets but no secretsKeyId", () => {
		expect(() =>
			ManifestSchema.parse(base({ secrets: { TOKEN: cipher } })),
		).toThrow(/secretsKeyId/);
	});

	it("rejects a manifest with secretsKeyId but no secrets", () => {
		expect(() =>
			ManifestSchema.parse(base({ secretsKeyId: validKeyId })),
		).toThrow(/secrets/);
	});

	it("rejects a secretsKeyId that does not match /^[0-9a-f]{16}$/", () => {
		expect(() =>
			ManifestSchema.parse(
				base({
					secrets: { TOKEN: cipher },
					secretsKeyId: "TOO_LONG_12345678X",
				}),
			),
		).toThrow();
		expect(() =>
			ManifestSchema.parse(
				base({ secrets: { TOKEN: cipher }, secretsKeyId: "ABCDEF0123456789" }),
			),
		).toThrow(); // uppercase rejected
		expect(() =>
			ManifestSchema.parse(
				base({ secrets: { TOKEN: cipher }, secretsKeyId: "short" }),
			),
		).toThrow();
	});

	it("rejects a manifest where secrets keys overlap with env keys", () => {
		expect(() =>
			ManifestSchema.parse(
				base({
					env: { TOKEN: "leaked" },
					secrets: { TOKEN: cipher },
					secretsKeyId: validKeyId,
				}),
			),
		).toThrow(/disjoint/);
	});

	it("accepts disjoint env and secrets keys", () => {
		const parsed = ManifestSchema.parse(
			base({
				env: { REGION: "us-east-1" },
				secrets: { TOKEN: cipher },
				secretsKeyId: validKeyId,
			}),
		);
		expect(parsed.workflows[0]?.env.REGION).toBe("us-east-1");
		expect(parsed.workflows[0]?.secrets?.TOKEN).toBe(cipher);
	});

	it("rejects a manifest containing secretBindings (must be sealed by wfe upload)", () => {
		expect(() =>
			ManifestSchema.parse(base({ secretBindings: ["TOKEN"] })),
		).toThrow(/secretBindings/);
	});
});

describe("workflowManifestSchema additional refines", () => {
	const minimalTrigger = {
		name: "rerun",
		type: "manual" as const,
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		outputSchema: {},
	};
	const baseWorkflow = (overrides: Record<string, unknown> = {}) => ({
		name: "demo",
		module: "demo.js",
		sha: "sha",
		env: {},
		actions: [],
		triggers: [minimalTrigger],
		...overrides,
	});

	it("rejects a workflow with zero triggers", () => {
		const result = workflowManifestSchema.safeParse(
			baseWorkflow({ triggers: [] }),
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find(
				(i) => i.message === "must declare at least one trigger",
			);
			expect(issue).toBeDefined();
			if (issue !== undefined) {
				expect(formatIssue(issue, baseWorkflow({ triggers: [] }))).toBe(
					'Workflow "demo": must declare at least one trigger',
				);
			}
		}
	});

	it("accepts a workflow with at least one trigger", () => {
		const result = workflowManifestSchema.safeParse(baseWorkflow());
		expect(result.success).toBe(true);
	});

	it("rejects duplicate trigger names within a workflow", () => {
		const dup = baseWorkflow({
			triggers: [minimalTrigger, { ...minimalTrigger }],
		});
		const result = workflowManifestSchema.safeParse(dup);
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) =>
				i.message.includes("trigger names must be unique"),
			);
			expect(issue).toBeDefined();
		}
	});

	it("accepts the same trigger name across different workflows", () => {
		const result = ManifestSchema.safeParse({
			workflows: [
				{ ...baseWorkflow(), name: "wfa" },
				{ ...baseWorkflow(), name: "wfb" },
			],
		});
		expect(result.success).toBe(true);
	});

	it("rejects duplicate action names within a workflow", () => {
		const action = {
			name: "doIt",
			input: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			output: {},
		};
		const result = workflowManifestSchema.safeParse(
			baseWorkflow({ actions: [action, { ...action }] }),
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) =>
				i.message.includes("action names must be unique"),
			);
			expect(issue).toBeDefined();
		}
	});

	it("rejects an http trigger declaring a reserved response header", () => {
		const httpTrigger = {
			name: "webhook",
			type: "http" as const,
			method: "POST",
			request: {
				body: {},
				headers: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
			response: {
				headers: {
					type: "object",
					properties: { "set-cookie": { type: "string" } },
					additionalProperties: false,
				},
			},
			inputSchema: {},
			outputSchema: {},
		};
		const result = workflowManifestSchema.safeParse(
			baseWorkflow({ triggers: [httpTrigger] }),
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) =>
				i.message.includes('reserved header "set-cookie"'),
			);
			expect(issue).toBeDefined();
			if (issue !== undefined) {
				const wf = baseWorkflow({ triggers: [httpTrigger] });
				expect(formatIssue(issue, wf)).toBe(
					'Workflow "demo": http trigger "webhook": response.headers: response.headers declares reserved header "set-cookie"; the platform owns this header on /webhooks/* responses',
				);
			}
		}
	});

	it("accepts an http trigger with a non-reserved response header", () => {
		const httpTrigger = {
			name: "webhook",
			type: "http" as const,
			method: "POST",
			request: {
				body: {},
				headers: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
			response: {
				headers: {
					type: "object",
					properties: { "x-app-version": { type: "string" } },
					additionalProperties: false,
				},
			},
			inputSchema: {},
			outputSchema: {},
		};
		const result = workflowManifestSchema.safeParse(
			baseWorkflow({ triggers: [httpTrigger] }),
		);
		expect(result.success).toBe(true);
	});
});

describe("formatIssue", () => {
	const minimalTrigger = {
		name: "rerun",
		type: "manual" as const,
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		outputSchema: {},
	};
	const baseWorkflow = (overrides: Record<string, unknown> = {}) => ({
		name: "demo",
		module: "demo.js",
		sha: "sha",
		env: {},
		actions: [],
		triggers: [minimalTrigger],
		...overrides,
	});

	it("renders a cron schedule violation with full type/name context", () => {
		const cronTrigger = {
			name: "everyFiveMinutes",
			type: "cron" as const,
			schedule: "",
			tz: "UTC",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			outputSchema: {},
		};
		const wf = baseWorkflow({ triggers: [cronTrigger] });
		const result = workflowManifestSchema.safeParse(wf);
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) => i.path[2] === "schedule");
			expect(issue).toBeDefined();
			if (issue !== undefined) {
				const formatted = formatIssue(issue, wf);
				expect(formatted).toContain(
					'Workflow "demo": cron trigger "everyFiveMinutes":',
				);
			}
		}
	});

	it("renders a workflow-root violation with workflow name only", () => {
		const wf = baseWorkflow({ triggers: [] });
		const result = workflowManifestSchema.safeParse(wf);
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find(
				(i) => i.message === "must declare at least one trigger",
			);
			expect(issue).toBeDefined();
			if (issue !== undefined) {
				expect(formatIssue(issue, wf)).toBe(
					'Workflow "demo": must declare at least one trigger',
				);
			}
		}
	});

	it("renders an action violation with action name", () => {
		const issue = {
			path: ["actions", 0, "input"],
			message: "must be a JSON Schema",
		};
		const wf = baseWorkflow({
			actions: [{ name: "sendMail", input: {}, output: {} }],
		});
		expect(formatIssue(issue, wf)).toBe(
			'Workflow "demo": action "sendMail": input: must be a JSON Schema',
		);
	});

	it("renders a path outside known collections via path-string fallback", () => {
		const issue = { path: ["module"], message: "is required" };
		const wf = baseWorkflow();
		expect(formatIssue(issue, wf)).toBe('Workflow "demo": module: is required');
	});

	it("recurses into ManifestSchema's workflows[i] wrapper", () => {
		const issue = { path: ["workflows", 0, "module"], message: "is required" };
		const m = { workflows: [baseWorkflow()] };
		expect(formatIssue(issue, m)).toBe('Workflow "demo": module: is required');
	});

	it("falls back to <unknown> when workflow name is missing", () => {
		const issue = { path: [], message: "must declare at least one trigger" };
		expect(formatIssue(issue, {})).toBe(
			'Workflow "<unknown>": must declare at least one trigger',
		);
	});
});

describe("computeKeyId", () => {
	it("returns a 16-character lowercase hex string", async () => {
		const pk = new Uint8Array(32).fill(0x42);
		const id = await computeKeyId(pk);
		expect(id).toMatch(/^[0-9a-f]{16}$/);
	});

	it("is deterministic for the same input", async () => {
		const pk = new Uint8Array(32).fill(0x01);
		const a = await computeKeyId(pk);
		const b = await computeKeyId(pk);
		expect(a).toBe(b);
	});

	it("produces different ids for different inputs", async () => {
		const pk1 = new Uint8Array(32).fill(0x01);
		const pk2 = new Uint8Array(32).fill(0x02);
		const a = await computeKeyId(pk1);
		const b = await computeKeyId(pk2);
		expect(a).not.toBe(b);
	});

	it("takes first SECRETS_KEY_ID_BYTES bytes of the sha256 digest", async () => {
		expect(SECRETS_KEY_ID_BYTES).toBe(8);
		const pk = new Uint8Array(32);
		const id = await computeKeyId(pk);
		// sha256 of 32 zero bytes — first 8 bytes in hex:
		// 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925
		//   → first 8 bytes: 66 68 7a ad f8 62 bd 77
		expect(id).toBe("66687aadf862bd77");
	});
});

describe("RESERVED_RESPONSE_HEADERS", () => {
	it("contains the cross-tenant attack class names (lowercased)", () => {
		for (const name of [
			"set-cookie",
			"set-cookie2",
			"location",
			"refresh",
			"clear-site-data",
			"authorization",
			"proxy-authenticate",
			"www-authenticate",
		]) {
			expect(RESERVED_RESPONSE_HEADERS.has(name)).toBe(true);
		}
	});

	it("contains the platform security/transport invariants (lowercased)", () => {
		for (const name of [
			"content-security-policy",
			"content-security-policy-report-only",
			"strict-transport-security",
			"x-content-type-options",
			"x-frame-options",
			"referrer-policy",
			"cross-origin-opener-policy",
			"cross-origin-resource-policy",
			"cross-origin-embedder-policy",
			"permissions-policy",
			"server",
			"x-powered-by",
		]) {
			expect(RESERVED_RESPONSE_HEADERS.has(name)).toBe(true);
		}
	});

	it("does NOT contain content-type or cache-control (workflow-controlled)", () => {
		expect(RESERVED_RESPONSE_HEADERS.has("content-type")).toBe(false);
		expect(RESERVED_RESPONSE_HEADERS.has("cache-control")).toBe(false);
	});
});

describe("isReservedResponseHeader", () => {
	it("matches reserved names case-insensitively", () => {
		expect(isReservedResponseHeader("Set-Cookie")).toBe(true);
		expect(isReservedResponseHeader("SET-COOKIE")).toBe(true);
		expect(isReservedResponseHeader("set-cookie")).toBe(true);
		expect(isReservedResponseHeader("X-Frame-Options")).toBe(true);
		expect(isReservedResponseHeader("Content-Security-Policy")).toBe(true);
	});

	it("returns false for non-reserved names", () => {
		expect(isReservedResponseHeader("x-app-version")).toBe(false);
		expect(isReservedResponseHeader("X-Trace-Id")).toBe(false);
		expect(isReservedResponseHeader("content-type")).toBe(false);
		expect(isReservedResponseHeader("cache-control")).toBe(false);
	});
});

describe("ManifestSchema queues field", () => {
	// Manifests must declare at least one trigger; queues are an additive
	// surface so the test fixture pins a no-op http trigger in every case.
	const dummyTrigger = {
		name: "ping",
		type: "http" as const,
		method: "GET",
		request: {
			body: {},
			headers: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		},
		inputSchema: {},
		outputSchema: {},
	};
	const baseWorkflow = (queues: unknown[] | undefined) => ({
		workflows: [
			{
				name: "wf",
				module: "wf.js",
				sha: "sha",
				env: {},
				actions: [],
				triggers: [dummyTrigger],
				...(queues === undefined ? {} : { queues }),
			},
		],
	});
	const validQueue = {
		name: "jobs",
		schema: {
			type: "object",
			properties: { url: { type: "string" } },
			additionalProperties: false,
		},
	};

	it("accepts a workflow with no queues field (forward-compat)", () => {
		const parsed = ManifestSchema.parse(baseWorkflow(undefined));
		expect(parsed.workflows[0]?.queues).toEqual([]);
	});

	it("accepts a workflow with a valid queue declaration", () => {
		const parsed = ManifestSchema.parse(baseWorkflow([validQueue]));
		expect(parsed.workflows[0]?.queues).toEqual([validQueue]);
	});

	it("rejects a queue with a name that fails the queue-name regex", () => {
		const bad = { ...validQueue, name: "Bad-Name" };
		expect(() => ManifestSchema.parse(baseWorkflow([bad]))).toThrow();
	});

	it("rejects a workflow with duplicate queue names", () => {
		expect(() =>
			ManifestSchema.parse(
				baseWorkflow([validQueue, { ...validQueue, schema: {} }]),
			),
		).toThrow();
	});

	it("accepts an empty queues array", () => {
		const parsed = ManifestSchema.parse(baseWorkflow([]));
		expect(parsed.workflows[0]?.queues).toEqual([]);
	});
});

describe("ManifestSchema strict-mode rejection of unknown fields", () => {
	const validManual = {
		name: "rerun",
		type: "manual" as const,
		inputSchema: {},
		outputSchema: {},
	};

	const validWorkflow = {
		name: "demo",
		module: "demo.js",
		sha: "sha",
		env: {},
		actions: [],
		triggers: [validManual],
	};

	const wrap = (overrides: Record<string, unknown> = {}) => ({
		workflows: [{ ...validWorkflow, ...overrides }],
	});

	it("rejects an unknown top-level manifest key", () => {
		expect(() =>
			ManifestSchema.parse({
				workflows: [validWorkflow],
				futureField: "v2",
			}),
		).toThrow(/Unrecognized key/);
	});

	it("rejects an unknown field on a workflow entry", () => {
		expect(() =>
			ManifestSchema.parse(wrap({ description: "a friendly demo" })),
		).toThrow(/Unrecognized key/);
	});

	it("rejects an unknown field on an HTTP trigger entry", () => {
		const validHttp = {
			name: "hello",
			type: "http" as const,
			method: "GET",
			request: { body: {}, headers: {} },
			inputSchema: {},
			outputSchema: {},
		};
		expect(() =>
			ManifestSchema.parse(
				wrap({
					triggers: [{ ...validHttp, priority: 1 }],
				}),
			),
		).toThrow(/Unrecognized key/);
	});

	it("rejects an unknown field on a queue entry", () => {
		expect(() =>
			ManifestSchema.parse(
				wrap({
					queues: [{ name: "items", schema: {}, retentionDays: 7 }],
				}),
			),
		).toThrow(/Unrecognized key/);
	});

	it("accepts a well-formed manifest with only declared fields", () => {
		expect(() => ManifestSchema.parse(wrap())).not.toThrow();
	});
});
