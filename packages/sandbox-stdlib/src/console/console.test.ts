import { withStagedGlobals } from "@workflow-engine/sandbox";
import { describe, expect, it } from "vitest";
import {
	CONSOLE_METHODS,
	name as CONSOLE_PLUGIN_NAME,
	guest,
	worker,
} from "./index.js";

describe("console plugin (§10 shape)", () => {
	it("has the expected plugin name", () => {
		expect(CONSOLE_PLUGIN_NAME).toBe("console");
	});

	it("covers exactly log/info/warn/error/debug (matching legacy globals.ts)", () => {
		expect([...CONSOLE_METHODS].sort()).toEqual(
			["log", "info", "warn", "error", "debug"].sort(),
		);
	});

	it("registers one private descriptor per method, each emitting console.<method> as a leaf event", () => {
		const setup = worker();
		expect(setup.guestFunctions).toHaveLength(CONSOLE_METHODS.length);
		for (const method of CONSOLE_METHODS) {
			const gf = setup.guestFunctions?.find(
				(g: { name: string }) => g.name === `__console_${method}`,
			);
			expect(gf).toBeDefined();
			expect(gf?.public).toBe(false);
			expect(gf?.log).toEqual({ event: `console.${method}` });
			expect(gf?.args).toHaveLength(1);
			expect(gf?.args[0]?.kind).toBe("raw");
			expect(gf?.handler()).toBeUndefined();
		}
	});

	it("exports a guest() function", () => {
		expect(typeof guest).toBe("function");
	});

	it("guest() installs globalThis.console forwarding each method to the matching staged __console_<method> bridge", () => {
		const received: { method: string; args: unknown[] }[] = [];
		const stage: Record<string, unknown> = {};
		for (const method of CONSOLE_METHODS) {
			stage[`__console_${method}`] = (args: unknown[]) => {
				received.push({ method, args });
			};
		}
		withStagedGlobals(stage, () => {
			guest();
			const con = (
				globalThis as unknown as {
					console?: Record<string, unknown>;
				}
			).console;
			expect(con).toBeDefined();
			for (const method of CONSOLE_METHODS) {
				expect(typeof con?.[method]).toBe("function");
				(con?.[method] as (...a: unknown[]) => void)("payload-for", method);
			}
		});
		expect(received.map((r) => r.method).sort()).toEqual(
			[...CONSOLE_METHODS].sort(),
		);
		for (const entry of received) {
			expect(entry.args).toEqual(["payload-for", entry.method]);
		}
	});
});
