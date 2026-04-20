import { describe, expect, it } from "vitest";
import { allow, parseAuth, parseAuthAllow } from "./allowlist.js";
import type { UserContext } from "./user-context.js";

const user = (name: string, orgs: string[] = []): UserContext => ({
	name,
	mail: "",
	orgs,
});

describe("parseAuthAllow (grammar)", () => {
	it("parses a single user entry", () => {
		const { users, orgs } = parseAuthAllow("github:user:alice");
		expect(users).toEqual(new Set(["alice"]));
		expect(orgs).toEqual(new Set());
	});

	it("parses a single org entry", () => {
		const { users, orgs } = parseAuthAllow("github:org:acme");
		expect(orgs).toEqual(new Set(["acme"]));
		expect(users).toEqual(new Set());
	});

	it("parses mixed entries", () => {
		const { users, orgs } = parseAuthAllow(
			"github:user:alice;github:org:acme;github:user:bob",
		);
		expect(users).toEqual(new Set(["alice", "bob"]));
		expect(orgs).toEqual(new Set(["acme"]));
	});

	it("trims whitespace around entries", () => {
		const { users, orgs } = parseAuthAllow(
			"  github:user:alice  ;github:org:acme",
		);
		expect(users).toEqual(new Set(["alice"]));
		expect(orgs).toEqual(new Set(["acme"]));
	});

	it("skips empty segments", () => {
		const { users } = parseAuthAllow(";;github:user:alice;;");
		expect(users).toEqual(new Set(["alice"]));
	});

	it("rejects unknown provider", () => {
		expect(() => parseAuthAllow("google:user:alice")).toThrow(
			/unknown provider/,
		);
	});

	it("rejects unknown kind", () => {
		expect(() => parseAuthAllow("github:team:acme")).toThrow(/unknown kind/);
	});

	it("rejects invalid identifier (spaces)", () => {
		expect(() => parseAuthAllow("github:user:has space")).toThrow(
			/invalid identifier/,
		);
	});

	it("rejects invalid identifier (starts with dash)", () => {
		expect(() => parseAuthAllow("github:user:-leading")).toThrow(
			/invalid identifier/,
		);
	});

	it("rejects malformed entry (missing segment)", () => {
		expect(() => parseAuthAllow("github:user")).toThrow(/malformed entry/);
	});

	it("rejects malformed entry (too many segments)", () => {
		expect(() => parseAuthAllow("github:user:alice:extra")).toThrow(
			/malformed entry/,
		);
	});
});

describe("parseAuth (mode resolution)", () => {
	it("resolves unset to disabled", () => {
		expect(parseAuth(undefined)).toEqual({ mode: "disabled" });
	});

	it("resolves empty string to disabled", () => {
		expect(parseAuth("")).toEqual({ mode: "disabled" });
	});

	it("resolves sentinel to open", () => {
		expect(parseAuth("__DISABLE_AUTH__")).toEqual({ mode: "open" });
	});

	it("resolves parseable value to restricted", () => {
		const auth = parseAuth("github:user:alice");
		expect(auth.mode).toBe("restricted");
		if (auth.mode === "restricted") {
			expect(auth.users).toEqual(new Set(["alice"]));
		}
	});

	it("rejects sentinel mixed with entries", () => {
		expect(() => parseAuth("github:user:alice;__DISABLE_AUTH__")).toThrow(
			/must be the only value/,
		);
	});
});

describe("allow (predicate)", () => {
	it("grants on login match", () => {
		expect(
			allow(user("alice"), {
				mode: "restricted",
				users: new Set(["alice"]),
				orgs: new Set(),
			}),
		).toBe(true);
	});

	it("grants on org match", () => {
		expect(
			allow(user("bob", ["acme"]), {
				mode: "restricted",
				users: new Set(),
				orgs: new Set(["acme"]),
			}),
		).toBe(true);
	});

	it("denies when neither login nor any org match", () => {
		expect(
			allow(user("eve", ["elsewhere"]), {
				mode: "restricted",
				users: new Set(["alice"]),
				orgs: new Set(["acme"]),
			}),
		).toBe(false);
	});

	it("denies when user is undefined in restricted mode", () => {
		expect(
			allow(undefined, {
				mode: "restricted",
				users: new Set(["alice"]),
				orgs: new Set(),
			}),
		).toBe(false);
	});

	it("grants everyone in open mode", () => {
		expect(allow(user("anyone"), { mode: "open" })).toBe(true);
	});

	it("grants even when user is undefined in open mode", () => {
		expect(allow(undefined, { mode: "open" })).toBe(true);
	});

	it("denies everyone in disabled mode", () => {
		expect(allow(user("alice", ["acme"]), { mode: "disabled" })).toBe(false);
	});

	it("login match is case-sensitive", () => {
		expect(
			allow(user("Alice"), {
				mode: "restricted",
				users: new Set(["alice"]),
				orgs: new Set(),
			}),
		).toBe(false);
	});
});
