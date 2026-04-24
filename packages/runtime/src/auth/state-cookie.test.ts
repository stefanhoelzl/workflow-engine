import { describe, expect, it } from "vitest";
import {
	isSafeReturnTo,
	sanitizeReturnTo,
	sealState,
	unsealState,
} from "./state-cookie.js";

describe("state-cookie", () => {
	it("seals and unseals a state+returnTo payload", async () => {
		const sealed = await sealState({ state: "abc", returnTo: "/dashboard" });
		const out = await unsealState(sealed);
		expect(out.state).toBe("abc");
		expect(out.returnTo).toBe("/dashboard");
	});

	it("rejects tampered cookie", async () => {
		const sealed = await sealState({ state: "x", returnTo: "/" });
		await expect(unsealState(`${sealed.slice(0, -2)}XX`)).rejects.toThrow();
	});
});

describe("isSafeReturnTo", () => {
	it.each([
		"/",
		"/dashboard",
		"/dashboard/invocations?owner=acme",
		"/trigger/#fragment",
	])("accepts %s", (v) => {
		expect(isSafeReturnTo(v)).toBe(true);
	});

	it.each([
		"",
		"https://evil.example/foo",
		"//evil.example/foo",
		"http://self/path",
		"/foo:bar",
		"dashboard",
		"\\evil",
	])("rejects %s", (v) => {
		expect(isSafeReturnTo(v)).toBe(false);
	});
});

describe("sanitizeReturnTo", () => {
	it("defaults to / when undefined", () => {
		expect(sanitizeReturnTo(undefined)).toBe("/");
	});

	it("defaults to / when unsafe", () => {
		expect(sanitizeReturnTo("//evil.example")).toBe("/");
	});

	it("passes through safe paths", () => {
		expect(sanitizeReturnTo("/dashboard")).toBe("/dashboard");
	});
});
