import { describe, expect, it } from "vitest";
import { isMember, tenantSet, validateTenant } from "./tenant.js";
import type { UserContext } from "./user-context.js";

function user(overrides: Partial<UserContext> = {}): UserContext {
	return {
		name: "alice",
		mail: "alice@example.test",
		orgs: [],
		...overrides,
	};
}

describe("validateTenant", () => {
	it.each([
		"acme",
		"stefan-hoelzl",
		"team_42",
		"a",
		"A1",
		`a${"b".repeat(62)}`,
	])("accepts %s", (s) => {
		expect(validateTenant(s)).toBe(true);
	});

	it.each([
		"",
		"..",
		"foo/bar",
		"-leading",
		"_leading",
		"name:with:colon",
		"has space",
		"has.dot",
		"a".repeat(64),
	])("rejects %s", (s) => {
		expect(validateTenant(s)).toBe(false);
	});
});

describe("tenantSet", () => {
	it("returns orgs and user name when valid", () => {
		const set = tenantSet(user({ name: "alice", orgs: ["acme", "contoso"] }));
		expect(set).toEqual(new Set(["acme", "contoso", "alice"]));
	});

	it("filters out regex-invalid entries silently", () => {
		const set = tenantSet(
			user({ name: "alice", orgs: ["acme", "bad:group", "..", "contoso"] }),
		);
		expect(set).toEqual(new Set(["acme", "contoso", "alice"]));
	});

	it("excludes user name when it fails regex", () => {
		const set = tenantSet(user({ name: "bad:name", orgs: ["acme"] }));
		expect(set).toEqual(new Set(["acme"]));
	});

	it("returns empty set when nothing is valid", () => {
		const set = tenantSet(user({ name: "bad:name", orgs: [".."] }));
		expect(set.size).toBe(0);
	});
});

describe("isMember", () => {
	it("returns true when tenant is in user's orgs", () => {
		expect(isMember(user({ orgs: ["acme", "contoso"] }), "acme")).toBe(true);
	});

	it("returns true when tenant equals user's login (pseudo-tenant)", () => {
		expect(isMember(user({ name: "alice" }), "alice")).toBe(true);
	});

	it("returns false when user is neither in orgs nor equals tenant", () => {
		expect(isMember(user({ orgs: ["acme"] }), "contoso")).toBe(false);
	});

	it("returns false for regex-invalid tenant even if it happens to be in orgs", () => {
		expect(isMember(user({ orgs: ["bad:group"] }), "bad:group")).toBe(false);
	});
});
