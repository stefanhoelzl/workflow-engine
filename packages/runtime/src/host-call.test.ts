import { z } from "@workflow-engine/core";
import { describe, expect, it } from "vitest";
import { defineHostMethod } from "./host-call.js";

describe("defineHostMethod", () => {
	it("validates args before the handler runs and returns the result", async () => {
		let handlerCalls = 0;
		const handlers = defineHostMethod(
			"test.echo",
			{ args: z.tuple([z.string()]), result: z.string() },
			async ([s]) => {
				handlerCalls++;
				return s.toUpperCase();
			},
		);
		const handler = handlers["test.echo"];
		expect(handler).toBeDefined();

		await expect(handler?.(["hi"])).resolves.toBe("HI");
		expect(handlerCalls).toBe(1);
	});

	it("rejects on invalid args without invoking the handler", async () => {
		let handlerCalls = 0;
		const handlers = defineHostMethod(
			"test.echo",
			{ args: z.tuple([z.string()]), result: z.string() },
			async ([s]) => {
				handlerCalls++;
				return s;
			},
		);
		// A numeric first arg violates the contract.
		await expect(handlers["test.echo"]?.([42])).rejects.toMatchObject({
			name: "ZodError",
		});
		expect(handlerCalls).toBe(0);
	});

	it("applies result-schema coercion before crossing back", async () => {
		// A transform stands in for the kind of coercion a real consumer needs
		// (e.g. DuckDB BigInt → string): the handler returns a non-JSON value,
		// the result schema normalizes it.
		const handlers = defineHostMethod(
			"test.count",
			{ args: z.tuple([]), result: z.bigint().transform((b) => b.toString()) },
			async () => 123n,
		);
		await expect(handlers["test.count"]?.([])).resolves.toBe("123");
	});
});
