import type { Hono } from "hono";
import { html } from "hono/html";
import { describe, expect, it } from "vitest";
import { buildRegistry } from "./registry.js";
import type { AuthProvider, AuthProviderFactory } from "./types.js";

const stubFactory = (id: string): AuthProviderFactory => ({
	id,
	create: (raw) => {
		const seen: string[] = [...raw];
		return {
			id,
			renderLoginSection: () => html`<x-${id}>${seen.join(",")}</x-${id}>`,
			mountAuthRoutes: (_app: Hono) => {},
			resolveApiIdentity: () => Promise.resolve(undefined),
			refreshSession: () => Promise.resolve(undefined),
		} satisfies AuthProvider;
	},
});

const DEPS = {
	secureCookies: false,
	nowFn: () => 0,
};

describe("buildRegistry", () => {
	it("returns an empty registry for empty AUTH_ALLOW", () => {
		const reg = buildRegistry("", [stubFactory("github")], DEPS);
		expect(reg.providers).toEqual([]);
		expect(reg.byId("github")).toBeUndefined();
	});

	it("returns an empty registry for undefined AUTH_ALLOW", () => {
		const reg = buildRegistry(undefined, [stubFactory("github")], DEPS);
		expect(reg.providers).toEqual([]);
	});

	it("registers a single provider for matching entries", () => {
		const reg = buildRegistry(
			"github:user:alice",
			[stubFactory("github")],
			DEPS,
		);
		expect(reg.providers.length).toBe(1);
		expect(reg.byId("github")?.id).toBe("github");
	});

	it("registers multiple providers when entries reference different ids", () => {
		const reg = buildRegistry(
			"github:user:alice,local:dev",
			[stubFactory("github"), stubFactory("local")],
			DEPS,
		);
		expect(reg.providers.length).toBe(2);
		expect(reg.byId("github")).toBeDefined();
		expect(reg.byId("local")).toBeDefined();
	});

	it("buckets multiple entries to the same provider with one create call", () => {
		let calls = 0;
		const factory: AuthProviderFactory = {
			id: "local",
			create: (raw) => {
				calls += 1;
				return {
					id: "local",
					renderLoginSection: () => html`${raw.join("|")}`,
					mountAuthRoutes: () => {},
					resolveApiIdentity: () => Promise.resolve(undefined),
					refreshSession: () => Promise.resolve(undefined),
				};
			},
		};
		const reg = buildRegistry(
			"local:dev,local:bob,local:alice",
			[factory],
			DEPS,
		);
		expect(calls).toBe(1);
		expect(String(reg.providers[0]?.renderLoginSection(""))).toBe(
			"dev|bob|alice",
		);
	});

	it("throws on unknown provider id", () => {
		expect(() =>
			buildRegistry("oidc:foo", [stubFactory("github")], DEPS),
		).toThrow(/unknown provider "oidc"/);
	});

	it("throws when local entry appears but no local factory is provided", () => {
		expect(() =>
			buildRegistry("local:dev", [stubFactory("github")], DEPS),
		).toThrow(/unknown provider "local"/);
	});

	it("trims whitespace and skips empty segments", () => {
		const reg = buildRegistry(
			"  github:user:alice  ,, ,github:user:bob ",
			[stubFactory("github")],
			DEPS,
		);
		expect(reg.providers.length).toBe(1);
	});

	it("preserves provider registration order matching first-appearance in AUTH_ALLOW", () => {
		const reg = buildRegistry(
			"local:dev,github:user:alice",
			[stubFactory("github"), stubFactory("local")],
			DEPS,
		);
		expect(reg.providers.map((p) => p.id)).toEqual(["local", "github"]);
	});
});
