import { describe, expect, it } from "vitest";
import { isMember, ownerSet, validateOwner } from "./owner.js";
import type { UserContext } from "./user-context.js";

function user(overrides: Partial<UserContext> = {}): UserContext {
	return {
		login: "alice",
		mail: "alice@example.test",
		orgs: ["alice"],
		...overrides,
	};
}

describe("validateOwner", () => {
	it.each([
		"acme",
		"stefan-hoelzl",
		"team_42",
		"a",
		"A1",
		`a${"b".repeat(62)}`,
	])("accepts %s", (s) => {
		expect(validateOwner(s)).toBe(true);
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
		expect(validateOwner(s)).toBe(false);
	});
});

describe("ownerSet", () => {
	it("returns every valid entry in user.orgs", () => {
		const set = ownerSet(
			user({ login: "alice", orgs: ["alice", "acme", "contoso"] }),
		);
		expect(set).toEqual(new Set(["alice", "acme", "contoso"]));
	});

	it("filters out regex-invalid entries silently", () => {
		const set = ownerSet(
			user({
				login: "alice",
				orgs: ["alice", "acme", "bad:group", "..", "contoso"],
			}),
		);
		expect(set).toEqual(new Set(["alice", "acme", "contoso"]));
	});

	it("returns empty set when nothing is valid", () => {
		const set = ownerSet(user({ orgs: ["bad:name", ".."] }));
		expect(set.size).toBe(0);
	});
});

describe("isMember", () => {
	it("returns true when owner is in user's orgs", () => {
		expect(isMember(user({ orgs: ["alice", "acme", "contoso"] }), "acme")).toBe(
			true,
		);
	});

	it("returns true when owner equals user's login because login is also in orgs", () => {
		expect(isMember(user({ login: "alice", orgs: ["alice"] }), "alice")).toBe(
			true,
		);
	});

	it("returns false when user is neither in orgs nor equals owner", () => {
		expect(isMember(user({ orgs: ["alice", "acme"] }), "contoso")).toBe(false);
	});

	it("returns false for regex-invalid owner even if it happens to be in orgs", () => {
		expect(isMember(user({ orgs: ["alice", "bad:group"] }), "bad:group")).toBe(
			false,
		);
	});
});
