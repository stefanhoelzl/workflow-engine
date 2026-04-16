import { describe, expect, it } from "vitest";
import { IIFE_NAMESPACE } from "./index.js";

describe("IIFE_NAMESPACE", () => {
	it("is the shared constant used by plugin, runtime, and sandbox", () => {
		expect(IIFE_NAMESPACE).toBe("__wfe_exports__");
	});
});
