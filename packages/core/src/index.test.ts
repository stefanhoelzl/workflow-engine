import { describe, expect, it } from "vitest";
import type { EventKind, InvocationEvent } from "./index.js";
import { IIFE_NAMESPACE, ManifestSchema } from "./index.js";
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
