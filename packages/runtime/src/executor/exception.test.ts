import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InvocationEvent, WorkflowManifest } from "@workflow-engine/core";
import { describe, expect, it } from "vitest";
import type { EventBus } from "../event-bus/index.js";
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
	return {
		kind: "http",
		type: "http",
		name: "inbound",
		workflowName: "wf",
		method: "POST",
		body: { type: "object" },
		inputSchema: { type: "object" },
		outputSchema: { type: "object" },
	};
}

describe("emitTriggerException", () => {
	it("hard-codes kind = 'trigger.exception' (R-8 host-side carve-out)", async () => {
		const seen: InvocationEvent[] = [];
		const bus: EventBus = {
			emit: async (e) => {
				seen.push(e);
			},
		};
		await emitTriggerException(
			bus,
			"o",
			"r",
			makeManifest(),
			makeDescriptor(),
			{ name: "imap.poll-failed", error: { message: "x" } },
		);
		expect(seen[0]?.kind).toBe("trigger.exception");
	});

	it("structural invariant: source asserts on kind to prevent extension", () => {
		// The R-8 chokepoint hinges on `assertTriggerExceptionKind` rejecting
		// any kind other than `trigger.exception`. Verifying the assertion
		// exists in source keeps a future contributor from silently
		// generalizing the helper to other kinds — the spec scenario for
		// this lives in `executor/spec.md` "Executor.fail emits
		// trigger.exception leaf events".
		const here = dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(resolve(here, "exception.ts"), "utf8");
		expect(src).toMatch(/function assertTriggerExceptionKind/);
		expect(src).toMatch(/kind !== "trigger\.exception"/);
		expect(src).toMatch(/throw new Error/);
	});
});
