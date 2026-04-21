import { describe, expect, it } from "vitest";
import type { HttpTriggerDescriptor } from "../executor/types.js";
import { validate } from "./validator.js";

function makeDescriptor(
	inputSchema: Record<string, unknown>,
): HttpTriggerDescriptor {
	return {
		kind: "http",
		type: "http",
		name: "t",
		workflowName: "w",
		method: "POST",
		body: { type: "object" },
		inputSchema,
		outputSchema: { type: "object" },
	};
}

describe("validate", () => {
	it("returns ok with validated input when the schema matches", () => {
		const descriptor = makeDescriptor({
			type: "object",
			properties: { x: { type: "number" } },
			required: ["x"],
		});
		const result = validate(descriptor, { x: 42 });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.input).toEqual({ x: 42 });
		}
	});

	it("returns issues when the schema does not match", () => {
		const descriptor = makeDescriptor({
			type: "object",
			properties: { x: { type: "number" } },
			required: ["x"],
		});
		const result = validate(descriptor, { x: "not-a-number" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.length).toBeGreaterThan(0);
			expect(result.issues[0]?.path).toEqual(["x"]);
		}
	});

	it("rejects inputs missing required fields before any dispatch", () => {
		// Security smoke test: a malformed input containing attacker-controlled
		// fields returns { ok: false } before any downstream dispatch.
		const descriptor = makeDescriptor({
			type: "object",
			properties: {
				body: {
					type: "object",
					required: ["ok"],
					properties: { ok: { type: "boolean" } },
				},
				headers: { type: "object" },
				url: { type: "string" },
				method: { type: "string" },
				params: { type: "object" },
				query: { type: "object" },
			},
			required: ["body", "headers", "url", "method", "params", "query"],
		});
		const result = validate(descriptor, {
			body: { malicious: "payload" },
			headers: {},
			url: "/x",
			method: "POST",
			params: {},
			query: {},
		});
		expect(result.ok).toBe(false);
	});

	it("caches compiled validators per schema identity", () => {
		// Smoke test of the WeakMap cache; two consecutive parses on the same
		// descriptor succeed (cache exercised — not measured).
		const schema = { type: "object", properties: { x: { type: "number" } } };
		const descriptor = makeDescriptor(schema);
		expect(validate(descriptor, { x: 1 }).ok).toBe(true);
		expect(validate(descriptor, { x: 2 }).ok).toBe(true);
	});
});
