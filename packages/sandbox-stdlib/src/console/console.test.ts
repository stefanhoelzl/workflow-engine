import { describe, expect, it } from "vitest";
import {
	CONSOLE_METHODS,
	name as CONSOLE_PLUGIN_NAME,
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

	it("returns a source string that installs globalThis.console without defineProperty (keeping the object writable per WebIDL)", () => {
		const setup = worker();
		expect(setup.source).toContain("globalThis.console = con");
		expect(setup.source).not.toContain("Object.defineProperty");
		expect(setup.source).not.toContain("Object.freeze");
	});

	it("source references every private descriptor by JSON-escaped name so non-identifier characters would not break capture", () => {
		const setup = worker();
		for (const method of CONSOLE_METHODS) {
			expect(setup.source).toContain(
				`globalThis[${JSON.stringify(`__console_${method}`)}]`,
			);
		}
	});
});
