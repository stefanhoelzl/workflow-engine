import { describe, expect, it } from "vitest";
import type { WorkflowRegistry } from "../workflow-registry.js";
import { resolveQueryScopes } from "./scopes.js";
import type { UserContext } from "./user-context.js";

function user(orgs: string[]): UserContext {
	return {
		login: "alice",
		mail: "alice@example.com",
		orgs: ["alice", ...orgs],
	};
}

function registry(
	pairs: Array<{ owner: string; repo: string }>,
): WorkflowRegistry {
	return {
		size: pairs.length,
		owners: () => Array.from(new Set(pairs.map((p) => p.owner))),
		repos: (owner: string) =>
			pairs.filter((p) => p.owner === owner).map((p) => p.repo),
		pairs: () => pairs,
		list: () => [],
		registerOwner: async () => ({ ok: false, error: "unused" }),
		recover: async () => undefined,
		getEntry: () => undefined,
		dispose: () => undefined,
	};
}

describe("resolveQueryScopes", () => {
	it("returns only pairs where user ∈ owner's orgs AND bundle is registered", () => {
		const r = registry([
			{ owner: "acme", repo: "foo" },
			{ owner: "acme", repo: "bar" },
			{ owner: "contoso", repo: "baz" },
			{ owner: "ghost", repo: "nope" },
		]);
		const u = user(["acme", "contoso"]);
		expect(resolveQueryScopes(u, r)).toEqual([
			{ owner: "acme", repo: "foo" },
			{ owner: "acme", repo: "bar" },
			{ owner: "contoso", repo: "baz" },
		]);
	});

	it("omits pairs for owners the user doesn't belong to", () => {
		const r = registry([
			{ owner: "acme", repo: "foo" },
			{ owner: "other", repo: "bar" },
		]);
		const u = user([]);
		expect(resolveQueryScopes(u, r)).toEqual([]);
	});

	it("narrows by owner constraint", () => {
		const r = registry([
			{ owner: "acme", repo: "foo" },
			{ owner: "acme", repo: "bar" },
			{ owner: "contoso", repo: "baz" },
		]);
		const u = user(["acme", "contoso"]);
		expect(resolveQueryScopes(u, r, { owner: "acme" })).toEqual([
			{ owner: "acme", repo: "foo" },
			{ owner: "acme", repo: "bar" },
		]);
	});

	it("narrows by (owner, repo) constraint", () => {
		const r = registry([
			{ owner: "acme", repo: "foo" },
			{ owner: "acme", repo: "bar" },
		]);
		const u = user(["acme"]);
		expect(resolveQueryScopes(u, r, { owner: "acme", repo: "foo" })).toEqual([
			{ owner: "acme", repo: "foo" },
		]);
	});

	it("returns empty when constraint names an owner the user doesn't belong to", () => {
		const r = registry([{ owner: "acme", repo: "foo" }]);
		const u = user([]);
		expect(resolveQueryScopes(u, r, { owner: "acme" })).toEqual([]);
	});

	it("rejects malformed owner / repo constraints", () => {
		const r = registry([{ owner: "acme", repo: "foo" }]);
		const u = user(["acme"]);
		expect(resolveQueryScopes(u, r, { owner: "bad/name" })).toEqual([]);
		expect(
			resolveQueryScopes(u, r, { owner: "acme", repo: "bad name" }),
		).toEqual([]);
	});

	it("open-mode fallback: unauthenticated caller gets every registered owner", () => {
		const r = registry([
			{ owner: "acme", repo: "foo" },
			{ owner: "contoso", repo: "bar" },
		]);
		expect(resolveQueryScopes(undefined, r)).toEqual([
			{ owner: "acme", repo: "foo" },
			{ owner: "contoso", repo: "bar" },
		]);
	});
});
