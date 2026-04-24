import { describe, expect, it } from "vitest";
import type { EventKind, InvocationEvent } from "./index.js";
import {
	computeKeyId,
	IIFE_NAMESPACE,
	ManifestSchema,
	SECRETS_KEY_ID_BYTES,
} from "./index.js";
import { makeEvent } from "./test-utils.js";

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
		const setEvent: InvocationEvent = makeEvent({
			kind: "timer.set",
			id: "evt_1",
			seq: 0,
			ref: 1,
			ts: 1,
			name: "setTimeout",
			input: { delay: 100, timerId: 7 },
		});
		const requestEvent: InvocationEvent = makeEvent({
			kind: "timer.request",
			id: "evt_1",
			seq: 1,
			ref: null,
			ts: 2,
			name: "setTimeout",
			input: { timerId: 7 },
		});
		const responseEvent: InvocationEvent = makeEvent({
			kind: "timer.response",
			id: "evt_1",
			seq: 2,
			ref: 1,
			ts: 3,
			name: "setTimeout",
			input: { timerId: 7 },
			output: "ok",
		});
		const errorEvent: InvocationEvent = makeEvent({
			kind: "timer.error",
			id: "evt_1",
			seq: 3,
			ref: 1,
			ts: 4,
			name: "setTimeout",
			input: { timerId: 7 },
			error: { message: "boom", stack: "stack" },
		});
		const clearEvent: InvocationEvent = makeEvent({
			kind: "timer.clear",
			id: "evt_1",
			seq: 4,
			ref: null,
			ts: 5,
			name: "clearTimeout",
			input: { timerId: 7 },
		});
		expect(setEvent.kind).toBe("timer.set");
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

	it("rejects a malformed schedule", () => {
		const bad = { ...validCron, schedule: "not-a-cron" };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow();
	});

	it("rejects a 6-field schedule (non-standard)", () => {
		const bad = { ...validCron, schedule: "0 0 9 * * *" };
		expect(() => ManifestSchema.parse(base([bad]))).toThrow();
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

	it("strips http-only fields from a manual entry", () => {
		const bad = { ...validManual, method: "POST", body: {} };
		const parsed = ManifestSchema.parse(base([bad]));
		const trigger = parsed.workflows[0]?.triggers[0];
		if (trigger?.type !== "manual") {
			throw new Error("expected manual");
		}
		expect("method" in trigger).toBe(false);
		expect("body" in trigger).toBe(false);
	});

	it("strips cron-only fields from a manual entry", () => {
		const bad = { ...validManual, schedule: "0 9 * * *", tz: "UTC" };
		const parsed = ManifestSchema.parse(base([bad]));
		const trigger = parsed.workflows[0]?.triggers[0];
		if (trigger?.type !== "manual") {
			throw new Error("expected manual");
		}
		expect("schedule" in trigger).toBe(false);
		expect("tz" in trigger).toBe(false);
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

describe("ManifestSchema secrets + secretsKeyId", () => {
	const base = (overrides: Record<string, unknown> = {}) => ({
		workflows: [
			{
				name: "wf",
				module: "wf.js",
				sha: "sha",
				env: { REGION: "us-east-1" },
				actions: [],
				triggers: [],
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
