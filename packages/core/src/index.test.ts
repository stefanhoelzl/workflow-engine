import { describe, expect, it } from "vitest";
import { iifeName } from "./index.js";

describe("iifeName", () => {
	it("leaves simple names as-is with __wf_ prefix", () => {
		expect(iifeName("cronitor")).toBe("__wf_cronitor");
		expect(iifeName("demo")).toBe("__wf_demo");
	});

	it("converts kebab-case to camelCase", () => {
		expect(iifeName("my-workflow")).toBe("__wf_myWorkflow");
		expect(iifeName("a-b-c")).toBe("__wf_aBC");
	});

	it("converts snake_case to camelCase", () => {
		expect(iifeName("my_workflow")).toBe("__wf_myWorkflow");
		expect(iifeName("a_b_c")).toBe("__wf_aBC");
	});

	it("handles mixed separators", () => {
		expect(iifeName("my-mixed_name")).toBe("__wf_myMixedName");
	});

	it("handles adjacent separators", () => {
		expect(iifeName("a--b")).toBe("__wf_aB");
		expect(iifeName("a__b")).toBe("__wf_aB");
	});

	it("does not create a collision when workflow name equals 'wf'", () => {
		// Edge case: the literal `wf` must still be prefixed, producing `__wf_wf`
		// — not `__wf_` (which would collide with the prefix itself).
		expect(iifeName("wf")).toBe("__wf_wf");
	});

	it("kebab and snake forms of the same name collapse to the same IIFE", () => {
		// Intentional: the producer (vite-plugin, derives from filestem) and
		// consumer (runtime, derives from manifest.name) must agree. Both run
		// through iifeName, so any separator style converges.
		expect(iifeName("my-cronitor")).toBe(iifeName("my_cronitor"));
		expect(iifeName("my-cronitor")).toBe("__wf_myCronitor");
	});

	it("an already-camelCased name passes through unchanged (after prefix)", () => {
		// No separators → no transformation of the body.
		expect(iifeName("myCronitor")).toBe("__wf_myCronitor");
	});

	it("is idempotent on already-transformed output (within the __wf_ prefix)", () => {
		// Running iifeName on its own output should not further mangle the
		// camelCased portion (no separators to process).
		const once = iifeName("my-workflow");
		expect(once).toBe("__wf_myWorkflow");
	});
});
