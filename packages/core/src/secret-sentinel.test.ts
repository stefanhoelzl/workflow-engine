import { describe, expect, it } from "vitest";
import { encodeSentinel, SENTINEL_SUBSTRING_RE } from "./index.js";

describe("encodeSentinel", () => {
	it("produces the exact \\x00secret:NAME\\x00 byte sequence", () => {
		const s = encodeSentinel("TOKEN");
		expect(s).toBe("\x00secret:TOKEN\x00");
		expect(s.length).toBe("secret:TOKEN".length + 2);
		expect(s.charCodeAt(0)).toBe(0);
		expect(s.charCodeAt(s.length - 1)).toBe(0);
	});

	it("accepts leading underscore", () => {
		expect(encodeSentinel("_X")).toBe("\x00secret:_X\x00");
	});

	it("accepts digits after the first char", () => {
		expect(encodeSentinel("X1")).toBe("\x00secret:X1\x00");
		expect(encodeSentinel("KEY_2")).toBe("\x00secret:KEY_2\x00");
	});

	it.each([
		["empty string", ""],
		["whitespace", "has space"],
		["dash", "has-dash"],
		["leading digit", "1ABC"],
		["dot", "a.b"],
		["colon", "a:b"],
		["nul byte", "\x00"],
	])("throws on invalid name (%s)", (_label, name) => {
		expect(() => encodeSentinel(name)).toThrow(/invalid secret name/);
	});
});

describe("SENTINEL_SUBSTRING_RE", () => {
	it("has the global flag set", () => {
		expect(SENTINEL_SUBSTRING_RE.flags).toContain("g");
	});

	it("matches a whole-value sentinel and captures the name", () => {
		const s = "\x00secret:TOKEN\x00";
		const matches = [...s.matchAll(SENTINEL_SUBSTRING_RE)];
		expect(matches).toHaveLength(1);
		expect(matches[0]?.[1]).toBe("TOKEN");
	});

	it("matches an embedded (substring) sentinel", () => {
		const s = "Bearer \x00secret:TOKEN\x00 rest";
		const replaced = s.replace(SENTINEL_SUBSTRING_RE, (_, n) => `<${n}>`);
		expect(replaced).toBe("Bearer <TOKEN> rest");
	});

	it("matches multiple sentinels in one string", () => {
		const s = "\x00secret:A\x00-\x00secret:B\x00";
		const replaced = s.replace(SENTINEL_SUBSTRING_RE, (_, n) =>
			n.toLowerCase(),
		);
		expect(replaced).toBe("a-b");
	});

	it("does not match a sentinel-shaped string without NUL terminators", () => {
		const s = "secret:TOKEN";
		expect([...s.matchAll(SENTINEL_SUBSTRING_RE)]).toHaveLength(0);
	});

	it("does not match a sentinel with an invalid name", () => {
		const s = "\x00secret:1BAD\x00";
		expect([...s.matchAll(SENTINEL_SUBSTRING_RE)]).toHaveLength(0);
	});

	it("round-trips with encodeSentinel", () => {
		const names = ["A", "TOKEN", "_X", "LONG_SECRET_NAME_123"];
		for (const name of names) {
			const encoded = encodeSentinel(name);
			const matches = [...encoded.matchAll(SENTINEL_SUBSTRING_RE)];
			expect(matches).toHaveLength(1);
			expect(matches[0]?.[1]).toBe(name);
		}
	});
});
