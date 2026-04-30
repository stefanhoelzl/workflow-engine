import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InvocationEvent, WorkflowManifest } from "@workflow-engine/core";
import { describe, expect, it } from "vitest";
import type { EventStore } from "../event-store.js";
import { createTestEventStore } from "../test-utils/event-store.js";
import { withZodSchemas } from "../triggers/test-descriptors.js";
import { emitTriggerException } from "./exception.js";
import type { HttpTriggerDescriptor } from "./types.js";

function makeManifest(): WorkflowManifest {
	return {
		name: "wf",
		module: "wf.js",
		sha: "0".repeat(64),
		env: {},
		actions: [],
		triggers: [],
	};
}

function makeDescriptor(): HttpTriggerDescriptor {
	return withZodSchemas({
		kind: "http",
		type: "http",
		name: "inbound",
		workflowName: "wf",
		method: "POST",
		request: {
			body: { type: "object" },
			headers: { type: "object", properties: {}, additionalProperties: false },
		},
		inputSchema: { type: "object" },
		outputSchema: { type: "object" },
	});
}

function makeStore(seen: InvocationEvent[]): EventStore {
	return createTestEventStore({
		onRecord: (e: InvocationEvent) => {
			seen.push(e);
		},
	});
}

describe("emitTriggerException", () => {
	it("defaults to kind = 'trigger.exception' when params.kind is omitted (back-compat)", async () => {
		const seen: InvocationEvent[] = [];
		await emitTriggerException(
			makeStore(seen),
			"o",
			"r",
			makeManifest(),
			makeDescriptor(),
			{ name: "imap.poll-failed", error: { message: "x" } },
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.kind).toBe("trigger.exception");
		expect(seen[0]?.error).toEqual({ message: "x" });
		expect(seen[0]?.meta).toBeUndefined();
	});

	it("preserves the legacy `details` payload shape (regression guard)", async () => {
		const seen: InvocationEvent[] = [];
		await emitTriggerException(
			makeStore(seen),
			"o",
			"r",
			makeManifest(),
			makeDescriptor(),
			{
				name: "imap.poll-failed",
				error: { message: "ECONNREFUSED" },
				details: { stage: "connect", failedUids: [] },
			},
		);
		expect(seen[0]?.kind).toBe("trigger.exception");
		expect(seen[0]?.input).toEqual({
			trigger: "inbound",
			stage: "connect",
			failedUids: [],
		});
	});

	it("emits kind = 'trigger.rejection' when params.kind is set, with no error and no body", async () => {
		const seen: InvocationEvent[] = [];
		await emitTriggerException(
			makeStore(seen),
			"o",
			"r",
			makeManifest(),
			makeDescriptor(),
			{
				kind: "trigger.rejection",
				name: "http.body-validation",
				input: {
					issues: [{ path: ["name"], message: "Required" }],
					method: "POST",
					path: "/webhooks/o/r/wf/inbound",
				},
			},
		);
		expect(seen).toHaveLength(1);
		const ev = seen[0];
		expect(ev?.kind).toBe("trigger.rejection");
		expect(ev?.name).toBe("http.body-validation");
		expect(ev?.seq).toBe(0);
		expect(ev?.ref).toBe(0);
		expect(ev?.ts).toBe(0);
		expect(ev?.id).toMatch(/^evt_[A-Za-z0-9_-]{8,}$/);
		expect(ev?.error).toBeUndefined();
		expect(ev?.meta).toBeUndefined();
		// trigger declaration name is stamped alongside the kind-specific payload
		expect(ev?.input).toEqual({
			trigger: "inbound",
			issues: [{ path: ["name"], message: "Required" }],
			method: "POST",
			path: "/webhooks/o/r/wf/inbound",
		});
		// no request body persisted
		expect((ev?.input as Record<string, unknown>).body).toBeUndefined();
	});

	it("rejects unsupported kinds (R-8 host-side carve-out)", async () => {
		const seen: InvocationEvent[] = [];
		await expect(
			emitTriggerException(
				makeStore(seen),
				"o",
				"r",
				makeManifest(),
				makeDescriptor(),
				// @ts-expect-error — runtime guard against silently extending the bypass
				{ kind: "trigger.error", name: "x", error: { message: "y" } },
			),
		).rejects.toThrow(/R-8 host-side carve-out/);
		expect(seen).toHaveLength(0);
	});

	it("structural invariant: source asserts on kind to prevent extension", () => {
		// The R-8 chokepoint hinges on `assertHostFailKind` rejecting any kind
		// other than `trigger.exception` or `trigger.rejection`. Verifying the
		// assertion exists in source keeps a future contributor from silently
		// generalizing the helper to other kinds — the spec scenario for this
		// lives in `executor/spec.md` "Executor.fail emits trigger.exception
		// leaf events".
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(resolve(here, "exception.ts"), "utf8");
		expect(src).toMatch(/function assertHostFailKind/);
		expect(src).toMatch(
			/kind !== "trigger\.exception" && kind !== "trigger\.rejection"/,
		);
		expect(src).toMatch(/throw new Error/);
	});
});
