import { encodeSentinel } from "@workflow-engine/core";
import { describe, expect, it } from "vitest";
import { resolveSecretSentinels } from "./resolve-secret-sentinels.js";

describe("resolveSecretSentinels", () => {
	it("substitutes a whole-value sentinel", () => {
		const missing = new Set<string>();
		const out = resolveSecretSentinels(
			encodeSentinel("S"),
			{ S: "*/5 * * * *" },
			missing,
		);
		expect(out).toBe("*/5 * * * *");
		expect(missing.size).toBe(0);
	});

	it("substitutes an embedded substring sentinel", () => {
		const missing = new Set<string>();
		const out = resolveSecretSentinels(
			`Bearer ${encodeSentinel("T")} rest`,
			{ T: "abc123" },
			missing,
		);
		expect(out).toBe("Bearer abc123 rest");
	});

	it("substitutes multiple sentinels in one string", () => {
		const missing = new Set<string>();
		const out = resolveSecretSentinels(
			`imaps://${encodeSentinel("U")}:${encodeSentinel("P")}@host:993`,
			{ U: "me", P: "secret" },
			missing,
		);
		expect(out).toBe("imaps://me:secret@host:993");
	});

	it("accumulates unknown sentinel names and leaves sentinels in place", () => {
		const missing = new Set<string>();
		const out = resolveSecretSentinels(
			`pre-${encodeSentinel("UNKNOWN_A")}-${encodeSentinel("UNKNOWN_B")}`,
			{},
			missing,
		);
		expect(out).toBe(
			`pre-${encodeSentinel("UNKNOWN_A")}-${encodeSentinel("UNKNOWN_B")}`,
		);
		expect([...missing].sort()).toEqual(["UNKNOWN_A", "UNKNOWN_B"]);
	});

	it("mixes resolved and missing sentinels in one string", () => {
		const missing = new Set<string>();
		const out = resolveSecretSentinels(
			`${encodeSentinel("KNOWN")}-${encodeSentinel("MISSING")}`,
			{ KNOWN: "ok" },
			missing,
		);
		expect(out).toBe(`ok-${encodeSentinel("MISSING")}`);
		expect([...missing]).toEqual(["MISSING"]);
	});

	it("recurses into objects", () => {
		const missing = new Set<string>();
		const out = resolveSecretSentinels(
			{
				schedule: encodeSentinel("S"),
				tz: "UTC",
				nested: { token: `Bearer ${encodeSentinel("T")}` },
			},
			{ S: "* * * * *", T: "abc" },
			missing,
		);
		expect(out).toEqual({
			schedule: "* * * * *",
			tz: "UTC",
			nested: { token: "Bearer abc" },
		});
	});

	it("recurses into arrays", () => {
		const missing = new Set<string>();
		const out = resolveSecretSentinels(
			[encodeSentinel("A"), "plain", [encodeSentinel("B")]],
			{ A: "x", B: "y" },
			missing,
		);
		expect(out).toEqual(["x", "plain", ["y"]]);
	});

	it("leaves non-string scalars unchanged", () => {
		const missing = new Set<string>();
		const input = {
			num: 42,
			bool: true,
			nul: null,
			undef: undefined,
			str: "plain",
		};
		const out = resolveSecretSentinels(input, {}, missing);
		expect(out).toEqual(input);
		expect(missing.size).toBe(0);
	});

	it("returns a string without sentinels byte-identical", () => {
		const missing = new Set<string>();
		const input = "just a plain string with no nul bytes";
		const out = resolveSecretSentinels(input, { IRRELEVANT: "x" }, missing);
		expect(out).toBe(input);
	});

	it("returns an object with no sentinels structurally equal", () => {
		const missing = new Set<string>();
		const input = {
			schedule: "*/5 * * * *",
			tz: "UTC",
			nested: { a: [1, "two", { b: "c" }] },
		};
		const out = resolveSecretSentinels(input, {}, missing);
		expect(out).toEqual(input);
		expect(missing.size).toBe(0);
	});

	it("does not treat a sentinel-shaped substring without NUL terminators as a sentinel", () => {
		const missing = new Set<string>();
		const out = resolveSecretSentinels("secret:NOT_A_SENTINEL", {}, missing);
		expect(out).toBe("secret:NOT_A_SENTINEL");
		expect(missing.size).toBe(0);
	});
});
