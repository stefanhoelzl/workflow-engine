import { describe, expect, it } from "vitest";
import { prepareSchema } from "./page.js";

describe("prepareSchema", () => {
	it("promotes example to default when no default exists", () => {
		const schema = {
			type: "object",
			properties: {
				orderId: { type: "string", example: "ORD-12345" },
				amount: { type: "number", example: 42.99 },
			},
		};
		const result = prepareSchema(schema) as Record<string, unknown>;
		const props = result.properties as Record<string, Record<string, unknown>>;
		expect(props.orderId?.default).toBe("ORD-12345");
		expect(props.amount?.default).toBe(42.99);
	});

	it("preserves existing default when both default and example exist", () => {
		const schema = {
			type: "string",
			example: "ORD-12345",
			default: "REAL-DEFAULT",
		};
		const result = prepareSchema(schema) as Record<string, unknown>;
		expect(result.default).toBe("REAL-DEFAULT");
	});

	it("does not add default when no example exists", () => {
		const schema = {
			type: "string",
		};
		const result = prepareSchema(schema) as Record<string, unknown>;
		expect(result.default).toBeUndefined();
	});

	it("recurses into nested object properties", () => {
		const schema = {
			type: "object",
			properties: {
				address: {
					type: "object",
					properties: {
						city: { type: "string", example: "Berlin" },
						zip: { type: "string", example: "10115" },
					},
				},
			},
		};
		const result = prepareSchema(schema) as Record<string, unknown>;
		const address = (
			result.properties as Record<string, Record<string, unknown>>
		).address;
		const nested = address?.properties as Record<
			string,
			Record<string, unknown>
		>;
		expect(nested.city?.default).toBe("Berlin");
		expect(nested.zip?.default).toBe("10115");
	});

	it("adds titles to anyOf variants and puts null first", () => {
		const schema = {
			type: "object",
			properties: {
				name: {
					anyOf: [{ type: "string" }, { type: "null" }],
				},
			},
		};
		const result = prepareSchema(schema) as Record<string, unknown>;
		const props = result.properties as Record<string, Record<string, unknown>>;
		const name = props.name as Record<string, unknown>;
		expect(name.anyOf).toEqual([
			{ type: "null", title: "null" },
			{ type: "string", title: "string" },
		]);
	});

	it("promotes example inside anyOf variant", () => {
		const schema = {
			type: "object",
			properties: {
				name: {
					anyOf: [{ type: "string", example: "Alice" }, { type: "null" }],
				},
			},
		};
		const result = prepareSchema(schema) as Record<string, unknown>;
		const props = result.properties as Record<string, Record<string, unknown>>;
		const name = props.name as Record<string, unknown>;
		const anyOf = name.anyOf as Record<string, unknown>[];
		expect(anyOf[1]?.example).toBe("Alice");
		expect(anyOf[1]?.default).toBe("Alice");
	});
});
