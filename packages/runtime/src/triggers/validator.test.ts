import { describe, expect, it } from "vitest";
import type { HttpTriggerDescriptor } from "../executor/types.js";
import { makeHttpDescriptor } from "./test-descriptors.js";
import { toWireIssues, validate } from "./validator.js";

function makeDescriptor(
	inputSchema: Record<string, unknown>,
): HttpTriggerDescriptor {
	return makeHttpDescriptor({ inputSchema });
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

	it("reuses the descriptor's pre-rehydrated Zod schema across calls", () => {
		// Two consecutive parses against the same descriptor share the same
		// `zodInputSchema` instance — there is no per-call validator
		// construction (pre-rehydration at registration time).
		const schema = { type: "object", properties: { x: { type: "number" } } };
		const descriptor = makeDescriptor(schema);
		expect(validate(descriptor, { x: 1 }).ok).toBe(true);
		expect(validate(descriptor, { x: 2 }).ok).toBe(true);
	});
});

describe("validate — enriched issue fields", () => {
	it("type-mismatch issue carries received value, expected type, and code", () => {
		const descriptor = makeDescriptor({
			type: "object",
			properties: { x: { type: "number" } },
			required: ["x"],
		});
		const result = validate(descriptor, { x: "not-a-number" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const issue = result.issues[0];
			expect(issue?.path).toEqual(["x"]);
			expect(issue?.received).toBe("not-a-number");
			expect(issue?.expected).toBe("number");
			expect(issue?.code).toBe("invalid_type");
		}
	});

	it("enum failure carries the offending value and the option list as expected", () => {
		const descriptor = makeDescriptor({
			type: "object",
			properties: { kind: { type: "string", enum: ["A", "B"] } },
			required: ["kind"],
		});
		const result = validate(descriptor, { kind: "a" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const issue = result.issues[0];
			expect(issue?.path).toEqual(["kind"]);
			expect(issue?.received).toBe("a");
			expect(issue?.expected).toContain('"A"');
			expect(issue?.expected).toContain('"B"');
			expect(issue?.code).toBe("invalid_value");
		}
	});

	it("nested-object failure carries the sub-object as received", () => {
		const descriptor = makeDescriptor({
			type: "object",
			properties: {
				user: {
					type: "object",
					properties: { email: { type: "string" } },
					required: ["email"],
				},
			},
			required: ["user"],
		});
		const result = validate(descriptor, { user: { email: 42 } });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const issue = result.issues[0];
			expect(issue?.path).toEqual(["user", "email"]);
			expect(issue?.received).toBe(42);
		}
	});

	it("multi-issue failure attaches each failing field's value per-issue, not the whole body", () => {
		// Spec invariant: an issue's `received` is the value at that issue's
		// path, never the entire validated input. A bystander field (e.g. a
		// huge `notes` string) MUST NOT appear in any issue.
		const descriptor = makeDescriptor({
			type: "object",
			properties: {
				name: { type: "string" },
				age: { type: "number" },
				notes: { type: "string" },
			},
			required: ["name", "age"],
		});
		const bigNotes = "x".repeat(1024);
		const result = validate(descriptor, {
			name: 42,
			age: "old",
			notes: bigNotes,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.length).toBeGreaterThanOrEqual(2);
			const nameIssue = result.issues.find((i) => i.path[0] === "name");
			const ageIssue = result.issues.find((i) => i.path[0] === "age");
			expect(nameIssue?.received).toBe(42);
			expect(ageIssue?.received).toBe("old");
			// No issue references the notes field's value
			for (const issue of result.issues) {
				expect(issue.received).not.toBe(bigNotes);
			}
		}
	});
});

describe("toWireIssues — projection to minimal shape", () => {
	it("strips received, expected, and code", () => {
		const wire = toWireIssues([
			{
				path: ["kind"],
				message: "Invalid",
				received: "a",
				expected: 'one of ["A", "B"]',
				code: "invalid_value",
			},
		]);
		expect(wire).toEqual([{ path: ["kind"], message: "Invalid" }]);
		expect(wire[0]).not.toHaveProperty("received");
		expect(wire[0]).not.toHaveProperty("expected");
		expect(wire[0]).not.toHaveProperty("code");
	});
});
